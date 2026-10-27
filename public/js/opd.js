(async () => {
  const cat = await loadCatalog();
  const form = $('#form');
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let date = '';
  let time = '';

  $('#consentText').textContent = DATA_PRIVACY_TEXT;
  const deptSel = $('#department');
  deptSel.innerHTML = '<option value="">Select a clinic…</option>' + cat.departments.map((d) => `<option value="${esc(d.code)}">${esc(d.name)}</option>`).join('');
  const preset = new URLSearchParams(location.search).get('department');
  if (preset) deptSel.value = preset;

  async function loadDates() {
    date = '';
    time = '';
    $('#slotPicker').classList.add('hidden');
    const dept = cat.departments.find((d) => d.code === deptSel.value);
    $('#clinicDays').textContent = dept ? `Clinic days: ${dept.days.map((d) => DAY_NAMES[d]).join(', ')}` : '';
    $('#datePicker').classList.toggle('hidden', !dept);
    if (!dept) return;
    const grid = $('#dateGrid');
    grid.innerHTML = '<span class="muted">Loading…</span>';
    const { dates } = await api(`/opd/dates?department=${encodeURIComponent(dept.code)}`);
    grid.innerHTML =
      dates
        .map(
          (d) => `<button type="button" class="chip" data-date="${d.date}" ${d.remaining ? '' : 'disabled'}>
          ${esc(fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' }))}<small>${d.remaining ? `${d.remaining} open` : 'Full'}</small></button>`,
        )
        .join('') || '<span class="muted">No available dates for this clinic in the next few weeks.</span>';
    $$('.chip', grid).forEach((b) =>
      b.addEventListener('click', () => {
        date = b.dataset.date;
        $$('.chip', grid).forEach((x) => x.classList.toggle('selected', x === b));
        loadSlots().catch((e) => showError($('#error'), e.message));
      }),
    );
  }

  async function loadSlots() {
    time = '';
    const grid = $('#slotGrid');
    $('#slotPicker').classList.remove('hidden');
    grid.innerHTML = '<span class="muted">Loading…</span>';
    const { slots } = await api(`/opd/slots?department=${encodeURIComponent(deptSel.value)}&date=${date}`);
    grid.innerHTML =
      slots
        .map(
          (s) => `<button type="button" class="chip" data-time="${s.time}" ${s.remaining ? '' : 'disabled'}>
          ${esc(s.label)}<small>${s.remaining ? `${s.remaining} left` : 'Full'}</small></button>`,
        )
        .join('') || '<span class="muted">No time slots left on this date.</span>';
    $$('.chip', grid).forEach((b) =>
      b.addEventListener('click', () => {
        time = b.dataset.time;
        $$('.chip', grid).forEach((x) => x.classList.toggle('selected', x === b));
      }),
    );
  }

  deptSel.addEventListener('change', () => loadDates().catch((e) => showError($('#error'), e.message)));
  if (deptSel.value) loadDates();

  const wiz = wizard({
    total: 3,
    validate(step) {
      if (step === 1) {
        if (!deptSel.value) return 'Please select a clinic.';
        if (!date) return 'Please choose a date.';
        if (!time) return 'Please choose a time slot.';
      }
      if (step === 2) {
        const miss = requiredMissing($('[data-panel="2"]'));
        if (miss) return miss;
        if (!checkMobile(form.mobile.value)) return 'Please enter a valid mobile number (e.g. 09171234567).';
        if (!checkPastDate(form.birthdate.value)) return 'Birthdate cannot be in the future.';
      }
      return '';
    },
    onEnter(step) {
      if (step !== 3) return;
      const d = formData(form);
      $('#review').innerHTML = `
        <dl class="kv">
          <dt>Clinic</dt><dd>${esc(deptSel.selectedOptions[0].textContent)}</dd>
          <dt>Schedule</dt><dd>${esc(fmtDate(date))}, ${esc(fmtTime(time))}</dd>
          <dt>Patient</dt><dd>${esc([d.patient_first, d.patient_middle, d.patient_last].filter(Boolean).join(' '))} (${d.patient_type === 'NEW' ? 'New' : 'Returning'})</dd>
          <dt>Birthdate</dt><dd>${esc(fmtDate(d.birthdate))}</dd>
          <dt>Mobile</dt><dd>${esc(d.mobile)}</dd>
          <dt>Reason</dt><dd>${esc(d.complaint)}</dd>
        </dl>`;
    },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('#consent').checked) return showError($('#error'), 'Please tick the Data Privacy consent box to continue.');
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    try {
      const d = formData(form);
      const res = await api('/appointments', { method: 'POST', body: { ...d, appt_date: date, appt_time: time, consent: true } });
      form.classList.add('hidden');
      $('#steps').classList.add('hidden');
      showError($('#error'), '');
      $('#done').classList.remove('hidden');
      $('#done').innerHTML = `
        <h2>Appointment booked</h2>
        <p class="muted">Your reference number is</p>
        <div class="ref-no">${esc(res.ref_no)}</div>
        <dl class="kv" style="max-width:380px;margin:0 auto 16px">
          <dt>Clinic</dt><dd>${esc(res.department)}</dd>
          <dt>Date</dt><dd>${esc(fmtDate(res.appt_date))}</dd>
          <dt>Time</dt><dd>${esc(res.appt_time_label)}</dd>
        </dl>
        <p>A confirmation SMS was sent to <b>${esc(d.mobile)}</b>. We'll remind you the day before and a few hours before your appointment.</p>
        <p class="muted small">Please arrive 15 minutes early and bring a valid ID${d.patient_type === 'OLD' ? ' and your OPD card' : ''}.</p>
        <div class="actions" style="justify-content:center">
          <button class="btn secondary" onclick="window.print()">Print</button>
          <a class="btn" href="/">Done</a>
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showError($('#error'), err.message);
      if (/slot|schedule|date/i.test(err.message)) {
        wiz.go(1);
        showError($('#error'), err.message);
        loadDates();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm booking';
    }
  });
})();
