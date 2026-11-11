// Attendance kiosk: employees time in / time out with their employee number and PIN.
// The time shown is the server's clock (the time that is recorded), not the device's.
(async () => {
  loadCatalog();
  const TZ = 'Asia/Manila';
  let offset = 0; // server time minus device time
  let kiosk = null;
  let stream = null;

  // ---------- Clock ----------
  const tick = () => {
    const now = new Date(Date.now() + offset);
    $('#clockTime').textContent = now.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
    $('#clockDate').textContent = now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  setInterval(tick, 1000);

  async function load() {
    const t0 = Date.now();
    const r = await api('/attendance/kiosk');
    offset = new Date(r.now).getTime() - Math.round((t0 + Date.now()) / 2);
    tick();
    kiosk = r.kiosk;
    $('#notKiosk').classList.toggle('hidden', !!kiosk);
    $('#punchCard').classList.toggle('hidden', !kiosk);
    $('#kioskName').classList.toggle('hidden', !kiosk);
    if (kiosk) {
      $('#kioskName').textContent = `Kiosk: ${kiosk.name}`;
      if (kiosk.require_photo) startCamera();
      $('#punchForm [name=employee_no]').focus();
    }
  }
  // Re-sync the clock every 10 minutes (and notice if the kiosk was removed)
  setInterval(() => load().catch(() => {}), 10 * 60e3);

  // ---------- Camera ----------
  async function startCamera() {
    $('#cam').classList.remove('hidden');
    if (stream) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      $('#video').srcObject = stream;
      $('#camNote').classList.add('hidden');
    } catch {
      $('#camNote').textContent = 'Camera not available. Allow camera access for this site.';
      $('#camNote').classList.remove('hidden');
    }
  }
  function snapshot() {
    const v = $('#video');
    if (!stream || !v.videoWidth) return null;
    const c = $('#snap');
    const ctx = c.getContext('2d');
    // Centre-crop to 4:3
    const ratio = 4 / 3;
    let sw = v.videoWidth;
    let sh = v.videoHeight;
    if (sw / sh > ratio) sw = sh * ratio;
    else sh = sw / ratio;
    ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }

  // ---------- Set up this device ----------
  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      await api('/attendance/kiosk', { method: 'POST', body: { ...d, require_photo: e.target.require_photo.checked } });
      showError($('#setupError'), '');
      e.target.reset();
      await load();
    } catch (err) {
      showError($('#setupError'), err.message);
    }
  });

  // ---------- Time in / out ----------
  let resetTimer;
  const form = $('#punchForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = e.submitter?.value === 'OUT' ? 'OUT' : 'IN';
    const d = formData(form);
    if (!d.employee_no || !d.pin) return showError($('#punchError'), 'Enter your employee no. and PIN.');
    const buttons = $$('button', form);
    buttons.forEach((b) => (b.disabled = true));
    try {
      const r = await api('/attendance/punch', { method: 'POST', body: { employee_no: d.employee_no, pin: d.pin, kind, photo: kiosk?.require_photo ? snapshot() : undefined } });
      showError($('#punchError'), '');
      form.reset();
      showResult(r);
    } catch (err) {
      form.pin.value = '';
      showError($('#punchError'), err.message);
      if (err.status === 401 && /not set up/i.test(err.message)) load();
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });

  function showResult(r) {
    const el = $('#result');
    const hour = Number(new Date(Date.now() + offset).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
    const greet = r.kind === 'IN' ? (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') : 'Thank you';
    el.className = `card punch-result ${r.kind === 'IN' ? 'in' : 'out'}`;
    el.innerHTML = `
      <div class="muted">${esc(greet)},</div>
      <h2>${esc(r.name)}</h2>
      <div class="muted small">${esc(r.employee_no)}</div>
      <p style="margin:14px 0 2px">${r.kind === 'IN' ? 'TIME IN' : 'TIME OUT'} recorded</p>
      <div class="big">${esc(r.time)}</div>
      <div class="muted">${esc(r.date)}</div>
      ${r.duplicate ? '<div class="alert info" style="margin-top:12px">You already did this a moment ago; it was recorded only once.</div>' : ''}
      ${r.late ? `<div class="alert warn" style="margin-top:12px">Late by ${r.late} minute${r.late === 1 ? '' : 's'}.</div>` : ''}
      ${r.warnings.map((w) => `<div class="alert warn" style="margin-top:12px">${esc(w)}</div>`).join('')}
      <button class="btn secondary" type="button" id="doneBtn" style="margin-top:16px">Done</button>`;
    $('#punchCard').classList.add('hidden');
    el.classList.remove('hidden');
    const done = () => {
      clearTimeout(resetTimer);
      el.classList.add('hidden');
      $('#punchCard').classList.remove('hidden');
      form.employee_no.focus();
    };
    $('#doneBtn').addEventListener('click', done);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(done, r.warnings.length || r.late ? 10000 : 6000);
  }

  // ---------- Change PIN ----------
  const pinForm = $('#pinForm');
  const showPinForm = (on) => {
    pinForm.classList.toggle('hidden', !on);
    form.classList.toggle('hidden', on);
    showError($('#pinError'), '');
    pinForm.reset();
    (on ? pinForm.employee_no : form.employee_no).focus();
  };
  $('#pinLink').addEventListener('click', (e) => (e.preventDefault(), showPinForm(true)));
  $('#pinCancel').addEventListener('click', () => showPinForm(false));
  pinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(pinForm);
    if (d.new_pin !== d.new_pin2) return showError($('#pinError'), 'The new PINs do not match.');
    try {
      await api('/attendance/pin', { method: 'POST', body: d });
      showPinForm(false);
      alert('Your PIN was changed.');
    } catch (err) {
      showError($('#pinError'), err.message);
    }
  });

  load().catch((err) => alert(err.message));
})();
