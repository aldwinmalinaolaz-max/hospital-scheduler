// FAQ assistant: matches a visitor's question to staff-written FAQ entries by keywords.
// Answers are only ever text that staff wrote, so the assistant cannot make things up.
const config = require('./config');
const catalog = require('./catalog');
const { formatTime12 } = require('./util');

// Words ignored when comparing a message with an FAQ's question
const STOPWORDS = new Set(
  'a an the i me my we our you your is are am was be can could do does did how what when where why who which to of in on for at by with and or it this that there my po ba ko ang ng sa mga na ako'.split(' '),
);

const normalize = (s) =>
  ` ${String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

const words = (s) => normalize(s).trim().split(' ').filter((w) => w && !STOPWORDS.has(w));

// Higher is better. A keyword phrase found in the message is worth 2 points plus 1 per extra word;
// each content word shared with the FAQ's question adds 1.
function score(message, faq) {
  const text = normalize(message);
  let total = 0;
  for (const kw of String(faq.keywords || '').split(',')) {
    const phrase = normalize(kw).trim();
    if (phrase && text.includes(` ${phrase} `)) total += 1 + phrase.split(' ').length;
  }
  const msgWords = new Set(words(message));
  for (const w of new Set(words(faq.question))) if (msgWords.has(w)) total += 1;
  return total;
}

const MIN_SCORE = 2;

function bestMatches(message, faqs, limit = 3) {
  return faqs
    .map((f) => ({ faq: f, score: score(message, f) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.faq.sort_order - b.faq.sort_order)
    .slice(0, limit);
}

// ---------- Placeholders that keep answers in step with the system's settings ----------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayRange(days) {
  if (days.join() === '1,2,3,4,5') return 'Monday to Friday';
  if (days.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

function placeholders() {
  return {
    hospital: config.hospitalName,
    claim_days: String(config.records.claimDays),
    office_days: config.records.openSaturday ? 'Monday to Saturday' : 'Monday to Friday',
    opd_hours: `${formatTime12(config.opd.startTime)} – ${formatTime12(config.opd.endTime)}`,
    documents: catalog.RECORD_TYPES.map((t) => `• ${t.name.replace(' (please specify)', '')}`).join('\n'),
    clinic_schedule: catalog.DEPARTMENTS.map((d) => `• ${d.name}: ${dayRange(d.days)}`).join('\n'),
  };
}

const PLACEHOLDER_NAMES = Object.keys(placeholders());

function render(text) {
  const values = placeholders();
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}

// ---------- Starter FAQs (inserted once, when the FAQ table is empty; editable in Admin → FAQs) ----------

const SEEDS = [
  {
    question: 'How do I request medical records?',
    answer:
      'Open "Request Records", tick the documents you need, enter the purpose and the patient\'s details, then submit. You will get an SMS with your reference number and claiming date, and another SMS when your documents are ready.',
    keywords: 'request records, request record, medical records, request document, request documents, get my records, how to request, records request, kuha records, mag request',
    link_url: '/request-records',
    link_label: 'Request records',
  },
  {
    question: 'What documents can I request?',
    answer: 'You can request:\n{documents}\n\nIf what you need is not listed, choose "Others" and describe it.',
    keywords: 'what documents, which documents, documents available, list of documents, discharge summary, clinical abstract, medical certificate, med cert, certificate of confinement, medico legal, optech, laboratory result, lab result, diagnostic, x ray, xray, ultrasound',
    link_url: '/request-records',
    link_label: 'Request records',
  },
  {
    question: 'When can I claim my documents?',
    answer:
      'All requested medical documents may be claimed {claim_days} days after the date of request. Requests made on Friday that fall within the weekend will be available on Monday. If the claiming date falls on a weekend or holiday, the documents will be released on the next working day.\n\nYour exact claiming date is shown after you submit and in your SMS.',
    keywords: 'claim, claiming, claiming date, when can i claim, when can i get, when will, when, when ready, how long, how many days, processing time, release, released, pick up, pickup, kailan, kanus a, ready',
    link_url: '/track',
    link_label: 'Check my request',
  },
  {
    question: 'What do I need to bring when claiming?',
    answer:
      'Bring your reference number and a valid government-issued ID of the patient.\n\nIf a representative is claiming: an authorization letter signed by the patient and representative, plus their valid IDs.\n\nIf the patient is a minor or deceased: proof of relationship (e.g. birth or marriage certificate).\n\nFor a Medico-Legal Certificate, also bring the written request from the requesting party or agency, where applicable.',
    keywords: 'bring, requirements, requirement, what to bring, valid id, id needed, documents needed, authorization letter, need to bring, dalhin, kailangan',
  },
  {
    question: 'Can someone else request or claim my records for me?',
    answer:
      'Yes. A representative needs an authorization letter signed by the patient and representative, plus their valid IDs. For a minor or deceased patient, bring proof of relationship (e.g. birth or marriage certificate).',
    keywords: 'representative, someone else, relative, family member, authorize, authorization, on behalf, behalf, claim for, for me, claim it for me, proxy, spouse, parent, guardian, wife, husband, mother, father, son, daughter, brother, sister, friend, asawa, nanay, tatay, anak, kapatid, ipakuha',
  },
  {
    question: 'How do I book an OPD appointment?',
    answer:
      'Open "Book OPD Appointment", choose the clinic, then pick a date and time slot and enter the patient\'s details. You will get an SMS confirmation, a reminder the day before, and another reminder on the day of your appointment. Please arrive 15 minutes early.',
    keywords: 'book, booking, appointment, schedule appointment, opd, consultation, consult, check up, checkup, see a doctor, doctor, magpa check up, pa schedule',
    link_url: '/book-opd',
    link_label: 'Book an appointment',
  },
  {
    question: 'What are the OPD clinic schedules?',
    answer: 'OPD consultations are from {opd_hours} on these days:\n{clinic_schedule}\n\nClosed on holidays.',
    keywords: 'clinic schedule, opd schedule, clinic days, opd hours, clinic hours, what time, open, schedule, pediatrics, internal medicine, ob gyne, obgyne, surgery, ent, ophthalmology, eye, orthopedics, family medicine',
    link_url: '/book-opd',
    link_label: 'Book an appointment',
  },
  {
    question: 'How do I check or cancel my request or appointment?',
    answer:
      'Open "Track / Cancel" and enter your reference number (it starts with R- for records or A- for appointments) and the mobile number you used. Pending records requests and booked appointments can be cancelled there.',
    keywords: 'track, status, check status, cancel, cancellation, reschedule, change appointment, reference number, ref number, follow up, update',
    link_url: '/track',
    link_label: 'Track / Cancel',
  },
  {
    question: "I didn't receive an SMS. What should I do?",
    answer:
      'Messages can take a few minutes. Make sure the mobile number you entered is correct and has signal. You can still see your request at any time on "Track / Cancel" using your reference number, which is also shown on screen right after you submit.',
    keywords: 'no sms, no text, did not receive, didnt receive, not received, no message, sms, text message, wala text, walay text, no confirmation',
    link_url: '/track',
    link_label: 'Track / Cancel',
  },
  {
    question: 'What are the office hours of the Medical Records Section?',
    answer: 'Documents can be claimed {office_days}, 8:00 AM – 5:00 PM, except holidays.',
    keywords: 'office hours, open hours, what time, working hours, hours, records section, medical records section, open on saturday, open on sunday, oras',
  },
  {
    question: 'How much do the documents cost?',
    answer: 'For fees and payment, please ask the Medical Records Section when you claim your documents.',
    keywords: 'fee, fees, cost, price, how much, payment, pay, bayad, magkano, pila, presyo',
  },
  {
    question: 'Is this for emergencies?',
    answer:
      'No. For emergencies, go directly to the Emergency Room or call emergency services. Online OPD appointments are for non-urgent consultations only.',
    keywords: 'emergency, urgent, er, emergency room, accident, chest pain, bleeding, cannot breathe, can t breathe, unconscious, ambulance, emerhensya',
  },
  {
    question: 'How is my personal information protected?',
    answer:
      'Your personal and health information is collected only for your request or appointment and is handled in accordance with the Data Privacy Act of 2012 (RA 10173). Only authorized hospital staff can see it.',
    keywords: 'privacy, data privacy, personal information, personal data, safe, secure, confidential, ra 10173',
  },
];

const FALLBACK =
  "Sorry, I don't have an answer for that yet. Please try asking in a different way, choose one of the questions below, or ask the Medical Records Section or OPD directly.\n\nFor emergencies, go to the Emergency Room.";

module.exports = { score, bestMatches, render, placeholders, PLACEHOLDER_NAMES, SEEDS, FALLBACK, MIN_SCORE, normalize };
