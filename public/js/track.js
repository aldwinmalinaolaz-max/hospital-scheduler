(async () => {
  loadCatalog();
  const form = $('#form');
  const result = $('#result');
  let current = null;

  const params = new URLSearchParams(location.search);
  if (params.get('ref')) form.ref_no.value = params.get('ref');

  function render(r) {
    current = r;
    result.classList.remove('hidden');
    if (r.kind === 'record') {
      const canCancel = r.status === 'PENDING';
      result.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <h2 style="margin:0">Records request <span class="mono">${esc(r.ref_no)}</span></h2>${badge(r.status)}
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>Patient</dt><dd>${esc(r.patient)}</dd>
          <dt>Documents</dt><dd><ul class="list-tight">${r.items.map((i) => `<li>${esc(i.name)}${i.details ? ` — ${esc(i.details)}` : ''} × ${i.copies}</li>`).join('')}</ul></dd>
          <dt>Pickup date</dt><dd>${esc(fmtDate(r.pickup_date))}</dd>
          ${r.remarks ? `<dt>Remarks</dt><dd>${esc(r.remarks)}</dd>` : ''}
          <dt>Submitted</dt><dd>${esc(r.created_at)}</dd>
        </dl>
        ${r.status === 'READY' ? '<div class="alert ok">Your documents are ready. Please bring a valid ID and your reference number to the Medical Records Section.</div>' : ''}
        ${canCancel ? '<div class="actions"><button class="btn danger" id="cancelBtn">Cancel request</button></div>' : ''}`;
    } else {
      const canCancel = r.status === 'BOOKED';
      result.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
          <h2 style="margin:0">OPD appointment <span class="mono">${esc(r.ref_no)}</span></h2>${badge(r.status)}
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>Patient</dt><dd>${esc(r.patient)}</dd>
          <dt>Clinic</dt><dd>${esc(r.department)}</dd>
          <dt>Schedule</dt><dd>${esc(fmtDate(r.appt_date))}, ${esc(r.appt_time_label)}</dd>
          ${r.remarks ? `<dt>Remarks</dt><dd>${esc(r.remarks)}</dd>` : ''}
        </dl>
        ${canCancel ? '<div class="actions"><a class="btn secondary" href="/book-opd">Book another</a><button class="btn danger" id="cancelBtn">Cancel appointment</button></div>' : ''}`;
    }
    $('#cancelBtn')?.addEventListener('click', cancel);
  }

  async function cancel() {
    if (!confirm('Are you sure you want to cancel? This cannot be undone.')) return;
    try {
      render(await api('/track/cancel', { method: 'POST', body: { ref_no: current.ref_no, mobile: form.mobile.value } }));
    } catch (err) {
      alert(err.message);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('#error'), '');
    result.classList.add('hidden');
    try {
      render(await api('/track', { method: 'POST', body: formData(form) }));
    } catch (err) {
      showError($('#error'), err.message);
    }
  });
})();
