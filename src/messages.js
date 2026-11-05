// SMS templates. Keep each under ~160 characters where possible (1 SMS segment).
const config = require('./config');
const catalog = require('./catalog');
const { formatDateLong, formatTime12 } = require('./util');

const H = () => config.hospitalName;
// Appointment rows carry department_name (see clinics.withClinicName)
const dept = (a) => a.department_name || a.department;

// "juan.delacruz@gmail.com" → "ju***@gmail.com" (SMS can be seen by others)
const maskEmail = (e) => String(e || '').replace(/^(.{1,2})[^@]*@/, '$1***@');

module.exports = {
  recordSubmitted: (r) =>
    r.copy_type === 'DIGITAL'
      ? `${H()}: Records request ${r.ref_no} received (digital copy). We'll verify your ID, then email the documents on or after ${formatDateLong(r.pickup_date)}.`
      : `${H()}: Records request ${r.ref_no} received. Claiming date: ${formatDateLong(r.pickup_date)}. Bring valid ID. We'll text you when it's ready.`,
  recordIdVerified: (r) =>
    `${H()}: Your ID for records request ${r.ref_no} is verified. Your documents will be emailed to ${maskEmail(r.email)}.`,
  recordIdRejected: (r) =>
    `${H()}: We could not verify your ID for request ${r.ref_no}.${r.id_remarks ? ` Reason: ${r.id_remarks}.` : ''} Please upload new photos on the Track page.`,
  recordEmailed: (r) =>
    `${H()}: Your requested records (${r.ref_no}) were sent to ${maskEmail(r.email)}. Please check your inbox and spam folder.`,
  recordReady: (r) =>
    `${H()}: Your requested records (${r.ref_no}) are READY for pickup at the ${catalog.RECORDS_OFFICE_SHORT}. Bring valid ID and this reference no.`,
  recordRejected: (r) =>
    `${H()}: Records request ${r.ref_no} could not be processed.${r.remarks ? ` Reason: ${r.remarks}.` : ''} Please contact the ${catalog.RECORDS_OFFICE_SHORT}.`,
  recordPickupToday: (r) =>
    `${H()}: Reminder - your records (${r.ref_no}) are ready for pickup TODAY at the ${catalog.RECORDS_OFFICE_SHORT}. Bring valid ID.`,
  recordRescheduled: (r) =>
    `${H()}: Claiming date for records request ${r.ref_no} moved to ${formatDateLong(r.pickup_date)}.${r.remarks ? ` Note: ${r.remarks}` : ''}`,

  apptBooked: (a) =>
    `${H()}: OPD appointment ${a.ref_no} confirmed - ${dept(a)}, ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}. Please arrive 15 mins early.`,
  apptDayBefore: (a) =>
    `${H()}: Reminder - OPD appointment TOMORROW ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}, ${dept(a)}. Ref ${a.ref_no}.`,
  apptHoursBefore: (a) =>
    `${H()}: Reminder - your OPD appointment is TODAY at ${formatTime12(a.appt_time)}, ${dept(a)}. Ref ${a.ref_no}. Please arrive 15 mins early.`,
  apptCancelled: (a) =>
    `${H()}: OPD appointment ${a.ref_no} on ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)} has been CANCELLED.${a.remarks ? ` ${a.remarks}` : ''}`,
  apptRescheduled: (a) =>
    `${H()}: OPD appointment ${a.ref_no} moved to ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}, ${dept(a)}.`,
};
