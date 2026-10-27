// SMS gateway. Providers:
//   console   – prints to stdout (development / no gateway yet)
//   semaphore – Semaphore (semaphore.co), common Philippine SMS gateway
//   twilio    – Twilio Programmable SMS
const config = require('./config');

async function sendViaProvider(to, message) {
  const { provider } = config.sms;

  if (provider === 'console') {
    console.log(`[SMS → ${to}] ${message}`);
    return;
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
  try {
    await sendViaProvider(to, message);
  } catch (err) {
    status = 'FAILED';
    error = err.message;
    console.error(`SMS to ${to} failed: ${err.message}`);
  }
  await db.query('INSERT INTO sms_log (recipient, message, kind, ref_no, provider, status, error) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    to,
    message,
    kind,
    refNo,
    config.sms.provider,
    status,
    error,
  ]);
  return status === 'SENT';
}

module.exports = { sendSms };
