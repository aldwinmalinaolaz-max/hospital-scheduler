// Flag Ceremony check-in on the employee's own phone (/flag-ceremony)
(async () => {
  loadCatalog().catch(() => {});
  const STATUS_CLASS = { ON_TIME: 'ok', EXCUSED: 'info', ABSENT: 'bad' };
  let me = null;
  let pos = null; // latest GPS reading
  let watchId = null;
  let selfie = null;
  let refreshTimer = null;

  const distM = (a, b) => {
    const R = 6371000;
    const rad = (x) => (x * Math.PI) / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
  };
  const show = (id, on) => $(id).classList.toggle('hidden', !on);
  const pill = (s, label) => `<span class="flag-pill ${STATUS_CLASS[s] || ''}">${esc(label)}</span>`;
  const when = (c) => `${fmtDate(c.date, { weekday: 'long', month: 'long', day: 'numeric' })}`;
  // Staff notes (e.g. bad weather) and date changes (e.g. holiday)
  const notes = (c) =>
    `${c.moved_from_date ? `<p class="small flag-moved">📅 Moved from ${esc(fmtDate(c.moved_from_date, { weekday: 'long', month: 'long', day: 'numeric' }))}</p>` : ''}${c.remarks ? `<div class="alert warn small flag-note">📝 ${esc(c.remarks)}</div>` : ''}`;
  const times = (c) => `Check-in ${fmtTime(c.opens)} – ${fmtTime(c.closes)} · Ceremony starts ${fmtTime(c.starts)}`;

  async function load() {
    clearTimeout(refreshTimer);
    show('#flagLoading', !me);
    try {
      me = await api('/flag/me');
    } catch (err) {
      $('#flagLoading').textContent = err.message;
      return;
    }
    show('#flagLoading', false);
    show('#notReady', !me.ready);
    show('#signIn', !me.employee);
    show('#signedIn', !!me.employee);
    if (!me.employee) return stopGps();
    $('#empName').textContent = me.employee.name;
    $('#empMeta').textContent = [me.employee.employee_no, me.employee.division, me.employee.unit].filter(Boolean).join(' · ');
    renderToday();
    renderHistory();
    // Keep the page current (check-in opening and closing) while it stays open
    refreshTimer = setTimeout(load, 60e3);
  }

  function renderToday() {
    const box = $('#todayBox');
    const open = me.today_ceremonies.find((c) => c.phase === 'OPEN' && !c.mine);
    const cards = me.today_ceremonies.map((c) => {
      if (c.phase === 'CANCELLED') {
        return `<section class="card flag-today"><h2>${esc(c.title)}</h2><p class="muted">${esc(when(c))}</p>
          <div class="alert info">${c.moved_to_date
            ? `Moved to <b>${esc(fmtDate(c.moved_to_date, { weekday: 'long', month: 'long', day: 'numeric' }))}</b>${c.cancel_reason ? ` (${esc(c.cancel_reason)})` : ''}.`
            : `Cancelled today${c.cancel_reason ? `: ${esc(c.cancel_reason)}` : ''}.`}</div></section>`;
      }
      if (c.mine) {
        const m = c.mine;
        return `<section class="card flag-today flag-done ${STATUS_CLASS[m.status]}">
          <div class="flag-check" aria-hidden="true">✓</div>
          <h2>${m.status === 'EXCUSED' ? 'Excused' : 'You are checked in'}</h2>
          <p><b>${esc(c.title)}</b><br>${esc(when(c))}</p>${notes(c)}
          ${m.status === 'EXCUSED' ? `<p class="muted">${esc(m.remarks || '')}</p>` : `<p class="big">${fmtTime(m.time)}</p>${pill(m.status, m.label)}`}
          ${m.source === 'MANUAL' && m.status !== 'EXCUSED' ? '<p class="muted small">Recorded by HR.</p>' : ''}
        </section>`;
      }
      if (c.phase === 'UPCOMING') {
        return `<section class="card flag-today"><h2>${esc(c.title)}</h2><p class="muted">Today · ${esc(times(c))}</p>${notes(c)}
          <div class="alert info">Check-in opens at <b>${fmtTime(c.opens)}</b>. Come back to this page at the venue.</div></section>`;
      }
      // OPEN and not yet checked in
      return `<section class="card flag-today" data-open="${c.id}">
        <h2>${esc(c.title)}</h2>
        <p class="muted">Today · ${esc(times(c))}</p>${notes(c)}
        <div class="flag-gps" id="gpsBox" aria-live="polite"><span class="muted">Finding your location…</span></div>
        ${me.require_selfie ? `<div class="flag-selfie"><img id="selfiePreview" class="hidden" alt="Your selfie"><button class="btn secondary" type="button" id="selfieBtn">📷 Take a selfie at the venue</button></div>` : ''}
        <div class="alert error hidden" id="checkError" role="alert"></div>
        <button class="btn flag-btn" type="button" id="checkBtn" data-id="${c.id}">CHECK IN</button>
        <p class="muted small" style="margin:8px 0 0">Allow this site to use your location when asked. Check-in closes at ${fmtTime(c.closes)}.</p>
      </section>`;
    });
    if (!cards.length) {
      const next = me.next[0];
      cards.push(`<section class="card flag-today"><h2>No flag ceremony today</h2>
        ${next ? `<p>Next: <b>${esc(next.title)}</b><br>${esc(when(next))}<br><span class="muted">${esc(times(next))}</span></p>${notes(next)}` : '<p class="muted">No upcoming ceremony is scheduled yet.</p>'}
      </section>`);
    } else if (me.next[0] && me.today_ceremonies.every((c) => c.mine || c.phase === 'CANCELLED')) {
      const next = me.next[0];
      cards.push(`<p class="muted small" style="text-align:center">Next: ${esc(next.title)} · ${esc(when(next))} · ${fmtTime(next.starts)}</p>`);
    }
    if (!me.employee.flag_required) cards.unshift('<div class="alert info small">HR has marked you as not required to attend flag ceremonies, but you can still check in when you attend.</div>');
    box.innerHTML = cards.join('');
    if (open && me.ready) {
      startGps();
      $('#checkBtn').addEventListener('click', checkIn);
      $('#selfieBtn')?.addEventListener('click', () => $('#selfieInput').click());
    } else stopGps();
  }

  function renderHistory() {
    $('#historyBox').innerHTML = me.history.length
      ? `<ul class="flag-history">${me.history
          .map((c) => `<li><span>${esc(fmtDate(c.date, { month: 'short', day: 'numeric', year: 'numeric' }))}<span class="sub">${esc(c.title)}${c.mine.time ? ` · ${fmtTime(c.mine.time)}` : ''}</span></span>${pill(c.mine.status, c.mine.label)}</li>`)
          .join('')}</ul>`
      : '<p class="muted">No past ceremonies yet.</p>';
  }

  // ---------- GPS ----------
  function gpsMessage(text, cls = '') {
    const box = $('#gpsBox');
    if (box) box.innerHTML = `<span class="${cls}">${text}</span>`;
  }
  function renderPos() {
    if (!pos || !me.center) return;
    const d = distM(me.center, pos);
    const acc = Math.round(pos.accuracy);
    const inside = d <= me.radius_m;
    const precise = acc <= me.max_accuracy_m;
    gpsMessage(
      `<b>${inside ? '📍 You are at the venue' : '📍 You are not at the venue yet'}</b><br>
       About ${d.toLocaleString('en-US')} m from ${esc(me.venue)} (GPS ±${acc} m)
       ${!precise ? '<br><span class="warn-text">Location is not precise enough yet — step outdoors and wait a few seconds.</span>' : ''}
       ${precise && !inside ? `<br><span class="warn-text">Check-in works within ${me.radius_m} m of the venue.</span>` : ''}`,
      inside && precise ? 'ok-text' : '',
    );
  }
  function gpsError(err) {
    const msg = {
      1: 'Location permission is blocked. Allow location for this site in your browser settings (tap the lock icon beside the address), then reload this page.',
      2: 'Your location is not available. Turn on Location (GPS) on your phone and try again.',
      3: 'Finding your location is taking too long. Step outdoors, check that Location is on, and try again.',
    }[err.code] || 'Your location could not be read.';
    gpsMessage(esc(msg), 'warn-text');
  }
  function startGps() {
    if (!('geolocation' in navigator) || !window.isSecureContext) {
      return gpsMessage('This browser cannot share your location. Open this page in Chrome or Safari on your phone.', 'warn-text');
    }
    if (watchId !== null) return renderPos();
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        renderPos();
      },
      gpsError,
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    pos = null;
  }
  // A fresh reading just for the check-in, so an old position is never sent
  const freshPosition = () =>
    new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        reject,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      ),
    );

  $('#selfieInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      selfie = await photoToDataUrl(file, 800);
      const img = $('#selfiePreview');
      img.src = selfie;
      img.classList.remove('hidden');
      $('#selfieBtn').textContent = '📷 Retake selfie';
    } catch (err) {
      showError($('#checkError'), err.message);
    }
  });

  async function checkIn(e) {
    const btn = e.currentTarget;
    const errBox = $('#checkError');
    showError(errBox, '');
    if (me.require_selfie && !selfie) return showError(errBox, 'Please take a selfie at the venue first.');
    btn.disabled = true;
    btn.textContent = 'Checking your location…';
    try {
      let reading;
      try {
        reading = await freshPosition();
      } catch (err) {
        if (!pos) throw Object.assign(new Error(''), { geo: err });
        reading = pos; // the live reading from a moment ago
      }
      pos = reading;
      renderPos();
      btn.textContent = 'Checking in…';
      await api('/flag/checkin', { method: 'POST', body: { ceremony_id: Number(btn.dataset.id), ...reading, photo: selfie || undefined } });
      selfie = null;
      stopGps();
      await load();
    } catch (err) {
      if (err.geo) gpsError(err.geo);
      else if (err.status === 401) return load();
      showError(errBox, err.geo ? 'Your location could not be read. See the message above.' : err.message);
      btn.disabled = false;
      btn.textContent = 'CHECK IN';
    }
  }

  // ---------- Sign in / out, PIN ----------
  $('#signInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.employee_no || !d.pin) return showError($('#signInError'), 'Enter your employee no. and PIN.');
    try {
      await api('/flag/login', { method: 'POST', body: d });
      e.target.reset();
      showError($('#signInError'), '');
      me = null;
      load();
    } catch (err) {
      showError($('#signInError'), err.message);
    }
  });
  $('#signOut').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/flag/logout', { method: 'POST' });
    stopGps();
    load();
  });
  $('#pinLink').addEventListener('click', (e) => {
    e.preventDefault();
    show('#pinCard', true);
    $('#pinCard').scrollIntoView({ behavior: 'smooth' });
  });
  $('#pinCancel').addEventListener('click', () => ($('#pinForm').reset(), show('#pinCard', false)));
  $('#pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.new_pin !== d.new_pin2) return showError($('#pinError'), 'The new PINs do not match.');
    try {
      await api('/flag/pin', { method: 'POST', body: { pin: d.pin, new_pin: d.new_pin } });
      e.target.reset();
      showError($('#pinError'), '');
      show('#pinCard', false);
      alert('Your PIN has been changed.');
    } catch (err) {
      if (err.status === 401 && /sign in/i.test(err.message)) return load();
      showError($('#pinError'), err.message);
    }
  });

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && me?.employee && load());
  load();
})();
