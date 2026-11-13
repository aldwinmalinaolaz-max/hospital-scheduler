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

// The catalog is fetched once per page (the chat window uses it too)
let catalogPromise = null;
const getCatalog = () => (catalogPromise = catalogPromise || api('/catalog'));

// Public services turned off in Staff Panel -> Settings hide everything marked data-module="<key>"
// (also elements added later), and a page marked data-page-module="<key>" shows a notice instead.
function applyModules(cat) {
  const on = cat.modules || {};
  const off = Object.keys(on).filter((k) => on[k] === false);
  if (!off.length) return;
  const style = document.createElement('style');
  style.textContent = off.map((k) => `[data-module="${k}"]`).join(',') + '{display:none !important}';
  document.head.appendChild(style);
  const page = document.body.dataset.pageModule;
  const main = document.querySelector('main');
  if (page && on[page] === false && main && !document.querySelector('.module-off-notice')) {
    const names = cat.module_names || {};
    const note = document.createElement('section');
    note.className = 'card module-off-notice';
    note.innerHTML = `<h2>Not available online right now</h2>
      <p>${esc(names[page] || 'This service')} is not available online at the moment.${cat.modules_message ? ` ${esc(cat.modules_message)}` : ''}</p>
      <p class="muted small">Please visit the hospital or call us. For emergencies, go directly to the Emergency Room.</p>
      <a class="btn" href="/">Back to home</a>`;
    main.prepend(note);
    document.body.classList.add('page-off');
  }
}

// Fill hospital name wherever [data-hospital] appears
async function loadCatalog() {
  const cat = await getCatalog();
  applyModules(cat);
  $$('[data-hospital]').forEach((el) => (el.textContent = cat.hospitalName));
  $$('[data-system]').forEach((el) => (el.textContent = cat.systemName));
  document.title = `${document.title.split(' · ')[0]} · ${cat.systemName}`;
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

// Shrinks a photo from the camera or gallery to at most `max` pixels on its longest side and
// returns it as a JPEG data URL, so uploads stay small even on slow mobile data.
async function photoToDataUrl(file, max = 1600) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Please choose a photo (JPG or PNG).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That photo could not be read. Please try another one.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Wires a hidden file input to a preview <img>; calls onPhoto(dataUrl) when a photo is chosen
function photoPicker(input, preview, onPhoto, onError) {
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const dataUrl = await photoToDataUrl(file);
      preview.src = dataUrl;
      preview.classList.remove('hidden');
      onPhoto(dataUrl);
    } catch (err) {
      onError(err.message);
    }
    input.value = '';
  });
}
