// Fills the hospital's Authorization Letter (FM-HHIM-05 Rev 2) for records requests made by
// someone other than the patient. The blanks are found by the paragraph IDs in the template,
// and only the underscore runs are replaced, so the letter's layout and styling stay as designed.
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const catalog = require('./catalog');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'authorization-letter.docx');

// Paragraph IDs (w14:paraId) of the blanks in FM-HHIM-05 Rev 2
const P = {
  grantor: '6E59FB81', // "I, ______ of legal age…"
  address: '5467CDB2', // "residing at ______, respectfully request…"
  representative: '44C12F9F', // "Also, I hereby authorized ______ whose signature…"
  patientSignature: '553DC600', // line above "Patient's Name & Signature"
  patientDate: '1F3E9607',
  representativeName: '40965CD9', // line above "Printed Name of Parent/Guardian/Authorized Personnel"
  representativeDate: '4BCE2380',
  others: '6C9922F9',
};
// Checkbox lines on the form and which request types tick them; anything else goes under "Others"
const CHECKBOXES = { '278087F8': 'CERT_CONFINEMENT', '6B474074': 'MEDICAL_CERTIFICATE' };
const CHECKED = '■'; // Times New Roman, the checkbox font, has ■ (□ when unticked)

const xmlEscape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function withParagraph(xml, paraId, fn) {
  const re = new RegExp(`<w:p [^>]*w14:paraId="${paraId}"[^>]*>[\\s\\S]*?</w:p>`);
  const m = re.exec(xml);
  if (!m) throw new Error(`Authorization letter template changed: paragraph ${paraId} not found`);
  return xml.slice(0, m.index) + fn(m[0]) + xml.slice(m.index + m[0].length);
}

const runText = (run) => (run.match(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const runProps = (run) => (/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run) || [''])[0];
const makeRun = (rPr, text) => `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
const underlined = (rPr) =>
  rPr ? rPr.replace('</w:rPr>', '<w:u w:val="single"/></w:rPr>') : '<w:rPr><w:u w:val="single"/></w:rPr>';

// Replace the underscore blank in a paragraph with `value` (underlined, like a filled-in form).
// Text sharing a run with the blank (e.g. "Others: " or ", respectfully") is kept.
function fillBlank(paragraph, value) {
  if (!value) return paragraph;
  const runs = paragraph.match(/<w:r[ >][\s\S]*?<\/w:r>/g) || [];
  let filled = false;
  let out = paragraph;
  for (const run of runs) {
    const text = runText(run);
    if (!text.includes('_')) continue;
    if (filled) {
      // Later pieces of the same blank: drop the underscores, keep any other text
      const rest = text.replace(/_+/g, '');
      out = out.replace(run, () => (rest ? makeRun(runProps(run), rest) : ''));
      continue;
    }
    const rPr = runProps(run);
    const before = text.slice(0, text.indexOf('_'));
    const after = text.slice(text.lastIndexOf('_') + 1);
    // Function form so "$" in a name is never treated as a replacement pattern
    out = out.replace(run, () => `${before ? makeRun(rPr, before) : ''}${makeRun(underlined(rPr), ` ${value} `)}${after ? makeRun(rPr, after) : ''}`);
    filled = true;
  }
  return out;
}

const tick = (paragraph) => paragraph.replace(/(<w:t(?: [^>]*)?>)□(<\/w:t>)/, `$1${CHECKED}$2`);

const longDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// Records requests that need the letter: the requester is not the patient
const needsLetter = (r) => !/^self/i.test(r.requester_relation || '');

async function buildAuthorizationLetter(record, items) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let xml = await zip.file('word/document.xml').async('string');

  const patient = [record.patient_first, record.patient_middle, record.patient_last].filter(Boolean).join(' ');
  const date = longDate(record.created_at || new Date());
  const ticked = new Set(Object.values(CHECKBOXES));
  const others = items
    .filter((i) => !ticked.has(i.record_type))
    .map((i) => {
      const name = catalog.recordType(i.record_type)?.name.replace(' (please specify)', '') || i.record_type;
      return i.record_type === 'OTHERS' && i.details ? i.details : name;
    });

  xml = withParagraph(xml, P.grantor, (p) => fillBlank(p, patient));
  xml = withParagraph(xml, P.address, (p) => fillBlank(p, record.patient_address));
  xml = withParagraph(xml, P.representative, (p) => fillBlank(p, record.requester_name));
  xml = withParagraph(xml, P.patientSignature, (p) => fillBlank(p, patient));
  xml = withParagraph(xml, P.patientDate, (p) => fillBlank(p, date));
  xml = withParagraph(xml, P.representativeName, (p) => fillBlank(p, record.requester_name));
  xml = withParagraph(xml, P.representativeDate, (p) => fillBlank(p, date));
  for (const [paraId, type] of Object.entries(CHECKBOXES)) {
    if (items.some((i) => i.record_type === type)) xml = withParagraph(xml, paraId, tick);
  }
  if (others.length) xml = withParagraph(xml, P.others, (p) => tick(fillBlank(p, others.join(', '))));

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const letterFilename = (record) => `Authorization-Letter-${record.ref_no}.docx`;

module.exports = { buildAuthorizationLetter, needsLetter, letterFilename, DOCX_MIME: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
