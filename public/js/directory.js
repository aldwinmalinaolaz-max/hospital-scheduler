(async () => {
  const ICON = {
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
  };
  const linkOut = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  // Only numbers with enough digits are made tappable (e.g. not "Local 101")
  const telLink = (phone) => {
    const digits = phone.replace(/[^\d+]/g, '');
    return digits.replace(/\D/g, '').length >= 7 ? `<a href="tel:${esc(digits)}">${esc(phone)}</a>` : esc(phone);
  };
  // Schedules with several parts ("…; Saturdays …") read better one part per line
  const multiline = (t) => esc(t).replace(/; /g, '<br>');
  const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);

  loadCatalog();
  let data;
  try {
    data = await api('/directory');
  } catch (err) {
    $('#dirList').innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    return;
  }
  const { entries, guides, maps, contact, clinics } = data;
  const mapById = new Map(maps.map((m) => [m.id, m]));
  const entryById = new Map(entries.map((e) => [e.id, e]));

  if (contact.notice) {
    $('#notice').textContent = contact.notice;
    $('#notice').classList.remove('hidden');
  }

  // ---------- Directory ----------
  const clinicByCode = new Map(clinics.map((c) => [c.code, c]));
  const categories = [...new Set(entries.map((e) => e.category))];
  let activeCat = '';
  $('#dirCats').innerHTML = ['', ...categories]
    .map((c) => `<button type="button" class="chip-filter${c === '' ? ' on' : ''}" data-cat="${esc(c)}" aria-pressed="${c === ''}">${esc(c || 'All')}</button>`)
    .join('');

  const hasPin = (e) => e.map_id && mapById.has(e.map_id) && e.pin_x !== null;

  function entryCard(e) {
    const clinic = e.opd_code && clinicByCode.get(e.opd_code);
    const hours = e.hours || (clinic ? `${clinic.days}, ${clinic.hours}` : '');
    const services = lines(e.services);
    return `<article class="card dir-card" id="place-${e.id}">
      <div class="dir-card-head"><h3>${esc(e.name)}</h3><span class="badge">${esc(e.category)}</span></div>
      ${e.description ? `<p class="muted small">${esc(e.description)}</p>` : ''}
      <ul class="dir-facts">
        ${e.location ? `<li>${ICON.pin}<span>${esc(e.location)}</span></li>` : ''}
        ${hours ? `<li>${ICON.clock}<span>${multiline(hours)}</span></li>` : ''}
        ${e.phone ? `<li>${ICON.phone}<span>${telLink(e.phone)}</span></li>` : ''}
        ${e.email ? `<li>${ICON.mail}<span><a href="mailto:${esc(e.email)}">${esc(e.email)}</a></span></li>` : ''}
      </ul>
      ${services.length ? `<details class="dir-services"><summary>Services (${services.length})</summary><ul class="list-tight">${services.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      <div class="dir-actions">
        ${hasPin(e) ? `<button type="button" class="btn sm" data-show-map="${e.id}">${ICON.pin} Show on map</button>` : ''}
        ${clinic ? `<a class="btn sm secondary" href="/book-opd?department=${encodeURIComponent(e.opd_code)}">Book appointment</a>` : ''}
        ${e.category === 'Office' && /records|hhims|health information/i.test(e.name) ? '<a class="btn sm secondary" href="/request-records">Request records</a>' : ''}
      </div>
    </article>`;
  }

  function renderList() {
    const q = $('#dirSearch').value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const shown = entries.filter((e) => {
      if (activeCat && e.category !== activeCat) return false;
      const hay = [e.name, e.category, e.description, e.location, e.services, e.keywords].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    $('#dirList').innerHTML = shown.length
      ? shown.map(entryCard).join('')
      : `<p class="muted">Nothing found${q ? ` for “${esc(q)}”` : ''}. Try another word, or ask at the information desk.</p>`;
  }
  $('#dirSearch').addEventListener('input', renderList);
  $('#dirCats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    activeCat = b.dataset.cat;
    $$('#dirCats [data-cat]').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderList();
  });
  const preset = new URLSearchParams(location.search).get('q');
  if (preset) $('#dirSearch').value = preset;
  renderList();

  // ---------- Schedules ----------
  $('#clinicRows').innerHTML = clinics
    .map(
      (c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.days)}</td><td class="nowrap">${esc(c.hours)}</td>
        <td><a class="btn sm secondary" href="/book-opd?department=${encodeURIComponent(c.code)}">Book</a></td></tr>`,
    )
    .join('');
  const offices = entries.filter((e) => e.hours && !e.opd_code);
  if (offices.length) $('#officeRows').innerHTML = offices.map((e) => `<tr><td>${esc(e.name)}</td><td>${multiline(e.hours)}</td></tr>`).join('');
  else $('#officeHoursCard').classList.add('hidden');

  // ---------- Requirements ----------
  $('#guideList').innerHTML =
    guides
      .map((g) => {
        const steps = lines(g.steps);
        const reqs = lines(g.requirements);
        const office = g.office_id && entryById.get(g.office_id);
        return `<details class="card guide">
          <summary><b>${esc(g.title)}</b>${g.summary ? `<span class="muted small">${esc(g.summary)}</span>` : ''}</summary>
          ${reqs.length ? `<h4>What to bring</h4><ul class="checklist">${reqs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
          ${steps.length ? `<h4>Steps</h4><ol>${steps.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>` : ''}
          ${office ? `<p class="small"><b>Where:</b> ${esc(office.name)}${office.location ? ` — ${esc(office.location)}` : ''}</p>` : ''}
          <div class="dir-actions">
            ${g.link_url ? `<a class="btn sm" href="${esc(g.link_url)}"${/^https:/i.test(g.link_url) ? ' target="_blank" rel="noopener"' : ''}>${esc(g.link_label || 'Open')}</a>` : ''}
            ${office && hasPin(office) ? `<button type="button" class="btn sm secondary" data-show-map="${office.id}">${ICON.pin} Show on map</button>` : ''}
          </div>
        </details>`;
      })
      .join('') || '<p class="muted">No guides posted yet.</p>';

  // ---------- Contact ----------
  const rows = [
    ['Address', contact.address && esc(contact.address)],
    ['Trunk line', contact.trunk_line && telLink(contact.trunk_line)],
    ['Emergency hotline', contact.emergency_phone && telLink(contact.emergency_phone)],
    ['HHIMS', contact.records_phone && telLink(contact.records_phone)],
    ['OPD', contact.opd_phone && telLink(contact.opd_phone)],
    ['Email', contact.email && `<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`],
    ['Visiting hours', contact.visiting_hours && esc(contact.visiting_hours)],
    ['Facebook', contact.facebook && linkOut(contact.facebook, 'Facebook page')],
    ['Website', contact.website && linkOut(contact.website, contact.website.replace(/^https:\/\//, ''))],
  ].filter(([, v]) => v);
  const mapsQuery = contact.map_query || contact.address;
  $('#contactCard').innerHTML = rows.length || mapsQuery
    ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
       ${mapsQuery ? `<div class="dir-actions" style="margin-top:14px"><a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}">${ICON.pin} Open in Google Maps</a></div>` : ''}`
    : '<p class="muted">Contact details will be posted soon. For emergencies, go directly to the Emergency Room.</p>';

  // ---------- Maps ----------
  const placesOn = (mapId) => entries.filter((e) => e.map_id === mapId && e.pin_x !== null);
  $('#mapGrid').innerHTML =
    maps
      .map(
        (m) => `<button type="button" class="card map-card" data-open-map="${m.id}">
          <img src="${esc(m.url)}" alt="" loading="lazy">
          <b>${esc(m.title)}</b>${m.description ? `<span class="muted small">${esc(m.description)}</span>` : ''}
          <span class="small" style="color:var(--primary)">${placesOn(m.id).length} marked place(s) · Tap to open</span>
        </button>`,
      )
      .join('') || '<p class="muted">Maps will be posted soon. Please ask at the information desk for directions.</p>';

  const viewer = $('#mapViewer');
  let zoom = 1;
  function setZoom(z) {
    zoom = Math.min(4, Math.max(1, z));
    $('#mapCanvas').style.width = `${zoom * 100}%`;
  }
  function highlight(entryId) {
    $$('#mapCanvas .mv-pin').forEach((p) => p.classList.toggle('on', p.dataset.id === String(entryId)));
    $$('#mapPlaces [data-place]').forEach((p) => p.classList.toggle('on', p.dataset.place === String(entryId)));
    const pin = $(`#mapCanvas .mv-pin[data-id="${entryId}"]`);
    if (pin) {
      if (zoom < 2) setZoom(2);
      requestAnimationFrame(() => pin.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }));
    }
  }
  function openMap(mapId, entryId = null) {
    const m = mapById.get(mapId);
    if (!m) return;
    const places = placesOn(mapId);
    $('#mapTitle').textContent = m.title;
    $('#mapSub').textContent = m.description || '';
    $('#mapImg').src = m.url;
    $('#mapImg').alt = `Map: ${m.title}`;
    $$('#mapCanvas .mv-pin').forEach((p) => p.remove());
    places.forEach((p, i) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'mv-pin';
      pin.dataset.id = p.id;
      pin.style.left = `${p.pin_x}%`;
      pin.style.top = `${p.pin_y}%`;
      pin.textContent = i + 1;
      pin.title = p.name;
      pin.setAttribute('aria-label', p.name);
      pin.addEventListener('click', () => highlight(p.id));
      $('#mapCanvas').appendChild(pin);
    });
    $('#mapPlaces').innerHTML = places.length
      ? places.map((p, i) => `<button type="button" data-place="${p.id}"><span>${i + 1}</span>${esc(p.name)}</button>`).join('')
      : '<p class="muted small">No places are marked on this map yet.</p>';
    setZoom(1);
    viewer.showModal();
    if (entryId) {
      const go = () => highlight(entryId);
      $('#mapImg').complete ? go() : $('#mapImg').addEventListener('load', go, { once: true });
    }
  }
  document.addEventListener('click', (e) => {
    const show = e.target.closest('[data-show-map]');
    if (show) {
      const entry = entryById.get(Number(show.dataset.showMap));
      return openMap(entry.map_id, entry.id);
    }
    const open = e.target.closest('[data-open-map]');
    if (open) return openMap(Number(open.dataset.openMap));
    const place = e.target.closest('#mapPlaces [data-place]');
    if (place) highlight(Number(place.dataset.place));
  });
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(zoom + Number(b.dataset.zoom))));
  $('#mapClose').addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', (e) => e.target === viewer && viewer.close());

  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
