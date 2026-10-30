// Hospital Directory & Navigation: starter content and helpers.
// Locations, phone numbers and maps are left for staff to fill in (Admin → Directory),
// because they must come from the hospital, not be guessed.
const config = require('./config');
const catalog = require('./catalog');
const { formatTime12 } = require('./util');

const CATEGORIES = ['OPD Clinic', 'Department', 'Diagnostics', 'Emergency', 'Office', 'Support Service', 'Other'];

// Contact details shown on the public page; empty values are hidden there.
const SITE_FIELDS = [
  { key: 'address', label: 'Address' },
  { key: 'trunk_line', label: 'Trunk line / main phone' },
  { key: 'emergency_phone', label: 'Emergency hotline' },
  { key: 'records_phone', label: 'HHIMS phone' },
  { key: 'opd_phone', label: 'OPD phone' },
  { key: 'email', label: 'Email' },
  { key: 'facebook', label: 'Facebook page (https:// address)' },
  { key: 'website', label: 'Website (https:// address)' },
  { key: 'map_query', label: 'Google Maps search text (e.g. the hospital name and city)' },
  { key: 'visiting_hours', label: 'Visiting hours' },
  { key: 'notice', label: 'Announcement shown at the top of the directory' },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayRange(days) {
  if (days.join() === '1,2,3,4,5') return 'Monday to Friday';
  if (days.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

// Live clinic schedules from the booking settings (so the directory never disagrees with booking)
function clinicSchedules() {
  const hours = `${formatTime12(config.opd.startTime)} – ${formatTime12(config.opd.endTime)}`;
  return catalog.DEPARTMENTS.map((d) => ({ code: d.code, name: d.name, days: dayRange(d.days), hours }));
}

function seedEntries() {
  const opd = catalog.DEPARTMENTS.map((d, i) => ({
    name: `${d.name} Clinic`,
    category: 'OPD Clinic',
    description: `Outpatient consultations for ${d.name}. Book online to get a time slot.`,
    opd_code: d.code,
    keywords: d.name.toLowerCase(),
    sort_order: 100 + i * 10,
  }));
  return [
    {
      name: 'Emergency Room',
      category: 'Emergency',
      description: 'For emergencies, go directly to the Emergency Room.',
      keywords: 'er, emergency, urgent, accident',
      sort_order: 10,
    },
    {
      name: catalog.RECORDS_OFFICE,
      category: 'Office',
      description: 'Requests and release of medical records and certificates.',
      services: catalog.RECORD_TYPES.map((t) => t.name.replace(' (please specify)', '')).join('\n'),
      hours: catalog.RECORDS_OFFICE_HOURS,
      keywords: 'hhims, health information, medical records, records section, records, certificate, abstract, discharge summary, claim',
      sort_order: 20,
    },
    ...opd,
  ];
}

function seedGuides() {
  const reqs = catalog.RECORD_TYPES[0].requirements;
  return [
    {
      title: 'Requesting medical records and certificates',
      summary: 'Clinical abstract, OPTECH report, medical certificate, certificate of confinement, medico-legal certificate, diagnostic and laboratory results.',
      steps: [
        `Submit a request online on "Request Records" (or at the ${catalog.RECORDS_OFFICE}).`,
        'Take note of the reference number sent by SMS.',
        `Claim the documents ${config.records.claimDays} days after the request; if that falls on a weekend or holiday, on the next working day.`,
        'Bring the items listed under "What to bring" when claiming.',
      ].join('\n'),
      requirements: reqs.join('\n'),
      link_url: '/request-records',
      link_label: 'Request records',
      sort_order: 10,
    },
    {
      title: 'Claiming documents through a representative',
      summary: 'When someone else claims the documents for the patient.',
      steps: 'Prepare an authorization letter signed by the patient and the representative.\nThe representative brings the letter and the items listed under "What to bring" when claiming.',
      requirements: [
        'Authorization letter signed by the patient and representative',
        'Valid IDs of the patient and representative',
        'If the patient is a minor or deceased: proof of relationship (e.g. birth/marriage certificate)',
        'Reference number of the request',
      ].join('\n'),
      sort_order: 20,
    },
    {
      title: 'Medico-Legal Certificate',
      summary: 'Certificate used for legal purposes.',
      steps: 'Request online on "Request Records" and choose Medico-Legal Certificate.\nClaim on the claiming date shown in your SMS.',
      requirements: [...reqs, 'Written request from the requesting party/agency (e.g. PNP, NBI, court, legal counsel) where applicable'].join('\n'),
      link_url: '/request-records',
      link_label: 'Request records',
      sort_order: 30,
    },
    {
      title: 'OPD consultation',
      summary: 'Non-urgent outpatient check-ups with a specialist clinic.',
      steps: [
        'Book a date and time on "Book OPD Appointment".',
        'You will receive an SMS confirmation and reminders.',
        'Arrive at least 15 minutes before your time.',
      ].join('\n'),
      requirements: 'Valid ID\nReference number of the appointment\nReturning patients: Hospital Reference No. (HRN), if known',
      link_url: '/book-opd',
      link_label: 'Book an appointment',
      sort_order: 40,
    },
  ];
}

// Links may only point to pages on this site or to https:// addresses (never javascript: etc.)
const safeLink = (url) => !url || url === '/' || /^\/[^/\\]/.test(url) || /^https:\/\/\S+$/i.test(url);

// Recognise uploaded map images by their first bytes, not by the name the browser sent.
function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { CATEGORIES, SITE_FIELDS, clinicSchedules, seedEntries, seedGuides, safeLink, imageType };
