// Services offered. Edit this file to match your hospital's actual offerings
// and requirements. The claiming date rule is RECORDS_CLAIM_DAYS in .env.

// The records office (handles requests and release of records and certificates)
const RECORDS_OFFICE = 'Hospital Health Information Management Section (HHIMS)';
const RECORDS_OFFICE_SHORT = 'HHIMS'; // used in SMS, which must stay short
const RECORDS_OFFICE_HOURS = 'Monday to Friday, 8:00 AM – 5:00 PM (No Noon Break); Saturdays and Holidays, 8:00 AM – 4:00 PM (No Noon Break)';

const COMMON_REQS = [
  'Valid government-issued ID of the patient',
  'If requested by a representative: authorization letter signed by the patient and representative, plus their valid IDs.',
  'If the patient is a minor or deceased: proof of relationship (e.g. birth/marriage certificate)',
];

const RECORD_TYPES = [
  {
    code: 'CLINICAL_ABSTRACT',
    name: 'Clinical Abstract / Discharge Summary',
    requirements: COMMON_REQS,
  },
  {
    code: 'OPTECH',
    name: 'OPTECH Report (Operative Technique)',
    requirements: COMMON_REQS,
  },
  {
    code: 'MEDICAL_CERTIFICATE',
    name: 'Medical Certificate',
    requirements: COMMON_REQS,
  },
  {
    code: 'CERT_CONFINEMENT',
    name: 'Certificate of Confinement',
    requirements: COMMON_REQS,
  },
  {
    code: 'MEDICO_LEGAL',
    name: 'Medico-Legal Certificate',
    requirements: [
      ...COMMON_REQS,
      'Written request from the requesting party/agency (e.g. PNP, NBI, court, legal counsel) where applicable',
    ],
  },
  {
    code: 'DIAGNOSTIC_TEST',
    name: 'Diagnostic Test Result (X-ray, Ultrasound, CT, ECG, etc.)',
    requirements: COMMON_REQS,
  },
  {
    code: 'LABORATORY_TEST',
    name: 'Laboratory Test Result',
    requirements: COMMON_REQS,
  },
  {
    code: 'OTHERS',
    name: 'Others (please specify)',
    requiresDetails: true,
    requirements: COMMON_REQS,
  },
];

// days: 0=Sun … 6=Sat. Clinic is only bookable on these weekdays.
const DEPARTMENTS = [
  { code: 'IM', name: 'Internal Medicine', days: [1, 2, 3, 4, 5] },
  { code: 'PEDIA', name: 'Pediatrics', days: [1, 2, 3, 4, 5] },
  { code: 'OBGYN', name: 'Obstetrics & Gynecology', days: [1, 2, 3, 4, 5] },
  { code: 'SURG', name: 'General Surgery', days: [1, 3, 5] },
  { code: 'FAMMED', name: 'Family Medicine', days: [1, 2, 3, 4, 5] },
  { code: 'ORTHO', name: 'Orthopedics', days: [2, 4] },
  { code: 'ENT', name: 'ENT (Ear, Nose & Throat)', days: [2, 4] },
  { code: 'OPHTHA', name: 'Ophthalmology', days: [1, 3, 5] },
];

const RECORD_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'RELEASED', 'REJECTED', 'CANCELLED'];
const APPOINTMENT_STATUSES = ['BOOKED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

const recordType = (code) => RECORD_TYPES.find((t) => t.code === code);
const department = (code) => DEPARTMENTS.find((d) => d.code === code);

module.exports = {
  RECORDS_OFFICE,
  RECORDS_OFFICE_SHORT,
  RECORDS_OFFICE_HOURS,
  RECORD_TYPES,
  DEPARTMENTS,
  RECORD_STATUSES,
  APPOINTMENT_STATUSES,
  recordType,
  department,
};
