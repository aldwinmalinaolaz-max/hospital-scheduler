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
          <dt>Copy</dt><dd>${r.copy_type === 'DIGITAL' ? `Digital copy, emailed to ${esc(r.email)}` : 'Hardcopy (claim at HHIMS)'}</dd>
          ${r.copy_type === 'DIGITAL'
            ? `<dt>ID check</dt><dd>${esc(ID_STATUS[r.id_status] || r.id_status)}</dd>
               <dt>${r.emailed_at ? 'Emailed' : 'Email date'}</dt><dd>${r.emailed_at ? esc(r.emailed_at) : `On or after ${esc(fmtDate(r.pickup_date))}`}</dd>`
            : `<dt>Claiming date</dt><dd>${esc(fmtDate(r.pickup_date))}</dd>`}
          ${r.remarks ? `<dt>Remarks</dt><dd>${esc(r.remarks)}</dd>` : ''}
          <dt>Submitted</dt><dd>${esc(r.created_at)}</dd>
        </dl>
        ${r.letter_url ? `<div class="alert info small">Requested by a representative: bring the signed authorization letter and both valid IDs when claiming.
          <div style="margin-top:8px"><a class="btn sm" href="${esc(r.letter_url)}" download>Download authorization letter (Word)</a></div></div>` : ''}
        ${r.copy_type === 'DIGITAL' && r.id_status === 'REJECTED' ? reuploadForm(r) : ''}
        ${r.emailed_at ? '<div class="alert ok">Your documents were sent to your email. Please check your inbox and spam folder.</div>' : ''}
        ${r.copy_type !== 'DIGITAL' && r.status === 'READY' ? '<div class="alert ok">Your documents are ready. Please bring a valid ID and your reference number to the Hospital Health Information Management Section (HHIMS).</div>' : ''}
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
    if ($('#reupload')) wireReupload();
  }

  const ID_STATUS = { PENDING: 'Waiting for HHIMS staff to check your ID', VERIFIED: 'Verified', REJECTED: 'Not verified — please upload new photos' };

  // When staff could not verify the ID, the requester uploads new photos here
  function reuploadForm(r) {
    return `<div class="alert warn" id="reupload">
      <b>We could not verify your ID.</b>${r.id_remarks ? ` Reason: ${esc(r.id_remarks)}` : ''}
      <p class="small" style="margin:6px 0 10px">Please upload new, clear photos. Your request will be checked again.</p>
      <div class="grid grid-2">
        <div class="id-upload"><b class="small">Photo of your valid ID</b>
          <label class="btn secondary sm upload-btn"><input type="file" accept="image/*" id="idPhotoInput" hidden>Take or choose photo</label>
          <img id="idPhotoPreview" alt="Valid ID preview" class="hidden"></div>
        <div class="id-upload"><b class="small">Selfie holding the same ID</b>
          <label class="btn secondary sm upload-btn"><input type="file" accept="image/*" id="selfiePhotoInput" hidden>Take or choose photo</label>
          <img id="selfiePhotoPreview" alt="Selfie preview" class="hidden"></div>
      </div>
      <div class="actions"><button class="btn" type="button" id="reuploadBtn">Send new photos</button></div>
    </div>`;
  }

  function wireReupload() {
    const photos = { id: '', selfie: '' };
    const err = (m) => alert(m);
    photoPicker($('#idPhotoInput'), $('#idPhotoPreview'), (d) => (photos.id = d), err);
    photoPicker($('#selfiePhotoInput'), $('#selfiePhotoPreview'), (d) => (photos.selfie = d), err);
    $('#reuploadBtn').addEventListener('click', async () => {
      if (!photos.id || !photos.selfie) return alert('Please add both photos.');
      const btn = $('#reuploadBtn');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        render(await api('/track/id-photos', { method: 'POST', body: { ref_no: current.ref_no, mobile: form.mobile.value, id_photo: photos.id, selfie_photo: photos.selfie } }));
      } catch (e) {
        alert(e.message);
        btn.disabled = false;
        btn.textContent = 'Send new photos';
      }
    });
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
