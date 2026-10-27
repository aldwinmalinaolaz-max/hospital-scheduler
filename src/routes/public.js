const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const sched = require('../scheduling');
const msg = require('../messages');
const { sendSms } = require('../sms');
const { lock } = require('../db');
const u = require('../util');

class ValidationError extends Error {}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function required(body, fields) {
  const missing = fields.filter(([key]) => !str(body[key]));
  if (missing.length) throw new ValidationError(`Please fill in: ${missing.map(([, label]) => label).join(', ')}`);
}

function validPastDate(s, label) {
  if (!s) return null;
  if (!u.parseDate(s)) throw new ValidationError(`${label} is not a valid date.`);
  if (s > u.todayStr()) throw new ValidationError(`${label} cannot be in the future.`);
  return s;
}

function validMobile(v) {
  const m = u.normalizeMobile(v);
  if (!m) throw new ValidationError('Please enter a valid mobile number (e.g. 09171234567).');
  return m;
}

function validEmail(v) {
  const e = str(v, 120);
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError('Please enter a valid email address.');
  return e || null;
}

async function uniqueRef(db, table, prefix) {
  for (;;) {
    const ref = u.makeRef(prefix);
    if (!(await db.one(`SELECT 1 FROM ${table} WHERE ref_no = $1`, [ref]))) return ref;
  }
}

// Very small in-memory limiter for public form submissions (per server instance).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}

async function itemsFor(db, requestId) {
  const rows = await db.query('SELECT record_type, details, copies FROM record_request_items WHERE request_id = $1 ORDER BY id', [requestId]);
  return rows.map((i) => ({ ...i, name: catalog.recordType(i.record_type)?.name || i.record_type }));
}

async function publicRecord(db, r) {
  return {
    kind: 'record',
    ref_no: r.ref_no,
    patient: `${r.patient_first} ${r.patient_last}`,
    pickup_date: r.pickup_date,
    status: r.status,
    remarks: r.remarks,
    created_at: u.toStamp(r.created_at),
    items: await itemsFor(db, r.id),
  };
}

function publicAppointment(a) {
  return {
    kind: 'appointment',
    ref_no: a.ref_no,
    patient: `${a.patient_first} ${a.patient_last}`,
    department: catalog.department(a.department)?.name || a.department,
    appt_date: a.appt_date,
    appt_time: a.appt_time,
    appt_time_label: u.formatTime12(a.appt_time),
    status: a.status,
    remarks: a.remarks,
    created_at: u.toStamp(a.created_at),
  };
}

