// Printable referral slip and return (feedback) slip, used by the facility portal and the staff panel.
// Opens a new window with the slip and the browser's print dialog.
function printReferral(r, { kind = 'referral', systemName = '', hospitalName = '' } = {}) {
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const row = (label, value) => `<tr><th>${e(label)}</th><td>${e(value) || '&nbsp;'}</td></tr>`;
  const fmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '');
  const t12 = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const name = [r.patient_last, ', ', r.patient_first, r.patient_middle ? ` ${r.patient_middle}` : ''].join('');
  const vitals = [['BP', r.bp], ['HR', r.hr], ['RR', r.rr], ['Temp', r.temp], ['O2 sat', r.o2sat], ['Weight', r.weight]]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ');
  const title = kind === 'return' ? 'RETURN SLIP (REFERRAL FEEDBACK)' : 'REFERRAL SLIP';

  const body =
    kind === 'return'
      ? `<table>
          ${row('Referral no.', r.ref_no)}${row('To (referring facility)', r.facility_name)}${row('Referred by', r.referring_name)}
          ${row('Patient', name)}${row('Age / Sex', `${r.age} / ${r.sex}`)}${row('Date referred', r.created_at)}
          ${row('Received at ZRMC', r.department_name)}${row('Seen on', r.seen_at)}
        </table>
        <h3>Findings / management at ZRMC and instructions for follow-up</h3>
        <div class="box">${e(r.feedback) || '&nbsp;'}</div>
        <p class="sign">____________________________________<br>Attending physician (signature over printed name)</p>`
      : `<table>
          ${row('Referral no.', r.ref_no)}${row('Date referred', r.created_at)}${row('Urgency', r.urgency_label)}
          ${row('From', `${r.facility_name} (${r.facility_type_label || ''})`)}${row('To', `${hospitalName} – ${r.department_name}`)}
        </table>
        <h3>Patient</h3>
        <table>
          ${row('Name', name)}${row('Birthdate / Age / Sex', `${fmt(r.birthdate)} / ${r.age} / ${r.sex}`)}
          ${row('Address', r.address)}${row('Mobile', r.mobile)}${row('PhilHealth no.', r.philhealth_no)}
        </table>
        <h3>Clinical information</h3>
        <table>
          ${row('Reason for referral', r.reason)}${row('Chief complaint', r.chief_complaint)}${row('History', r.history)}
          ${row('Vital signs', vitals)}${row('Working diagnosis', r.working_diagnosis)}${row('Treatment given', r.treatment_given)}
        </table>
        <h3>Referred by</h3>
        <table>${row('Name', r.referring_name)}${row('Designation', r.referring_designation)}${row('Contact', r.referring_contact)}</table>
        ${r.status !== 'SENT' && r.status !== 'RECEIVED' ? `<h3>ZRMC response</h3><table>
          ${row('Status', r.status_label)}${row('Response', r.response_note)}
          ${r.appt_date ? row('Appointment', `${fmt(r.appt_date)} ${t12(r.appt_time)}`) : ''}
        </table>` : ''}
        <p class="sign">____________________________________<br>Referring health worker (signature over printed name)</p>`;

  const w = window.open('', '_blank');
  if (!w) return alert('Please allow pop-ups to print.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${e(title)} ${e(r.ref_no)}</title>
    <style>
      body { font: 12pt/1.4 Arial, sans-serif; color: #000; margin: 24px; }
      header { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #0f4d26; padding-bottom: 8px; margin-bottom: 12px; }
      header img { width: 64px; height: 64px; }
      header b { font-size: 15pt; display: block; } header small { color: #333; }
      h2 { text-align: center; margin: 8px 0 12px; letter-spacing: 1px; }
      h3 { margin: 14px 0 4px; font-size: 11pt; text-transform: uppercase; color: #0f4d26; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top; font-size: 10.5pt; }
      th { width: 30%; background: #f1f5f2; font-weight: 600; }
      .box { border: 1px solid #999; min-height: 160px; padding: 8px; white-space: pre-wrap; }
      .sign { margin-top: 48px; text-align: right; }
      @media print { body { margin: 0; } }
    </style></head><body>
    <header><img src="/img/logo.png" alt=""><div><b>${e(hospitalName)}</b><small>${e(systemName)}</small></div></header>
    <h2>${e(title)}</h2>${body}
    <script>window.onload = () => window.print();<\/script></body></html>`);
  w.document.close();
}
