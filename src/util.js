const crypto = require('node:crypto');

const pad = (n) => String(n).padStart(2, '0');

// Local YYYY-MM-DD (process.env.TZ is set to the hospital time zone in config.js)
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local 'YYYY-MM-DD HH:MM' for display of timestamps
function toStamp(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return `${toDateStr(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return toDateStr(date) === s ? date : null;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function dayOfWeek(dateStr) {
  return parseDate(dateStr).getDay();
}

function localDateTime(dateStr, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = parseDate(dateStr);
  d.setHours(h, m, 0, 0);
  return d;
}

function todayStr(now = new Date()) {
  return toDateStr(now);
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min) {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function formatTime12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

function formatDateLong(dateStr) {
  return parseDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Normalise to E.164. Philippine local formats (09XXXXXXXXX) are converted to +63.
function normalizeMobile(input) {
  const s = String(input || '').replace(/[\s\-().]/g, '');
  if (/^09\d{9}$/.test(s)) return `+63${s.slice(1)}`;
  if (/^639\d{9}$/.test(s)) return `+${s}`;
  if (/^\+\d{10,15}$/.test(s)) return s;
  return null;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRef(prefix) {
  const now = new Date();
  const datePart = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const bytes = crypto.randomBytes(5);
  const rand = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
  return `${prefix}-${datePart}-${rand}`;
}

module.exports = {
  toDateStr,
  toStamp,
  parseDate,
  addDays,
  dayOfWeek,
  localDateTime,
  todayStr,
  timeToMinutes,
  minutesToTime,
  formatTime12,
  formatDateLong,
  normalizeMobile,
  makeRef,
};
