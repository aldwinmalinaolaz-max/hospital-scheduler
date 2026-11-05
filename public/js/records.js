(async () => {
  const cat = await loadCatalog();
  const form = $('#form');
  const selected = new Map(); // code -> { copies, details }
  let claimDate = '';

  $('#consentText').textContent = DATA_PRIVACY_TEXT;

  // ----- Fees: shown per document, with a running total payable -----
  const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const feeOf = (code) => cat.recordTypes.find((t) => t.code === code)?.fee || 0;
  const total = () => [...selected].reduce((sum, [code, v]) => sum + feeOf(code) * v.copies, 0);
  function showTotal() {
    $('#totalAmount').textContent = peso(total());
    $('#totalBar').classList.toggle('on', selected.size > 0);
  }
  $('#payQr').src = cat.payment.qr_url;
  $('#payQrSave').href = cat.payment.qr_url;
  $('#payNote').textContent = cat.payment.note;
  $('#docList').innerHTML = cat.recordTypes
    .map(
      (t) => `
      <div class="doc" data-code="${esc(t.code)}">
        <input type="checkbox" id="doc-${esc(t.code)}">
        <label for="doc-${esc(t.code)}" class="doc-name">${esc(t.name)} <span class="doc-fee">${peso(t.fee)} per copy</span></label>
        <span class="doc-copies hidden"><label for="copies-${esc(t.code)}">Copies</label><input type="number" id="copies-${esc(t.code)}" min="1" max="10" value="1"></span>
        ${t.requiresDetails ? `<input class="doc-details hidden" placeholder="Please specify the document you need" maxlength="300">` : ''}
      </div>`,
    )
    .join('');

  $$('.doc').forEach((row) => {
    const code = row.dataset.code;
    const cb = $('input[type=checkbox]', row);
    const copies = $('.doc-copies input', row);
    const details = $('.doc-details', row);
    const sync = () => {
      row.classList.toggle('selected', cb.checked);
      $('.doc-copies', row).classList.toggle('hidden', !cb.checked);
      details?.classList.toggle('hidden', !cb.checked);
      if (cb.checked) selected.set(code, { copies: Number(copies.value) || 1, details: details?.value.trim() || '' });
      else selected.delete(code);
      showTotal();
    };
    cb.addEventListener('change', sync);
    copies.addEventListener('input', sync);
    details?.addEventListener('input', sync);
  });

  form.requester_relation.addEventListener('change', () => {
    const self = form.requester_relation.value.startsWith('Self');
    const representative = !!form.requester_relation.value && !self;
    $('#repNote').classList.toggle('hidden', !representative);
    // The authorization letter needs the patient's address
    $('#addressField').classList.toggle('hidden', !representative);
    form.patient_address.required = representative;
    if (!representative) form.patient_address.value = '';
    if (self && !form.requester_name.value) {
      form.requester_name.value = [form.patient_first.value, form.patient_middle.value, form.patient_last.value].filter(Boolean).join(' ');
    }
  });

  async function renderReview() {
    const d = formData(form);
    ({ date: claimDate } = await api('/records/claim-date'));
    const items = [...selected].map(([code, v]) => {
      const t = cat.recordTypes.find((x) => x.code === code);
      return `<li>${esc(t.name)}${v.details ? ` — <i>${esc(v.details)}</i>` : ''} <span class="muted">× ${v.copies} @ ${peso(t.fee)}</span> = <b>${peso(t.fee * v.copies)}</b></li>`;
    });
    $('#review').innerHTML = `
      <dl class="kv">
        <dt>Documents</dt><dd><ul class="list-tight">${items.join('')}</ul></dd>
        <dt>Total payable</dt><dd><b class="pay-total-inline">${peso(total())}</b> <span class="muted small" id="totalHint">(for reference)</span></dd>
        <dt>Patient</dt><dd>${esc([d.patient_first, d.patient_middle, d.patient_last].filter(Boolean).join(' '))}</dd>
        <dt>Birthdate</dt><dd>${esc(fmtDate(d.birthdate))}</dd>
        ${d.admission_date ? `<dt>Admission / visit</dt><dd>${esc(fmtDate(d.admission_date))}${d.discharge_date ? ` – ${esc(fmtDate(d.discharge_date))}` : ''}</dd>` : ''}
        <dt>Requested by</dt><dd>${esc(d.requester_name)} (${esc(d.requester_relation)})</dd>
        <dt>Mobile</dt><dd>${esc(d.mobile)}</dd>
        ${d.patient_address ? `<dt>Patient's address</dt><dd>${esc(d.patient_address)}</dd>` : ''}
        <dt>Purpose</dt><dd>${esc(d.purpose)}</dd>
        <dt>Email</dt><dd>${esc(d.email)}</dd>
        <dt id="dateLabel">Claiming date</dt><dd>${esc(fmtDate(claimDate))} <span class="muted small" id="dateHint">(8:00 AM – 5:00 PM, no noon break)</span></dd>
      </dl>
      ${d.patient_address ? '<div class="alert info small" style="margin-top:14px">Because you are not the patient, the hospital\'s <b>authorization letter</b> will be filled in with these details for you to download after you submit.</div>' : ''}`;
    const reqs = new Set([...selected.keys()].flatMap((c) => cat.recordTypes.find((t) => t.code === c).requirements));
    $('#reqList').innerHTML = [...reqs].map((r) => `<li>${esc(r)}</li>`).join('');
    updateCopyUI();
  }

  // ----- Hardcopy or digital copy -----
  const photos = { id: '', selfie: '', receipt: '' };
  const isRepresentative = () => !!form.requester_relation.value && !form.requester_relation.value.startsWith('Self');
  const copyType = () => form.querySelector('[name=copy_type]:checked')?.value || '';
  function updateCopyUI() {
    const rep = isRepresentative();
    const digital = form.querySelector('[name=copy_type][value=DIGITAL]');
    digital.disabled = rep;
    $('#digitalOpt').classList.toggle('disabled', rep);
    $('#digitalBlocked').classList.toggle('hidden', !rep);
    if (rep && digital.checked) digital.checked = false;
    const type = copyType();
    $('#hardcopyInfo').classList.toggle('hidden', type !== 'HARDCOPY');
    $('#digitalInfo').classList.toggle('hidden', type !== 'DIGITAL');
    $('#digitalEmail').textContent = form.email.value;
    $('#payAmount').textContent = peso(total());
    if ($('#totalHint')) $('#totalHint').textContent = type === 'DIGITAL' ? '(pay online below)' : '(for reference)';
    if ($('#dateLabel')) {
      $('#dateLabel').textContent = type === 'DIGITAL' ? 'Documents emailed' : 'Claiming date';
      $('#dateHint').textContent = type === 'DIGITAL' ? '(on or after this date, once your ID is verified)' : '(8:00 AM – 5:00 PM, no noon break)';
    }
  }
  $$('[name=copy_type]').forEach((r) => r.addEventListener('change', updateCopyUI));
  const photoError = (m) => showError($('#error'), m);
  photoPicker($('#idPhotoInput'), $('#idPhotoPreview'), (d) => (photos.id = d), photoError);
  photoPicker($('#selfiePhotoInput'), $('#selfiePhotoPreview'), (d) => (photos.selfie = d), photoError);
  photoPicker($('#receiptPhotoInput'), $('#receiptPhotoPreview'), (d) => (photos.receipt = d), photoError);

  wizard({
    total: 3,
    validate(step) {
      if (step === 1) {
        if (!selected.size) return 'Please select at least one document.';
        if (selected.has('OTHERS') && !selected.get('OTHERS').details) return 'Please specify the document you need under "Others".';
        if ([...selected.values()].some((v) => v.copies < 1 || v.copies > 10)) return 'Copies must be between 1 and 10.';
        if (!form.purpose.value.trim()) return 'Please enter the purpose of your request.';
      }
      if (step === 2) {
        const panel = $('[data-panel="2"]');
        const miss = requiredMissing(panel);
        if (miss) return miss;
        if (!checkMobile(form.mobile.value)) return 'Please enter a valid mobile number (e.g. 09171234567).';
        if (![form.birthdate, form.admission_date, form.discharge_date].every((el) => checkPastDate(el.value))) return 'Dates cannot be in the future.';
        if (form.admission_date.value && form.discharge_date.value && form.discharge_date.value < form.admission_date.value)
          return 'Discharge date cannot be before admission date.';
      }
      return '';
    },
    onEnter(step) {
      if (step === 3) renderReview().catch((e) => showError($('#error'), e.message));
    },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!copyType()) return showError($('#error'), 'Please choose hardcopy or digital copy.');
    if (copyType() === 'DIGITAL' && (!photos.id || !photos.selfie)) {
      return showError($('#error'), 'For a digital copy, please add a photo of your valid ID and a selfie holding the ID.');
    }
    if (copyType() === 'DIGITAL' && !photos.receipt) {
      return showError($('#error'), `For a digital copy, please pay ${peso(total())} using the QR code and upload a screenshot of the receipt.`);
    }
    if (!$('#consent').checked) return showError($('#error'), 'Please tick the Data Privacy consent box to continue.');
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    try {
      const d = formData(form);
      const res = await api('/records', {
        method: 'POST',
        body: {
          ...d,
          consent: true,
          items: [...selected].map(([record_type, v]) => ({ record_type, copies: v.copies, details: v.details })),
          ...(copyType() === 'DIGITAL' ? { id_photo: photos.id, selfie_photo: photos.selfie, receipt_photo: photos.receipt } : {}),
        },
      });
      form.classList.add('hidden');
      $('#steps').classList.add('hidden');
      showError($('#error'), '');
      $('#done').classList.remove('hidden');
      $('#done').innerHTML = `
        <h2>Request submitted</h2>
        <p class="muted">Your reference number is</p>
        <div class="ref-no">${esc(res.ref_no)}</div>
        <p>Total payable: <b>${peso(res.amount_due)}</b>${res.copy_type === 'DIGITAL' ? ' (paid online — your receipt will be checked with your ID)' : ''}</p>
        ${res.copy_type === 'DIGITAL'
          ? `<p><b>Digital copy.</b> HHIMS staff will check your ID and selfie, then email your documents to <b>${esc(res.email)}</b> on or after <b>${esc(fmtDate(res.pickup_date))}</b>.<br>
             We sent an SMS to <b>${esc(d.mobile)}</b> and will text you when your ID is verified and when the documents are sent.</p>
             <p class="muted small">If we can't verify your ID, we'll text you the reason and you can upload new photos on the Track page.</p>`
          : `<p>Claiming date: <b>${esc(fmtDate(res.pickup_date))}</b>, 8:00 AM – 5:00 PM (no noon break), at the Hospital Health Information Management Section (HHIMS).<br>
             We sent an SMS to <b>${esc(d.mobile)}</b> and will text you again once your documents are ready.</p>
             <p class="muted small">Please keep this reference number and bring a valid ID when claiming.</p>`}
        ${res.letter_url ? `<div class="alert warn" style="text-align:left">
          <b>Authorization letter</b><br>
          We filled in the hospital's authorization letter with your details. Download and print it, have it <b>signed by the patient and by you</b>, and bring it with both your valid IDs when claiming.
          <div style="margin-top:10px"><a class="btn" href="${esc(res.letter_url)}" download>Download authorization letter (Word)</a></div>
        </div>` : ''}
        <div class="actions" style="justify-content:center">
          <button class="btn secondary" onclick="window.print()">Print</button>
          <a class="btn" href="/">Done</a>
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showError($('#error'), err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit request';
    }
  });
})();
