// Shared helpers for public and admin pages.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtDate(s, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
  if (msg) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

const STATUS_LABELS = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  READY: 'Ready for pickup',
  RELEASED: 'Released',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  BOOKED: 'Booked',
  CHECKED_IN: 'Checked in',
  COMPLETED: 'Completed',
  NO_SHOW: 'No show',
  SENT: 'Sent',
  FAILED: 'Failed',
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;

// Fill hospital name wherever [data-hospital] appears
async function loadCatalog() {
  const cat = await api('/catalog');
  $$('[data-hospital]').forEach((el) => (el.textContent = cat.hospitalName));
  document.title = document.title.replace('Hospital', cat.hospitalName);
  return cat;
}

const DATA_PRIVACY_TEXT =
  'I consent to the collection and processing of my personal and health information for the purpose of this request/appointment, in accordance with the Data Privacy Act of 2012 (RA 10173).';

// Force capital letters in every typed text field. Passwords, usernames and email
// addresses are excluded because they must be kept exactly as typed.
const CAPS_FIELDS = ":is(input:not([type]), input[type='text'], input[type='search'], textarea):not([name='username']):not([data-nocaps])";
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches?.(CAPS_FIELDS)) return;
  const upper = el.value.toUpperCase();
  if (upper === el.value) return;
  const { selectionStart, selectionEnd } = el;
  el.value = upper;
  el.setSelectionRange?.(selectionStart, selectionEnd);
});
