(async () => {
  const cat = await loadCatalog();
  const form = $('#form');
  const selected = new Map(); // code -> { copies, details }
  let pickupDate = '';

  $('#consentText').textContent = DATA_PRIVACY_TEXT;
  $('#docList').innerHTML = cat.recordTypes
    .map(
      (t) => `
      <div class="doc" data-code="${esc(t.code)}">
        <input type="checkbox" id="doc-${esc(t.code)}">
        <label for="doc-${esc(t.code)}" class="doc-name">${esc(t.name)}</label>
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
    };
    cb.addEventListener('change', sync);
    copies.addEventListener('input', sync);
    details?.addEventListener('input', sync);
  });

  form.requester_relation.addEventListener('change', () => {
    const self = form.requester_relation.value.startsWith('Self');
    $('#repNote').classList.toggle('hidden', !form.requester_relation.value || self);
    if (self && !form.requester_name.value) {
      form.requester_name.value = [form.patient_first.value, form.patient_middle.value, form.patient_last.value].filter(Boolean).join(' ');
    }
  });

  async function loadDates() {
    const grid = $('#dateGrid');
    grid.innerHTML = '<span class="muted">Loading available dates…</span>';
    const { dates } = await api('/records/pickup-dates');
    $('#pickupHint').textContent = `Earliest claiming date is ${fmtDate(dates[0]?.date)}. Claiming hours: 8:00 AM – 5:00 PM.`;
    grid.innerHTML = dates
      .map(
        (d) => `<button type="button" class="chip${d.date === pickupDate ? ' selected' : ''}" data-date="${d.date}" ${d.remaining ? '' : 'disabled'}>
          ${esc(fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' }))}<small>${d.remaining ? `${d.remaining} slots left` : 'Full'}</small></button>`,
      )
      .join('') || '<span class="muted">No pickup dates available. Please try again later.</span>';
    $$('.chip', grid).forEach((b) =>
      b.addEventListener('click', () => {
        pickupDate = b.dataset.date;
        $$('.chip', grid).forEach((x) => x.classList.toggle('selected', x === b));
      }),
    );
  }

  function renderReview() {
    const d = formData(form);
    const items = [...selected].map(([code, v]) => {
      const t = cat.recordTypes.find((x) => x.code === code);
      return `<li>${esc(t.name)}${v.details ? ` — <i>${esc(v.details)}</i>` : ''} <span class="muted">× ${v.copies}</span></li>`;
    });
    $('#review').innerHTML = `
      <dl class="kv">
        <dt>Documents</dt><dd><ul class="list-tight">${items.join('')}</ul></dd>
        <dt>Patient</dt><dd>${esc([d.patient_first, d.patient_middle, d.patient_last].filter(Boolean).join(' '))}</dd>
        <dt>Birthdate</dt><dd>${esc(fmtDate(d.birthdate))}</dd>
        ${d.admission_date ? `<dt>Admission / visit</dt><dd>${esc(fmtDate(d.admission_date))}${d.discharge_date ? ` – ${esc(fmtDate(d.discharge_date))}` : ''}</dd>` : ''}
        <dt>Requested by</dt><dd>${esc(d.requester_name)} (${esc(d.requester_relation)})</dd>
        <dt>Mobile</dt><dd>${esc(d.mobile)}</dd>
        <dt>Purpose</dt><dd>${esc(d.purpose)}</dd>
        <dt>Pickup date</dt><dd>${esc(fmtDate(pickupDate))}</dd>
      </dl>`;
    const reqs = new Set([...selected.keys()].flatMap((c) => cat.recordTypes.find((t) => t.code === c).requirements));
    $('#reqList').innerHTML = [...reqs].map((r) => `<li>${esc(r)}</li>`).join('');
  }

  const wiz = wizard({
    total: 4,
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
      if (step === 3 && !pickupDate) return 'Please choose a pickup date.';
      return '';
    },
    onEnter(step) {
      if (step === 3) loadDates().catch((e) => showError($('#error'), e.message));
      if (step === 4) renderReview();
    },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
          pickup_date: pickupDate,
          items: [...selected].map(([record_type, v]) => ({ record_type, copies: v.copies, details: v.details })),
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
        <p>Pickup date: <b>${esc(fmtDate(res.pickup_date))}</b> at the Medical Records Section.<br>
        We sent an SMS to <b>${esc(d.mobile)}</b> and will text you again once your documents are ready.</p>
        <p class="muted small">Please keep this reference number and bring a valid ID upon pickup.</p>
        <div class="actions" style="justify-content:center">
          <button class="btn secondary" onclick="window.print()">Print</button>
          <a class="btn" href="/">Done</a>
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showError($('#error'), err.message);
      if (/pickup date/i.test(err.message)) wiz.go(3);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit request';
    }
  });
})();