module.exports = function publicRoutes(db) {
  const router = express.Router();
  const submitLimit = rateLimit({ windowMs: 10 * 60e3, max: 20 });

  router.get('/catalog', (req, res) => {
    res.json({
      hospitalName: config.hospitalName,
      recordTypes: catalog.RECORD_TYPES,
      departments: catalog.DEPARTMENTS.map(({ code, name, days }) => ({ code, name, days })),
      today: u.todayStr(),
    });
  });

  // ---- Records ----

  router.get('/records/pickup-dates', async (req, res) => {
    const types = str(req.query.types, 500).split(',').filter((c) => catalog.recordType(c));
    res.json({ dates: await sched.pickupDates(db, types.length ? types : ['MEDICAL_CERTIFICATE']) });
  });

  router.post('/records', submitLimit, async (req, res) => {
    const b = req.body || {};
    required(b, [
      ['patient_last', 'Patient last name'],
      ['patient_first', 'Patient first name'],
      ['birthdate', 'Birthdate'],
      ['requester_name', 'Requester name'],
      ['requester_relation', 'Relationship to patient'],
      ['mobile', 'Mobile number'],
      ['purpose', 'Purpose'],
      ['pickup_date', 'Pickup date'],
    ]);
    if (b.consent !== true) throw new ValidationError('You must agree to the Data Privacy consent to continue.');

    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw new ValidationError('Please select at least one document to request.');
    if (items.length > catalog.RECORD_TYPES.length) throw new ValidationError('Too many documents selected.');
    const seen = new Set();
    const cleanItems = items.map((it) => {
      const type = catalog.recordType(it.record_type);
      if (!type) throw new ValidationError('Unknown document type.');
      if (seen.has(type.code)) throw new ValidationError(`${type.name} was selected twice.`);
      seen.add(type.code);
      const details = str(it.details, 300);
      if (type.requiresDetails && !details) throw new ValidationError('Please specify the document for "Others".');
      const copies = parseInt(it.copies, 10) || 1;
      if (copies < 1 || copies > 10) throw new ValidationError('Number of copies must be 1 to 10.');
      return { record_type: type.code, details: details || null, copies };
    });

    const birthdate = validPastDate(str(b.birthdate), 'Birthdate');
    const admission = validPastDate(str(b.admission_date), 'Admission/visit date');
    const discharge = validPastDate(str(b.discharge_date), 'Discharge date');
    if (admission && discharge && discharge < admission) throw new ValidationError('Discharge date cannot be before admission date.');
    const mobile = validMobile(b.mobile);
    const email = validEmail(b.email);
    const pickup = str(b.pickup_date);

    const record = await db.tx(async (t) => {
      await lock(t, `pickup:${pickup}`);
      const err = await sched.checkPickupDate(t, cleanItems.map((i) => i.record_type), pickup);
      if (err) throw new ValidationError(err);
      const ref = await uniqueRef(t, 'record_requests', 'R');
      const row = await t.one(
        `INSERT INTO record_requests (ref_no, patient_last, patient_first, patient_middle, birthdate, hospital_no,
          admission_date, discharge_date, requester_name, requester_relation, mobile, email, purpose, pickup_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          ref,
          str(b.patient_last, 80),
          str(b.patient_first, 80),
          str(b.patient_middle, 80) || null,
          birthdate,
          str(b.hospital_no, 40) || null,
          admission,
          discharge,
          str(b.requester_name, 160),
          str(b.requester_relation, 60),
          mobile,
          email,
          str(b.purpose, 300),
          pickup,
        ],
      );
      for (const it of cleanItems) {
        await t.query('INSERT INTO record_request_items (request_id, record_type, details, copies) VALUES ($1, $2, $3, $4)', [
          row.id,
          it.record_type,
          it.details,
          it.copies,
        ]);
      }
      return row;
    });

    await sendSms(db, { to: record.mobile, message: msg.recordSubmitted(record), kind: 'RECORD_SUBMITTED', refNo: record.ref_no });
    res.status(201).json(await publicRecord(db, record));
  });

  // ---- OPD ----

  router.get('/opd/dates', async (req, res) => {
    const dept = str(req.query.department);
    if (!catalog.department(dept)) return res.status(400).json({ error: 'Unknown department.' });
    res.json({ dates: await sched.opdDates(db, dept) });
  });

  router.get('/opd/slots', async (req, res) => {
    const dept = str(req.query.department);
    if (!catalog.department(dept)) return res.status(400).json({ error: 'Unknown department.' });
    res.json({ slots: await sched.opdSlots(db, dept, str(req.query.date)) });
  });

  router.post('/appointments', submitLimit, async (req, res) => {
    const b = req.body || {};
    required(b, [
      ['department', 'Department'],
      ['appt_date', 'Date'],
      ['appt_time', 'Time'],
      ['patient_type', 'Patient type'],
      ['patient_last', 'Last name'],
      ['patient_first', 'First name'],
      ['birthdate', 'Birthdate'],
      ['sex', 'Sex'],
      ['mobile', 'Mobile number'],
      ['complaint', 'Reason for consultation'],
    ]);
    if (b.consent !== true) throw new ValidationError('You must agree to the Data Privacy consent to continue.');
    const dept = str(b.department);
    if (!catalog.department(dept)) throw new ValidationError('Unknown department.');
    const patientType = str(b.patient_type).toUpperCase();
    if (!['NEW', 'OLD'].includes(patientType)) throw new ValidationError('Patient type must be New or Old.');
    const sex = str(b.sex).toUpperCase();
    if (!['M', 'F'].includes(sex)) throw new ValidationError('Please select sex.');
    const birthdate = validPastDate(str(b.birthdate), 'Birthdate');
    const mobile = validMobile(b.mobile);
    const email = validEmail(b.email);
    const date = str(b.appt_date);
    const time = str(b.appt_time);

    const appt = await db.tx(async (t) => {
      // One lock per clinic-day covers both slot capacity and the duplicate-booking check
      await lock(t, `opd:${dept}:${date}`);
      const err = await sched.checkOpdSlot(t, dept, date, time);
      if (err) throw new ValidationError(err);
      // Prevent the same patient double-booking the same clinic on the same day
      const dup = await t.one(
        `SELECT ref_no FROM appointments WHERE department = $1 AND appt_date = $2 AND mobile = $3
         AND lower(patient_last) = lower($4) AND lower(patient_first) = lower($5) AND status <> 'CANCELLED'`,
        [dept, date, mobile, str(b.patient_last), str(b.patient_first)],
      );
      if (dup) throw new ValidationError(`This patient already has an appointment in this clinic on that day (Ref ${dup.ref_no}).`);
      const ref = await uniqueRef(t, 'appointments', 'A');
      return t.one(
        `INSERT INTO appointments (ref_no, department, appt_date, appt_time, patient_type, hospital_no, patient_last,
          patient_first, patient_middle, birthdate, sex, mobile, email, complaint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [
          ref,
          dept,
          date,
          time,
          patientType,
          str(b.hospital_no, 40) || null,
          str(b.patient_last, 80),
          str(b.patient_first, 80),
          str(b.patient_middle, 80) || null,
          birthdate,
          sex,
          mobile,
          email,
          str(b.complaint, 500),
        ],
      );
    });

    await sendSms(db, { to: appt.mobile, message: msg.apptBooked(appt), kind: 'APPT_BOOKED', refNo: appt.ref_no });
    res.status(201).json(publicAppointment(appt));
  });

  // ---- Tracking (reference no. + mobile must both match) ----

  async function findByRef(ref, mobileInput) {
    const mobile = u.normalizeMobile(mobileInput);
    const refNo = str(ref, 40).toUpperCase();
    if (!mobile || !refNo) return null;
    if (refNo.startsWith('R-')) {
      const r = await db.one('SELECT * FROM record_requests WHERE ref_no = $1 AND mobile = $2', [refNo, mobile]);
      return r && { kind: 'record', row: r };
    }
    if (refNo.startsWith('A-')) {
      const a = await db.one('SELECT * FROM appointments WHERE ref_no = $1 AND mobile = $2', [refNo, mobile]);
      return a && { kind: 'appointment', row: a };
    }
    return null;
  }

  router.post('/track', submitLimit, async (req, res) => {
    const found = await findByRef(req.body?.ref_no, req.body?.mobile);
    if (!found) return res.status(404).json({ error: 'No request found with that reference number and mobile number.' });
    res.json(found.kind === 'record' ? await publicRecord(db, found.row) : publicAppointment(found.row));
  });

  router.post('/track/cancel', submitLimit, async (req, res) => {
    const found = await findByRef(req.body?.ref_no, req.body?.mobile);
    if (!found) return res.status(404).json({ error: 'No request found with that reference number and mobile number.' });
    const { kind, row } = found;
    if (kind === 'record') {
      const updated = await db.one(
        `UPDATE record_requests SET status = 'CANCELLED', remarks = 'Cancelled by requester', updated_at = now()
         WHERE id = $1 AND status = 'PENDING' RETURNING *`,
        [row.id],
      );
      if (!updated) throw new ValidationError('Only pending requests can be cancelled online. Please contact the Medical Records Section.');
      return res.json(await publicRecord(db, updated));
    }
    const updated = await db.one(
      `UPDATE appointments SET status = 'CANCELLED', remarks = 'Cancelled by patient', updated_at = now()
       WHERE id = $1 AND status = 'BOOKED' RETURNING *`,
      [row.id],
    );
    if (!updated) throw new ValidationError('This appointment can no longer be cancelled online.');
    await sendSms(db, { to: updated.mobile, message: msg.apptCancelled({ ...updated, remarks: '' }), kind: 'APPT_CANCELLED', refNo: updated.ref_no });
    res.json(publicAppointment(updated));
  });

  return router;
};

module.exports.ValidationError = ValidationError;
