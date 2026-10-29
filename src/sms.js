// SMS gateway. Providers:
//   console   – prints to stdout (development / no gateway yet)
//   unisms    – UniSMS (unismsapi.com), Philippine SMS gateway
//   semaphore – Semaphore (semaphore.co), common Philippine SMS gateway
//   twilio    – Twilio Programmable SMS
const config = require('./config');

const UNISMS_URL = 'https://unismsapi.com/api/sms';
// Secret key goes in HTTP Basic auth as the username, with an empty password
const unismsHeaders = () => ({
  Authorization: `Basic ${Buffer.from(`${config.sms.unismsApiKey}:`).toString('base64')}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});
// Gateway statuses that mean the text will not arrive
const FAILED_STATUSES = new Set(['failed', 'rejected', 'undelivered', 'undeliverable', 'error', 'expired', 'cancelled']);

// UniSMS replies { message: { reference_id, status, … } } (some versions: { id, status })
function parseUnisms(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  const m = body?.message && typeof body.message === 'object' ? body.message : body?.data && typeof body.data === 'object' ? body.data : body;
  return { ref: m?.reference_id ?? m?.id ?? body?.reference_id ?? body?.id ?? null, status: m?.status ?? body?.status ?? null };
}

async function sendViaProvider(to, message) {
  const { provider } = config.sms;

  if (provider === 'console') {
    console.log(`[SMS → ${to}] ${message}`);
    return;
  }

  if (provider === 'unisms') {
    if (!config.sms.unismsApiKey) throw new Error('UNISMS_API_KEY is not set');
    const res = await fetch(UNISMS_URL, {
      method: 'POST',
      headers: unismsHeaders(),
      // UniSMS's own libraries always send a sender ID, defaulting to "UniSMS"
      body: JSON.stringify({ recipient: to, content: message, sender_id: config.sms.senderName || 'UniSMS' }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`UniSMS ${res.status}: ${text.slice(0, 300)}`);
    return { ...parseUnisms(text), raw: text };
  }

  if (provider === 'semaphore') {
    const body = new URLSearchParams({ apikey: config.sms.semaphoreApiKey, number: to.replace(/^\+/, ''), message });
    if (config.sms.senderName) body.set('sendername', config.sms.senderName);
    const res = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Semaphore ${res.status}: ${text.slice(0, 300)}`);
    // Semaphore returns 200 with an error object for some validation failures
    if (!text.trim().startsWith('[')) throw new Error(`Semaphore: ${text.slice(0, 300)}`);
    return;
  }

  if (provider === 'twilio') {
    const { twilioSid, twilioToken, twilioFrom } = config.sms;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}` },
      body: new URLSearchParams({ To: to, From: twilioFrom, Body: message }),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }

  throw new Error(`Unknown SMS_PROVIDER "${provider}"`);
}

// Sends and records the result in sms_log. Never throws: SMS failure must not break a booking.
async function sendSms(db, { to, message, kind, refNo = null }) {
  let status = 'SENT';
  let error = null;
  let reply = {};
  try {
    reply = (await sendViaProvider(to, message)) || {};
    if (reply.status && FAILED_STATUSES.has(String(reply.status).toLowerCase())) {
      status = 'FAILED';
      error = `Gateway status: ${reply.status}`;
    }
  } catch (err) {
    status = 'FAILED';
    error = err.message;
    console.error(`SMS to ${to} failed: ${err.message}`);
  }
  await db.query(
    `INSERT INTO sms_log (recipient, message, kind, ref_no, provider, status, error, provider_ref, provider_status, provider_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [to, message, kind, refNo, config.sms.provider, status, error, reply.ref ?? null, reply.status ?? null, reply.raw?.slice(0, 1000) ?? null],
  );
  return status === 'SENT';
}

// Asks the gateway for the latest delivery status of a logged message (UniSMS only).
async function checkDelivery(db, row) {
  if (row.provider !== 'unisms') throw new Error('Delivery status lookup is only available for UniSMS messages.');
  if (!row.provider_ref) throw new Error('UniSMS did not return a reference number for this message, so its status cannot be checked.');
  if (!config.sms.unismsApiKey) throw new Error('UNISMS_API_KEY is not set');
  const res = await fetch(`${UNISMS_URL}/${encodeURIComponent(row.provider_ref)}`, { headers: unismsHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`UniSMS ${res.status}: ${text.slice(0, 300)}`);
  const { status } = parseUnisms(text);
  const failed = status && FAILED_STATUSES.has(String(status).toLowerCase());
  return db.one(
    `UPDATE sms_log SET provider_status = $1, provider_response = $2,
       status = CASE WHEN $3 THEN 'FAILED' ELSE status END,
       error = CASE WHEN $3 THEN $4 ELSE error END
     WHERE id = $5 RETURNING *`,
    [status, text.slice(0, 1000), !!failed, `Gateway status: ${status}`, row.id],
  );
}

module.exports = { sendSms, checkDelivery };
