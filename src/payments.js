// Document fees, totals, and the online payment details (QR code and instructions).
// Fees and the QR code are managed by administrators in Admin → Settings.

const DEFAULT_QR = '/img/payment-qr.jpg';
const DEFAULT_NOTE =
  'Scan the QR code with GCash or any InstaPay-enabled bank or e-wallet app and pay the exact total. ' +
  'Then upload a screenshot of the payment receipt below.';

async function getFees(db) {
  return new Map((await db.query('SELECT record_type, fee FROM document_fees')).map((r) => [r.record_type, Number(r.fee)]));
}

// items: [{ record_type, copies }] → { lines, total } (fees per copy × copies)
function computeTotal(items, fees) {
  const lines = items.map((i) => {
    const fee = fees.get(i.record_type) ?? 0;
    const copies = Number(i.copies) || 1;
    return { record_type: i.record_type, copies, fee, subtotal: fee * copies };
  });
  return { lines, total: lines.reduce((sum, l) => sum + l.subtotal, 0) };
}

const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function paymentInfo(db) {
  const [img, note] = await Promise.all([
    db.one("SELECT extract(epoch FROM updated_at)::bigint AS v FROM site_images WHERE key = 'payment_qr'"),
    db.one("SELECT value FROM site_info WHERE key = 'payment_note'"),
  ]);
  return {
    qr_url: img ? `/api/site-images/payment-qr?v=${img.v}` : DEFAULT_QR,
    note: note?.value || DEFAULT_NOTE,
  };
}

module.exports = { DEFAULT_QR, DEFAULT_NOTE, getFees, computeTotal, peso, paymentInfo };
