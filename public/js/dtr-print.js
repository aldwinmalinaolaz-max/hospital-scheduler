// Printable Daily Time Record, Civil Service Form No. 48: one page per employee with two copies
// side by side (as on the paper form), for signature by the employee and the supervisor.
function printDtr(data, { systemName = '' } = {}) {
  const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // 'HH:MM' or 'HH:MM+1' → '7:52' (12-hour, no AM/PM: the column says which)
  const t = (v) => {
    if (!v) return '';
    const [h, m] = v.replace('+1', '').split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${v.endsWith('+1') ? '*' : ''}`;
  };
  const t12 = (v) => {
    if (!v) return '';
    const [h, m] = v.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const [y, m] = data.month.split('-').map(Number);
  const monthName = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  const copy = ({ employee: emp, days, totals }) => {
    const ut = (min) => (min ? [Math.floor(min / 60), min % 60] : ['', '']);
    const rows = days
      .map((d, i) => {
        const [uh, um] = ut(d.late + d.undertime);
        const weekend = /SATURDAY|SUNDAY/.test(d.remarks) && !d.am_in && !d.pm_in;
        return `<tr${weekend ? ' class="we"' : ''}><td>${i + 1}</td>${
          weekend
            ? `<td colspan="4" class="rem">${e(d.remarks)}</td>`
            : `<td>${t(d.am_in)}</td><td>${t(d.am_out)}</td><td>${t(d.pm_in)}</td><td>${t(d.pm_out)}</td>`
        }<td>${uh}</td><td>${um}</td></tr>`;
      })
      .join('');
    const total = totals.late + totals.undertime;
    const notes = days.filter((d) => d.remarks && !/^(SATURDAY|SUNDAY)$/.test(d.remarks)).map((d) => `${Number(d.date.slice(8))}: ${d.remarks}`);
    return `<section class="copy">
      <div class="form-no">Civil Service Form No. 48</div>
      <h1>DAILY TIME RECORD</h1>
      <div class="o">-----o0o-----</div>
      <div class="name">${e(emp.first_name)} ${e(emp.middle_name ? `${emp.middle_name[0]}. ` : '')}${e(emp.last_name)}</div>
      <div class="lbl">(Name)</div>
      <div class="meta">${e(emp.position || '')}${emp.department ? ` · ${e(emp.department)}` : ''} · Employee no. ${e(emp.employee_no)}</div>
      <table class="head"><tr><td>For the month of</td><td class="line">${e(monthName)}</td></tr>
        <tr><td>Official hours for arrival<br>and departure</td><td class="line">${emp.shift_start ? `${t12(emp.shift_start)} – ${t12(emp.shift_end)}` : 'SHIFTING SCHEDULE'}</td></tr></table>
      <table class="dtr">
        <thead>
          <tr><th rowspan="2">Day</th><th colspan="2">A.M.</th><th colspan="2">P.M.</th><th colspan="2">Undertime</th></tr>
          <tr><th>Arrival</th><th>Depar&shy;ture</th><th>Arrival</th><th>Depar&shy;ture</th><th>Hours</th><th>Min&shy;utes</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="5" class="tot">TOTAL</td><td>${total ? Math.floor(total / 60) : ''}</td><td>${total ? total % 60 : ''}</td></tr></tfoot>
      </table>
      ${notes.length ? `<div class="notes">${notes.map(e).join('; ')}</div>` : ''}
      <div class="small-note">* time-out on the following day</div>
      <p class="cert">I certify on my honor that the above is a true and correct report of the hours of work performed, record of which was made daily at the time of arrival and departure from office.</p>
      <div class="sig">&nbsp;</div>
      <div class="lbl">(Signature)</div>
      <p class="cert">VERIFIED as to the prescribed office hours:</p>
      <div class="sig">&nbsp;</div>
      <div class="lbl">In Charge</div>
    </section>`;
  };

  const pages = data.rows.map((r) => `<div class="page">${copy(r)}${copy(r)}</div>`).join('');
  const w = window.open('', '_blank');
  if (!w) return alert('Allow pop-ups for this site to print the DTR.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>DTR ${e(monthName)}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Times New Roman', serif; color: #000; background: #fff; }
    .bar { font-family: system-ui, sans-serif; padding: 10px 16px; background: #0f4d26; color: #fff; display: flex; gap: 12px; align-items: center; }
    .bar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; background: #f2c94c; color: #0f4d26; font-weight: 600; cursor: pointer; }
    .page { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; padding: 6mm; page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .copy { font-size: 10.5px; }
    .form-no { font-size: 9px; font-style: italic; }
    h1 { text-align: center; font-size: 15px; margin: 4px 0 0; letter-spacing: 0.04em; }
    .o { text-align: center; font-size: 10px; }
    .name { text-align: center; font-weight: bold; font-size: 12.5px; border-bottom: 1px solid #000; margin-top: 8px; text-transform: uppercase; }
    .lbl { text-align: center; font-size: 9px; }
    .meta { text-align: center; font-size: 9px; margin-top: 2px; }
    table.head { width: 100%; margin: 6px 0; font-size: 10px; border-collapse: collapse; }
    table.head td { padding: 1px 2px; vertical-align: bottom; }
    table.head td.line { border-bottom: 1px solid #000; text-align: center; font-weight: bold; }
    table.dtr { width: 100%; border-collapse: collapse; }
    table.dtr th, table.dtr td { border: 1px solid #000; text-align: center; padding: 1px 2px; height: 15px; font-size: 10px; }
    table.dtr th { font-weight: normal; font-size: 9.5px; }
    table.dtr td:first-child { width: 22px; }
    tr.we td.rem { font-size: 8.5px; letter-spacing: 0.15em; color: #444; }
    td.tot { text-align: right !important; font-weight: bold; }
    .notes { font-size: 8.5px; margin-top: 3px; }
    .small-note { font-size: 8px; color: #444; }
    .cert { font-size: 9.5px; text-align: justify; margin: 8px 0 0; }
    .sig { border-bottom: 1px solid #000; height: 22px; margin: 0 12%; }
    @media print { .bar { display: none; } .page { padding: 0; } }
  </style></head><body>
  <div class="bar"><b>${e(systemName)} · Daily Time Record · ${e(monthName)} · ${data.rows.length} employee${data.rows.length === 1 ? '' : 's'}</b><button onclick="window.print()">Print</button></div>
  ${pages}
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}
