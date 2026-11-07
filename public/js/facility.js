// Referral portal for RHUs, barangay health centers and other hospitals.
(async () => {
  const cat = await loadCatalog();
  let me = null;
  let rows = [];
  const fapi = (path, opts) => api(`/facility${path}`, opts);
  const refBadge = (status, label) => `<span class="badge r-${esc(status)}">${esc(label || status)}</span>`;
  const urgBadge = (u, label) => `<span class="badge u-${esc(u)}">${esc(label || u)}</span>`;

  // ---------- Sign-in ----------
  async function start() {
    try {
      me = await fapi('/me');
    } catch {
      me = null;
    }
    document.body.classList.toggle('signed-in', !!me);
    $('#login').classList.toggle('hidden', !!me);
    $('#app').classList.toggle('hidden', !me);
    $('#whoami').classList.toggle('hidden', !me);
    if (!me) return;
    $('#whoami').innerHTML = `${esc(me.full_name)} · <b>${esc(me.facility.name)}</b>`;
    $('#facilityName').textContent = me.facility.name;
    $('#deptSelect').innerHTML = '<option value="">Select…</option>' + me.departments.map((d) => `<option value="${esc(d.code)}">${esc(d.name)}</option>`).join('');
    $('#urgencyChoice').innerHTML = Object.entries(me.urgency)
      .map(([k, v]) => `<label class="copy-opt"><input type="radio" name="urgency" value="${k}"><span><b>${esc(v)}</b><small>${
        { EMERGENCY: 'Life- or limb-threatening; send to the ER now', URGENT: 'Needs to be seen within 24–48 hours', ROUTINE: 'Can be scheduled (e.g. OPD consultation)' }[k]
      }</small></span></label>`)
      .join('');
    show(location.hash.slice(1) || 'list');
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await fapi('/login', { method: 'POST', body: formData(e.target) });
      e.target.reset();
      showError($('#loginError'), '');
      start();
    } catch (err) {
      showError($('#loginError'), err.message);
    }
  });
  $('#logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    await fapi('/logout', { method: 'POST' });
    start();
  });

  // ---------- Tabs ----------
  function show(name) {
    if (!['list', 'new', 'account'].includes(name)) name = 'list';
    $$('#tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
    history.replaceState(null, '', `#${name}`);
    if (name === 'list') loadList();
    if (name === 'new') resetForm();
  }
  $$('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  document.addEventListener('click', (e) => e.target.closest('[data-goto]') && show(e.target.closest('[data-goto]').dataset.goto));

  // ---------- My referrals ----------
  async function loadList() {
    try {
      rows = (await fapi('/referrals')).rows;
    } catch (err) {
      if (err.status === 401) return start();
      throw err;
    }
    $('#refRows').innerHTML =
      rows
        .map(
          (r) => `<tr>
        <td class="mono">${esc(r.ref_no)}<div class="sub">${esc(r.created_at)}</div></td>
        <td>${esc(r.patient_last)}, ${esc(r.patient_first)}<div class="sub">${esc(r.age)} / ${esc(r.sex)} · ${esc(r.working_diagnosis)}</div></td>
        <td>${urgBadge(r.urgency, r.urgency_label)}</td>
        <td class="small">${esc(r.department_name)}</td>
        <td>${refBadge(r.status, r.status_label)}</td>
        <td class="small">${esc(r.response_note || '')}${r.appt_date ? `<div><b>${esc(fmtDate(r.appt_date))} ${esc(fmtTime(r.appt_time))}</b></div>` : ''}</td>
        <td class="nowrap"><button class="btn sm secondary" data-open="${r.id}">View</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">No referrals yet. Click <b>New referral</b> to send one.</td></tr>';
  }

  function detailHtml(r) {
    const kv = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
    return `<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
        <h2 style="margin:0">Referral <span class="mono">${esc(r.ref_no)}</span></h2><div>${urgBadge(r.urgency, r.urgency_label)} ${refBadge(r.status, r.status_label)}</div></div>
      ${r.status === 'ACCEPTED' || r.status === 'ARRIVED' || r.status === 'SEEN' || r.status === 'REDIRECTED'
        ? `<div class="alert ${r.status === 'REDIRECTED' ? 'warn' : 'ok'}" style="margin-top:12px"><b>ZRMC response:</b> ${esc(r.response_note || r.status_label)}
            ${r.appt_date ? `<br><b>Appointment:</b> ${esc(fmtDate(r.appt_date))} ${esc(fmtTime(r.appt_time))}, ${esc(r.department_name)}` : ''}</div>`
        : ''}
      ${r.feedback ? `<div class="alert info"><b>Return slip from ZRMC:</b><br>${esc(r.feedback)}</div>` : ''}
      <dl class="kv small" style="margin-top:12px">
        ${kv('Patient', `${r.patient_last}, ${r.patient_first} ${r.patient_middle || ''}`)}${kv('Birthdate / age / sex', `${r.birthdate} / ${r.age} / ${r.sex}`)}
        ${kv('Address', r.address)}${kv('Mobile', r.mobile)}${kv('PhilHealth no.', r.philhealth_no)}
        ${kv('Refer to', r.department_name)}${kv('Reason', r.reason)}${kv('Chief complaint', r.chief_complaint)}${kv('History', r.history)}
        ${kv('Vital signs', [['BP', r.bp], ['HR', r.hr], ['RR', r.rr], ['Temp', r.temp], ['O2', r.o2sat], ['Wt', r.weight]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · '))}
        ${kv('Working diagnosis', r.working_diagnosis)}${kv('Treatment given', r.treatment_given)}
        ${kv('Referred by', [r.referring_name, r.referring_designation].filter(Boolean).join(', '))}${kv('Sent', r.created_at)}
      </dl>
      ${r.attachments?.length ? `<p class="small"><b>Attachments:</b> ${r.attachments.map((a) => `<a href="/api/facility/referrals/${r.id}/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.filename)}</a>`).join(' · ')}</p>` : ''}
      <div class="actions">
        ${['SENT', 'RECEIVED'].includes(r.status) ? '<button class="btn danger" type="button" data-cancel>Cancel referral</button>' : ''}
        ${r.status === 'SEEN' ? '<button class="btn secondary" type="button" data-print="return">Print return slip</button>' : ''}
        <button class="btn secondary" type="button" data-print="referral">Print referral slip</button>
        <button class="btn" type="button" data-close>Close</button>
      </div>`;
  }

  async function openDetail(id) {
    const r = await fapi(`/referrals/${id}`);
    const dlg = $('#dlg');
    $('#dlgBody').innerHTML = detailHtml(r);
    $('#dlgBody').onclick = async (e) => {
      if (e.target.closest('[data-close]')) return dlg.close();
      const p = e.target.closest('[data-print]');
      if (p) return printReferral(r, { kind: p.dataset.print, systemName: cat.systemName, hospitalName: cat.hospitalName });
      if (e.target.closest('[data-cancel]') && confirm('Cancel this referral?')) {
        try {
          await fapi(`/referrals/${id}/cancel`, { method: 'POST', body: {} });
          dlg.close();
          loadList();
        } catch (err) {
          alert(err.message);
        }
      }
    };
    dlg.showModal();
  }
  $('#refRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openDetail(Number(b.dataset.open)).catch((err) => alert(err.message));
  });

  // ---------- New referral ----------
  let attachments = []; // { name, data, size }
  const MAX_TOTAL = 3 * 1024 * 1024;
  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('That file could not be read.'));
      r.readAsDataURL(file);
    });
  const sizeOf = (dataUrl) => Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  function drawAttachments() {
    const total = attachments.reduce((s, a) => s + a.size, 0);
    $('#attachList').innerHTML =
      attachments.map((a, i) => `<li>${esc(a.name)} <span class="muted">(${Math.round(a.size / 1024)} KB)</span> <button type="button" class="btn sm secondary" data-remove="${i}">Remove</button></li>`).join('') +
      (attachments.length ? `<li class="muted">Total ${total < 1048576 ? `${Math.round(total / 1024)} KB` : `${(total / 1048576).toFixed(1)} MB`} of 3 MB</li>` : '');
  }
  $('#attachInput').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      if (attachments.length >= 5) {
        showError($('#refError'), 'You can attach up to 5 files.');
        break;
      }
      try {
        // Photos are shrunk before upload; PDFs are sent as they are
        const data = file.type === 'application/pdf' ? await readAsDataUrl(file) : await photoToDataUrl(file, 1800);
        const size = sizeOf(data);
        if (attachments.reduce((s, a) => s + a.size, 0) + size > MAX_TOTAL) {
          showError($('#refError'), `"${file.name}" would go over the 3 MB limit. Attach a smaller file (or a photo instead of a large PDF).`);
          continue;
        }
        attachments.push({ name: file.name.replace(/\.(heic|heif|png|webp)$/i, '.jpg'), data, size });
      } catch (err) {
        showError($('#refError'), err.message);
      }
    }
    e.target.value = '';
    drawAttachments();
  });
  $('#attachList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    attachments.splice(Number(b.dataset.remove), 1);
    drawAttachments();
  });

  function resetForm() {
    $('#refForm').classList.remove('hidden');
    $('#refDone').classList.add('hidden');
    showError($('#refError'), '');
  }

  $('#refForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const missing = $$('[required]', form).filter((el) => !el.value.trim());
    if (!form.querySelector('[name=urgency]:checked')) return showError($('#refError'), 'Please choose the urgency.');
    if (missing.length) {
      const names = missing.map((el) => el.closest('label')?.querySelector('span')?.textContent || el.name);
      return showError($('#refError'), `Please fill in: ${names.join(', ')}`);
    }
    if (!$('#refConsent').checked) return showError($('#refError'), "Please confirm the patient's consent to the referral.");
    const btn = $('#refSubmit');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const r = await fapi('/referrals', { method: 'POST', body: { ...formData(form), attachments: attachments.map(({ name, data }) => ({ name, data })) } });
      form.reset();
      attachments = [];
      drawAttachments();
      form.classList.add('hidden');
      showError($('#refError'), '');
      const done = $('#refDone');
      done.classList.remove('hidden');
      done.innerHTML = `<h2>Referral sent to ZRMC</h2><p class="muted">Referral number</p><div class="ref-no">${esc(r.ref_no)}</div>
        <p>ZRMC will review it and respond here${r.urgency === 'EMERGENCY' ? '. <b>For emergencies, send the patient to the ZRMC Emergency Room now</b> with the printed referral slip' : ''}.</p>
        <div class="actions" style="justify-content:center"><button class="btn secondary" type="button" id="printNew">Print referral slip</button><button class="btn" type="button" data-goto="list">Back to my referrals</button></div>`;
      $('#printNew').onclick = () => printReferral(r, { systemName: cat.systemName, hospitalName: cat.hospitalName });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (err.status === 401) return start();
      showError($('#refError'), err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send referral to ZRMC';
    }
  });

  // ---------- Account ----------
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await fapi('/password', { method: 'POST', body: formData(e.target) });
      e.target.reset();
      $('#pwResult').textContent = 'Password updated.';
    } catch (err) {
      $('#pwResult').textContent = err.message;
    }
  });

  start();
})();
