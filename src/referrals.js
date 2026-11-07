// Referrals from RHUs, barangay health centers and other hospitals to ZRMC.
// Shared by the facility portal (routes/facility.js) and the staff panel (routes/adminReferrals.js).
const config = require('./config');
const clinics = require('./clinics');
const { imageType } = require('./directory');
const u = require('./util');

const FACILITY_TYPES = { RHU: 'Rural Health Unit', BHS: 'Barangay Health Center / Station', HOSPITAL: 'Hospital', OTHER: 'Other facility' };
const URGENCY = { EMERGENCY: 'Emergency', URGENT: 'Urgent', ROUTINE: 'Routine' };
const STATUSES = {
  SENT: 'Sent',
  RECEIVED: 'Received by ZRMC',
  ACCEPTED: 'Accepted',
  REDIRECTED: 'Redirected',
  ARRIVED: 'Patient arrived',
  SEEN: 'Seen',
  CANCELLED: 'Cancelled',
};
// Receiving services besides the OPD clinics (which come from Admin → OPD Schedules)
const SERVICES = { ER: 'Emergency Room', ADMISSION: 'Admission / Ward', OTHER: 'Other (state in reason)' };

const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_TOTAL = 3 * 1024 * 1024; // keeps the request under the hosting upload limit

class ReferralError extends Error {}

async function departments(db) {
  const list = await clinics.listClinics(db);
  return [
    { code: 'ER', name: SERVICES.ER },
    { code: 'ADMISSION', name: SERVICES.ADMISSION },
    ...list.map((c) => ({ code: c.code, name: `OPD – ${c.name}` })),
    { code: 'OTHER', name: SERVICES.OTHER },
  ];
}

async function departmentName(db, code) {
  if (SERVICES[code]) return SERVICES[code];
  const c = await clinics.getClinic(db, code, { activeOnly: false });
  return c ? `OPD – ${c.name}` : code;
}

const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const caps = (v, max) => txt(v, max).toUpperCase();

// Validates a referral from the facility portal; returns the column values
async function cleanReferral(db, b) {
  const missing = [
    ['patient_last', 'Patient last name'],
    ['patient_first', 'Patient first name'],
    ['birthdate', 'Birthdate'],
    ['sex', 'Sex'],
    ['address', 'Address'],
    ['urgency', 'Urgency'],
    ['department', 'Receiving service'],
    ['reason', 'Reason for referral'],
    ['chief_complaint', 'Chief complaint'],
    ['working_diagnosis', 'Working / impression diagnosis'],
    ['referring_name', 'Referring health worker'],
  ].filter(([k]) => !txt(b[k], 2000));
  if (missing.length) throw new ReferralError(`Please fill in: ${missing.map(([, l]) => l).join(', ')}`);
  const birthdate = txt(b.birthdate, 10);
  if (!u.parseDate(birthdate) || birthdate > u.todayStr()) throw new ReferralError('Birthdate is not a valid date.');
  const sex = txt(b.sex, 1).toUpperCase();
  if (!['M', 'F'].includes(sex)) throw new ReferralError('Please select sex.');
  const urgency = txt(b.urgency, 20).toUpperCase();
  if (!URGENCY[urgency]) throw new ReferralError('Please choose the urgency.');
  const department = txt(b.department, 20);
  if (!SERVICES[department] && !(await clinics.getClinic(db, department))) throw new ReferralError('Please choose the receiving service.');
  let mobile = null;
  if (txt(b.mobile, 30)) {
    mobile = u.normalizeMobile(b.mobile);
    if (!mobile) throw new ReferralError("Patient's mobile number is not valid (e.g. 09171234567).");
  }
  return {
    urgency,
    department,
    patient_last: caps(b.patient_last, 80),
    patient_first: caps(b.patient_first, 80),
    patient_middle: caps(b.patient_middle, 80) || null,
    birthdate,
    sex,
    address: caps(b.address, 300),
    mobile,
    philhealth_no: caps(b.philhealth_no, 20) || null,
    reason: caps(b.reason, 1000),
    chief_complaint: caps(b.chief_complaint, 1000),
    history: caps(b.history, 3000) || null,
    working_diagnosis: caps(b.working_diagnosis, 1000),
    treatment_given: caps(b.treatment_given, 3000) || null,
    bp: caps(b.bp, 20) || null,
    hr: caps(b.hr, 20) || null,
    rr: caps(b.rr, 20) || null,
    temp: caps(b.temp, 20) || null,
    o2sat: caps(b.o2sat, 20) || null,
    weight: caps(b.weight, 20) || null,
    referring_name: caps(b.referring_name, 160),
    referring_designation: caps(b.referring_designation, 100) || null,
    referring_contact: txt(b.referring_contact, 60) || null,
  };
}

// Attachments arrive as [{ name, data: dataURL }]; images (JPG/PNG/WebP) or PDF
function decodeAttachments(list) {
  const files = Array.isArray(list) ? list : [];
  if (files.length > ATTACH_MAX_FILES) throw new ReferralError(`Attach at most ${ATTACH_MAX_FILES} files.`);
  let total = 0;
  return files.map((f) => {
    const m = /^data:[a-z]+\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(String(f?.data || ''));
    if (!m) throw new ReferralError('An attachment could not be read. Please attach it again.');
    const buf = Buffer.from(m[1], 'base64');
    const mime = imageType(buf) || (buf.toString('latin1', 0, 5) === '%PDF-' ? 'application/pdf' : null);
    if (!mime) throw new ReferralError('Attachments must be photos (JPG, PNG, WebP) or PDF files.');
    total += buf.length;
    if (total > ATTACH_MAX_TOTAL) throw new ReferralError('Attachments are too large (3 MB in total). Use fewer or smaller files.');
    const name = txt(f.name, 120).replace(/[^\w .()-]/g, '_') || `attachment${mime === 'application/pdf' ? '.pdf' : '.jpg'}`;
    return { name, mime, buf };
  });
}

