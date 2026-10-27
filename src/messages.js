// SMS templates. Keep each under ~160 characters where possible (1 SMS segment).
const config = require('./config');
const catalog = require('./catalog');
const { formatDateLong, formatTime12 } = require('./util');

const H = () => config.hospitalName;
const dept = (code) => catalog.department(code)?.name || code;

module.exports = {
  recordSubmitted: (r) =>
    `${H()}: Records request ${r.ref_no} received. Pickup date: ${formatDateLong(r.pickup_date)}. Bring valid ID. We'll text you when it's ready.`,
  recordReady: (r) =>
    `${H()}: Your requested records (${r.ref_no}) are READY for pickup at the Medical Records Section. Bring valid ID and this reference no.`,
  recordRejected: (r) =>
    `${H()}: Records request ${r.ref_no} could not be processed.${r.remarks ? ` Reason: ${r.remarks}.` : ''} Please contact the Medical Records Section.`,
  recordPickupToday: (r) =>
    `${H()}: Reminder - your records (${r.ref_no}) are ready for pickup TODAY at the Medical Records Section. Bring valid ID.`,
  recordRescheduled: (r) =>
    `${H()}: Pickup for records request ${r.ref_no} moved to ${formatDateLong(r.pickup_date)}.${r.remarks ? ` Note: ${r.remarks}` : ''}`,

  apptBooked: (a) =>
    `${H()}: OPD appointment ${a.ref_no} confirmed - ${dept(a.department)}, ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}. Please arrive 15 mins early.`,
  apptDayBefore: (a) =>
    `${H()}: Reminder - OPD appointment TOMORROW ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}, ${dept(a.department)}. Ref ${a.ref_no}.`,
  apptHoursBefore: (a) =>
    `${H()}: Reminder - your OPD appointment is TODAY at ${formatTime12(a.appt_time)}, ${dept(a.department)}. Ref ${a.ref_no}. Please arrive 15 mins early.`,
  apptCancelled: (a) =>
    `${H()}: OPD appointment ${a.ref_no} on ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)} has been CANCELLED.${a.remarks ? ` ${a.remarks}` : ''}`,
  apptRescheduled: (a) =>
    `${H()}: OPD appointment ${a.ref_no} moved to ${formatDateLong(a.appt_date)} ${formatTime12(a.appt_time)}, ${dept(a.department)}.`,
};