function ageOn(birthdate, on = new Date()) {
  const b = u.parseDate(birthdate);
  if (!b) return '';
  let age = on.getFullYear() - b.getFullYear();
  if (on.getMonth() < b.getMonth() || (on.getMonth() === b.getMonth() && on.getDate() < b.getDate())) age--;
  return age;
}

// ---------- Export for Bizbox ----------
// Generic CSV (UTF-8 with BOM so Excel opens it correctly). Once the Bizbox vendor provides the
// import layout, adjust EXPORT_COLUMNS to match it (order, headers and formats).
const EXPORT_COLUMNS = [
  ['Referral No', (r) => r.ref_no],
  ['Date Referred', (r) => u.toStamp(r.created_at)],
  ['Referring Facility', (r) => r.facility_name],
  ['Facility Type', (r) => FACILITY_TYPES[r.facility_type] || r.facility_type],
  ['Facility Municipality', (r) => r.facility_municipality],
  ['Urgency', (r) => URGENCY[r.urgency] || r.urgency],
  ['Receiving Service', (r) => r.department_name],
  ['Last Name', (r) => r.patient_last],
  ['First Name', (r) => r.patient_first],
  ['Middle Name', (r) => r.patient_middle],
  ['Birthdate', (r) => r.birthdate],
  ['Age', (r) => ageOn(r.birthdate, new Date(r.created_at))],
  ['Sex', (r) => r.sex],
  ['Address', (r) => r.address],
  ['Mobile', (r) => r.mobile],
  ['PhilHealth No', (r) => r.philhealth_no],
  ['Chief Complaint', (r) => r.chief_complaint],
  ['Working Diagnosis', (r) => r.working_diagnosis],
  ['Reason for Referral', (r) => r.reason],
  ['History', (r) => r.history],
  ['Treatment Given', (r) => r.treatment_given],
  ['BP', (r) => r.bp],
  ['HR', (r) => r.hr],
  ['RR', (r) => r.rr],
  ['Temp', (r) => r.temp],
  ['O2 Sat', (r) => r.o2sat],
  ['Weight', (r) => r.weight],
  ['Referring Health Worker', (r) => r.referring_name],
  ['Designation', (r) => r.referring_designation],
  ['Referrer Contact', (r) => r.referring_contact],
  ['Status', (r) => STATUSES[r.status] || r.status],
  ['ZRMC Response', (r) => r.response_note],
  ['Appointment Date', (r) => r.appt_date],
  ['Appointment Time', (r) => (r.appt_time ? u.formatTime12(r.appt_time) : '')],
  ['Arrived At', (r) => u.toStamp(r.arrived_at)],
  ['Seen At', (r) => u.toStamp(r.seen_at)],
];

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Stop spreadsheet programs from treating text as a formula
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [EXPORT_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(([, f]) => csvCell(f(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------- SMS ----------
const H = () => config.hospitalName;
const sms = {
  toFacilityAccepted: (r) =>
    `${H()}: Referral ${r.ref_no} (${r.patient_first} ${r.patient_last}) ACCEPTED.${r.appt_date ? ` Schedule: ${u.formatDateLong(r.appt_date)} ${u.formatTime12(r.appt_time)}.` : ''}${r.response_note ? ` ${r.response_note}` : ''}`,
  toFacilityRedirected: (r) =>
    `${H()}: Referral ${r.ref_no} (${r.patient_first} ${r.patient_last}) could not be accepted. ${r.response_note || 'Please check the facility portal.'}`,
  toPatientAccepted: (r) =>
    r.appt_date
      ? `${H()}: Your referral was accepted. Please come on ${u.formatDateLong(r.appt_date)} ${u.formatTime12(r.appt_time)}, ${r.department_name}. Bring your referral slip. Ref ${r.ref_no}.`
      : `${H()}: Your referral to ${r.department_name} was accepted. ${r.response_note || 'Please bring your referral slip.'} Ref ${r.ref_no}.`,
};

// ---------- Loading referrals ----------
const SELECT = `SELECT r.*, f.name AS facility_name, f.type AS facility_type, f.municipality AS facility_municipality,
    f.phone AS facility_phone, a.appt_date, a.appt_time
  FROM referrals r JOIN facilities f ON f.id = r.facility_id LEFT JOIN appointments a ON a.id = r.appointment_id`;

// Adds display fields (names, local times, attachment list) to a referral row
async function present(db, r, { attachments = true } = {}) {
  const out = {
    ...r,
    department_name: await departmentName(db, r.department),
    status_label: STATUSES[r.status] || r.status,
    urgency_label: URGENCY[r.urgency] || r.urgency,
    facility_type_label: FACILITY_TYPES[r.facility_type] || r.facility_type,
    age: ageOn(r.birthdate, new Date(r.created_at)),
  };
  for (const k of ['created_at', 'updated_at', 'responded_at', 'arrived_at', 'seen_at', 'exported_at']) out[k] = u.toStamp(r[k]);
  if (attachments) {
    out.attachments = await db.query('SELECT id, filename, mime, length(data)::int AS size FROM referral_attachments WHERE referral_id = $1 ORDER BY id', [r.id]);
  }
  return out;
}

module.exports = {
  SELECT,
  present,
  FACILITY_TYPES,
  URGENCY,
  STATUSES,
  SERVICES,
  ReferralError,
  departments,
  departmentName,
  cleanReferral,
  decodeAttachments,
  ageOn,
  EXPORT_COLUMNS,
  toCsv,
  sms,
};
