(async () => {
  const cat = await loadCatalog();
  const REC_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'RELEASED', 'REJECTED', 'CANCELLED'];
  const APPT_STATUSES = ['BOOKED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];
  const opts = (list, sel, labels = STATUS_LABELS) =>
    list.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(labels[v] || v)}</option>`).join('');
  const typeName = (code) => cat.recordTypes.find((t) => t.code === code)?.name || code;
  const debounce = (fn, ms = 250) => {
    let t;
    return (...a) => (clearTimeout(t), (t = setTimeout(() => fn(...a), ms)));
  };

  // ---------- Auth ----------
  let me = null;
  async function start() {
    try {
      me = await api('/admin/me');
      document.body.classList.add('signed-in');
      document.body.classList.toggle('is-admin', me.role === 'ADMIN');
      document.body.classList.toggle('can-records', me.access.records);
      document.body.classList.toggle('can-opd', me.access.opd);
      document.body.classList.toggle('can-referrals', me.access.referrals);
      document.body.classList.toggle('can-attendance', me.access.attendance);
      document.body.classList.toggle('can-flag-scan', !!me.access.flag_scan);
      $('#whoami').innerHTML = `${esc(me.full_name || me.username)} · <b>${me.role === 'ADMIN' ? 'Administrator' : 'Staff'}</b>`;
      $('#whoami').classList.remove('hidden');
      $('#login').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#logoutBtn').classList.remove('hidden');
      showTab(location.hash.slice(1) || 'dashboard');
    } catch {
      me = null;
      document.body.classList.remove('signed-in', 'is-admin', 'can-records', 'can-opd', 'can-referrals', 'can-attendance', 'can-flag-scan');
      $('#whoami').classList.add('hidden');
      $('#login').classList.remove('hidden');
      $('#app').classList.add('hidden');
      $('#logoutBtn').classList.add('hidden');
    }
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/login', { method: 'POST', body: formData(e.target) });
      showError($('#loginError'), '');
      e.target.reset();
      start();
    } catch (err) {
      showError($('#loginError'), err.message);
    }
  });
  $('#logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/admin/logout', { method: 'POST' });
    start();
  });
  // Any 401 later → back to login
  const guard = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (err) {
      if (err.status === 401) return start();
      alert(err.message);
    }
  };

  // ---------- Tabs ----------
  const loaders = {};
  function showTab(name) {
    const allowed = { flag: me?.access.attendance, referrals: me?.access.referrals, schedules: me?.access.opd, users: me?.role === 'ADMIN', faqs: me?.role === 'ADMIN', directory: me?.role === 'ADMIN', records: me?.access.records, appointments: me?.access.opd };
    if (!loaders[name] || allowed[name] === false) name = 'dashboard';
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
    history.replaceState(null, '', `#${name}`);
    loaders[name]();
  }
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  const updatedBy = (row) => (row.updated_by ? `<div class="sub">by ${esc(row.updated_by)} · ${esc(row.updated_at)}</div>` : '');

  // ---------- Dashboard ----------
  loaders.dashboard = guard(async () => {
    const s = await api('/admin/stats');
    const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    $('#stats').innerHTML = [
      me.access.opd && stat(s.appointmentsToday, 'OPD appointments today'),
      me.access.opd && stat(s.checkedInToday, 'Checked in / seen today'),
      me.access.opd && stat(s.upcomingAppointments, 'Upcoming appointments'),
      me.access.records && stat(s.recordsPending, 'Records pending / processing'),
      me.access.records && stat(s.recordsReady, 'Records ready for claiming'),
      me.access.records && stat(s.idsToCheck, 'Digital copies: IDs to check'),
      me.access.referrals && stat(s.referralsOpen, `Referrals waiting${s.referralsEmergency ? ` (${s.referralsEmergency} emergency)` : ''}`),
      stat(s.smsFailed, `Failed SMS (7 days) · ${esc(s.smsProvider)}`),
    ]
      .filter(Boolean)
      .join('');
    const none = { rows: [] };
    const [{ rows: appts }, { rows: recs }] = await Promise.all([
      me.access.opd ? api(`/admin/appointments?date=${s.today}`) : none,
      me.access.records ? api(`/admin/records?pickup_date=${s.today}`) : none,
    ]);
    const active = appts.filter((a) => a.status !== 'CANCELLED');
    $('#dashAppts').innerHTML = active.length
      ? `<table><tbody>${active.map((a) => `<tr><td class="nowrap">${fmtTime(a.appt_time)}</td><td>${esc(a.patient_last)}, ${esc(a.patient_first)}<div class="sub">${esc(a.department_name)}</div></td><td>${badge(a.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No appointments today.</p>';
    const pick = recs.filter((r) => !['CANCELLED', 'REJECTED'].includes(r.status));
    $('#dashPickups').innerHTML = pick.length
      ? `<table><tbody>${pick.map((r) => `<tr><td class="mono">${esc(r.ref_no)}</td><td>${esc(r.patient_last)}, ${esc(r.patient_first)}<div class="sub">${r.items.map((i) => esc(i.name)).join(', ')}</div></td><td>${badge(r.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No records to be claimed today.</p>';
  });

  // ---------- Records ----------
  const recFilters = $('#recFilters');
  recFilters.status.innerHTML += opts(REC_STATUSES);
  recFilters.type.innerHTML += cat.recordTypes.map((t) => `<option value="${t.code}">${esc(t.name)}</option>`).join('');
  let recRows = [];
  loaders.records = guard(async () => {
    if (!recordsStaff.length) recordsStaff = (await api('/admin/records-staff')).rows;
    const q = new URLSearchParams(Object.entries(formData(recFilters)).filter(([, v]) => v));
    recRows = (await api(`/admin/records?${q}`)).rows;
    $('#recRows').innerHTML =
      recRows
        .map(
          (r) => `<tr>
        <td class="mono">${esc(r.ref_no)}<div class="sub">${esc(r.created_at)}</div></td>
        <td>${esc(r.patient_last)}, ${esc(r.patient_first)} ${esc(r.patient_middle || '')}
          <div class="sub">DOB ${esc(r.birthdate)}${r.hospital_no ? ` · HRN ${esc(r.hospital_no)}` : ''}</div>
          ${r.patient_address ? `<div class="sub">${esc(r.patient_address)}</div>` : ''}
          ${r.admission_date ? `<div class="sub">Adm ${esc(r.admission_date)}${r.discharge_date ? ` – ${esc(r.discharge_date)}` : ''}</div>` : ''}</td>
        <td>${r.items.map((i) => `${esc(i.name)}${i.details ? ` <i>(${esc(i.details)})</i>` : ''} ×${i.copies}`).join('<br>')}
          <div class="sub">Purpose: ${esc(r.purpose)}</div>
          ${r.amount_due !== null ? `<div class="sub">Total: <b>${peso(r.amount_due)}</b>${r.payment_ref ? ` · Ref ${esc(r.payment_ref)}` : ''}</div>` : ''}</td>
        <td>${esc(r.requester_name)}<div class="sub">${esc(r.requester_relation)}</div><div class="sub">${esc(r.mobile)}</div></td>
        <td class="nowrap">${esc(fmtDate(r.pickup_date, { month: 'short', day: 'numeric', weekday: 'short' }))}</td>
        <td>${badge(r.status)}${r.remarks ? `<div class="sub">${esc(r.remarks)}</div>` : ''}
          ${r.copy_type === 'DIGITAL' ? `<div class="sub"><span class="badge INFO">Digital</span> ${idBadge(r)} ${ocrBadge(r)}</div>` : ''}
          ${r.assigned_to ? `<div class="sub">Assigned: <b>${esc(staffName(r.assigned_to))}</b></div>` : ''}${updatedBy(r)}</td>
        <td class="no-print nowrap">${digitalActions(r)}${quickRec(r)}<button class="btn sm secondary" data-edit-rec="${r.id}">Edit</button>
          ${/^self/i.test(r.requester_relation) ? '' : `<a class="btn sm secondary" href="/api/admin/records/${r.id}/authorization-letter" download title="Authorization letter filled in with this request's details">Letter</a>`}</td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">No records requests found.</td></tr>';
  });
  const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const ID_LABEL = { PENDING: 'ID & payment to check', VERIFIED: 'ID & payment verified', REJECTED: 'ID/payment not verified' };
  const ID_BADGE = { PENDING: 'PENDING', VERIFIED: 'COMPLETED', REJECTED: 'FAILED' };
  // Automatic ID check (OCR): advice for the staff who verify the ID
  const OCR_BADGE = { MATCH: 'COMPLETED', PARTIAL: 'PENDING', UNREADABLE: 'PENDING', MISMATCH: 'FAILED' };
  const ocrNotes = (r) => {
    try {
      return JSON.parse(r.id_ocr_notes || '[]');
    } catch {
      return [];
    }
  };
  const ocrBadge = (r) =>
    r.id_ocr_status
      ? `<span class="badge ${OCR_BADGE[r.id_ocr_status]}" title="${esc(ocrNotes(r).join(' '))}">ID check: ${esc(IdMatch.LABELS[r.id_ocr_status])}</span>`
      : '';
  function ocrResultHtml(r) {
    if (!r.id_ocr_status) return '<p class="muted small" style="margin:0">Not checked yet.</p>';
    const notes = ocrNotes(r);
    const who = r.id_ocr_by ? `read by ${esc(r.id_ocr_by)}` : "read on the requester's phone";
    return `<div class="alert ${r.id_ocr_status === 'MATCH' ? 'ok' : r.id_ocr_status === 'MISMATCH' ? 'error' : 'warn'} small" style="margin:0">
      <b>${esc(IdMatch.LABELS[r.id_ocr_status])}</b> <span class="muted">(${who}${r.id_ocr_at ? `, ${esc(r.id_ocr_at)}` : ''})</span>
      ${r.id_ocr_status === 'MATCH' ? '<div>Name and birthdate on the ID match the request.</div>' : `<ul class="list-tight">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`}
      ${r.id_ocr_text ? `<details><summary>Text read from the ID</summary><pre class="ocr-text">${esc(r.id_ocr_text)}</pre></details>` : ''}
    </div>`;
  }
  const idBadge = (r) => `<span class="badge ${ID_BADGE[r.id_status] || ''}">${esc(ID_LABEL[r.id_status] || '')}</span>`;
  let recordsStaff = [];
  const staffName = (u) => recordsStaff.find((s) => s.username === u)?.full_name || u;
  const isOpen = (r) => !['RELEASED', 'REJECTED', 'CANCELLED'].includes(r.status);
  // Digital copies: check the ID first, then send by email (which releases the request)
  const digitalActions = (r) => {
    if (r.copy_type !== 'DIGITAL' || !isOpen(r)) return '';
    if (r.id_status !== 'VERIFIED') return `<button class="btn sm" data-verify-id="${r.id}">Verify ID &amp; payment</button> `;
    return `<button class="btn sm" data-send-email="${r.id}">Send by email</button> `;
  };
  const quickRec = (r) => {
    // Digital copies only move to "ready" by hand; verifying the ID and sending by email do the rest
    if (r.copy_type === 'DIGITAL') {
      return r.id_status === 'VERIFIED' && r.status === 'PROCESSING' ? `<button class="btn sm secondary" data-rec-status="${r.id}:READY">Mark ready</button> ` : '';
    }
    const next = { PENDING: 'PROCESSING', PROCESSING: 'READY', READY: 'RELEASED' }[r.status];
    const label = { PROCESSING: 'Start processing', READY: 'Mark ready', RELEASED: 'Mark released' }[next];
    return next ? `<button class="btn sm" data-rec-status="${r.id}:${next}">${label}</button> ` : '';
  };
  recFilters.addEventListener('input', debounce(loaders.records));
  recFilters.querySelector('[data-clear]').addEventListener('click', () => (recFilters.reset(), loaders.records()));

  // Raw version lets the edit dialog show validation errors inline
  const patchRecRaw = async (id, body) => {
    await api(`/admin/records/${id}`, { method: 'PATCH', body });
    loaders.records();
  };
  const patchRec = guard(patchRecRaw);

  $('#recRows').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-rec-status]');
    if (quick) {
      const [id, status] = quick.dataset.recStatus.split(':');
      return patchRec(id, { status });
    }
    const edit = e.target.closest('[data-edit-rec]');
    if (!edit) return;
    const r = recRows.find((x) => x.id === Number(edit.dataset.editRec));
    openDialog(
      `<h2>Records request ${esc(r.ref_no)}</h2>
       <div class="grid">
         <label class="field">Status<select name="status">${opts(REC_STATUSES, r.status)}</select></label>
         <label class="field">${r.copy_type === 'DIGITAL' ? 'Target email date' : 'Claiming date'}<input type="date" name="pickup_date" value="${esc(r.pickup_date)}"></label>
         <label class="field">Assigned to<select name="assigned_to"><option value="">Unassigned</option>${recordsStaff
           .map((s) => `<option value="${esc(s.username)}"${s.username === r.assigned_to ? ' selected' : ''}>${esc(s.full_name || s.username)}</option>`)
           .join('')}</select></label>
         <label class="field">Remarks<span class="hint">Shown to the requester. Required when rejecting.</span><textarea name="remarks">${esc(r.remarks || '')}</textarea></label>
         <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notify" checked> Send SMS to requester for this change</label>
       </div>`,
      async (d) => patchRecRaw(r.id, { status: d.status, pickup_date: d.pickup_date, remarks: d.remarks, assigned_to: d.assigned_to, notify: d.notify === 'on' }),
    );
  });

  // Verify ID: compare the selfie with the valid ID and with the request details
  $('#recRows').addEventListener('click', (e) => {
    const v = e.target.closest('[data-verify-id]');
    if (!v) return;
    const r = recRows.find((x) => x.id === Number(v.dataset.verifyId));
    const photo = (kind) => `/api/admin/records/${r.id}/id-photo/${kind}?t=${encodeURIComponent(r.updated_at || '')}`;
    openDialog(
      `<h2>Verify ID &amp; payment — ${esc(r.ref_no)}</h2>
       <dl class="kv small" style="margin-bottom:12px">
         <dt>Patient (requester)</dt><dd>${esc([r.patient_first, r.patient_middle, r.patient_last].filter(Boolean).join(' '))}</dd>
         <dt>Birthdate</dt><dd>${esc(fmtDate(r.birthdate))}</dd>
         <dt>Email</dt><dd>${esc(r.email)}</dd>
         <dt>Amount due</dt><dd><b>${peso(r.amount_due)}</b>${r.payment_ref ? ` · Ref no. ${esc(r.payment_ref)}` : ''}</dd>
       </dl>
       <div class="ocr-box">
         <div class="sched-bar" style="margin-bottom:6px"><b class="small">Automatic ID check (OCR)</b><button class="btn sm secondary" type="button" id="ocrRunBtn">Re-check ID</button></div>
         <div id="ocrResult">${ocrResultHtml(r)}</div>
         <p class="muted small" style="margin:6px 0 0">OCR can misread photos; always compare the ID yourself.</p>
       </div>
       <div class="grid grid-3 id-review">
         <figure><a href="${photo('id')}" target="_blank" rel="noopener"><img src="${photo('id')}" alt="Valid ID"></a><figcaption>Valid ID (click to enlarge)</figcaption></figure>
         <figure><a href="${photo('selfie')}" target="_blank" rel="noopener"><img src="${photo('selfie')}" alt="Selfie holding ID"></a><figcaption>Selfie holding the ID</figcaption></figure>
         <figure><a href="${photo('receipt')}" target="_blank" rel="noopener"><img src="${photo('receipt')}" alt="Payment receipt"></a><figcaption>Payment receipt</figcaption></figure>
       </div>
       <p class="small muted">Check that the ID is valid and readable, the name and birthdate match the request, the person in the selfie matches the ID photo,
         and the receipt shows a payment of <b>${peso(r.amount_due)}</b> (check it against the hospital's GCash / InstaPay transactions).</p>
       ${r.id_status === 'REJECTED' && r.id_remarks ? `<div class="alert warn small">Last check: not verified — ${esc(r.id_remarks)}</div>` : ''}
       <div class="copy-choice" style="margin-top:8px">
         <label class="copy-opt"><input type="radio" name="decision" value="VERIFIED" required><span><b>Approve</b><small>ID matches and the payment was received. The request moves to Processing and is assigned to you.</small></span></label>
         <label class="copy-opt"><input type="radio" name="decision" value="REJECTED"><span><b>Reject</b><small>The requester is texted the reason and can upload new photos.</small></span></label>
       </div>
       <label class="field" style="margin-top:10px">Reason (required when rejecting)<input name="remarks" data-nocaps maxlength="300" placeholder="e.g. ID photo is blurry; payment not received; amount paid is short"></label>`,
      async (d) => {
        await api(`/admin/records/${r.id}/verify-id`, { method: 'POST', body: { decision: d.decision, remarks: d.remarks } });
        loaders.records();
      },
      { wide: true, saveLabel: 'Save decision' },
    );
    // Staff read the stored ID photo themselves (the requester's own check could have been tampered with)
    const runOcr = async () => {
      const btn = $('#ocrRunBtn');
      if (!btn) return;
      btn.disabled = true;
      const box = $('#ocrResult');
      try {
        const blob = await (await fetch(photo('id'), { credentials: 'same-origin' })).blob();
        const text = await IdOcr.read(blob, (m) => document.body.contains(box) && (box.innerHTML = `<p class="muted small" style="margin:0">${esc(IdOcr.progressText(m).replace('your ID', 'the ID'))}</p>`));
        const updated = await api(`/admin/records/${r.id}/id-ocr`, { method: 'POST', body: { text: text || ' ' } });
        Object.assign(r, updated);
        if (document.body.contains(box)) box.innerHTML = ocrResultHtml(r);
        loaders.records(); // the list behind the dialog shows the new result
      } catch (err) {
        if (document.body.contains(box)) box.innerHTML = `<p class="muted small" style="margin:0">The ID could not be read automatically (${esc(err.message)}). Please compare it yourself.</p>`;
      } finally {
        btn.disabled = false;
      }
    };
    $('#ocrRunBtn').addEventListener('click', runOcr);
    if (!r.id_ocr_by) runOcr();
  });

  // Send by email: staff send from the hospital's email account (attaching the scanned documents),
  // then mark the request as sent here, which releases it and texts the requester
  $('#recRows').addEventListener('click', (e) => {
    const s = e.target.closest('[data-send-email]');
    if (!s) return;
    const r = recRows.find((x) => x.id === Number(s.dataset.sendEmail));
    const docs = r.items.map((i) => `- ${i.name}${i.details ? ` (${i.details})` : ''}${i.copies > 1 ? ` x${i.copies}` : ''}`).join('\n');
    const subject = `Requested medical records – Ref ${r.ref_no}`;
    const body = `Good day, ${r.requester_name}.

Attached are your requested documents from the Hospital Health Information Management Section (HHIMS), ${cat.hospitalName}:
${docs}

Reference no.: ${r.ref_no}

This email and its attachments contain confidential health information intended only for you. Please do not forward or share them.

Thank you.
Hospital Health Information Management Section (HHIMS)
${cat.hospitalName}`;
    const mailto = `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    openDialog(
      `<h2>Send by email — ${esc(r.ref_no)}</h2>
       <ol class="small" style="padding-left:18px;margin-top:0">
         <li>Click <b>Open in email app</b> (or copy the details below into the hospital's email).</li>
         <li><b>Attach the scanned documents</b> and send the email from the hospital's official account.</li>
         <li>Come back and click <b>Mark as sent</b>.</li>
       </ol>
       <div class="grid">
         <label class="field">To<input value="${esc(r.email)}" readonly data-nocaps></label>
         <label class="field">Subject<input value="${esc(subject)}" readonly data-nocaps></label>
         <label class="field">Message<textarea rows="9" readonly data-nocaps>${esc(body)}</textarea></label>
         <div class="dir-actions" style="margin:0"><a class="btn sm" href="${esc(mailto)}">Open in email app</a>
           <button type="button" class="btn sm secondary" id="copyEmailBtn">Copy message</button></div>
         <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notify" checked> Text the requester that the documents were sent</label>
       </div>`,
      async (d) => {
        await api(`/admin/records/${r.id}/emailed`, { method: 'POST', body: { notify: d.notify === 'on' } });
        loaders.records();
      },
      { wide: true, saveLabel: 'Mark as sent' },
    );
    $('#copyEmailBtn').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(body);
      $('#copyEmailBtn').textContent = 'Copied';
    });
  });

  // ---------- Appointments ----------
  const apptFilters = $('#apptFilters');
  apptFilters.status.innerHTML += opts(APPT_STATUSES);
  apptFilters.department.innerHTML += cat.departments.map((d) => `<option value="${d.code}">${esc(d.name)}</option>`).join('');
  apptFilters.date.value = cat.today;
  let apptRows = [];
  loaders.appointments = guard(async () => {
    const q = new URLSearchParams(Object.entries(formData(apptFilters)).filter(([, v]) => v));
    apptRows = (await api(`/admin/appointments?${q}`)).rows;
    $('#apptRows').innerHTML =
      apptRows
        .map(
          (a) => `<tr>
        <td class="nowrap"><b>${fmtTime(a.appt_time)}</b><div class="sub">${esc(fmtDate(a.appt_date, { month: 'short', day: 'numeric', weekday: 'short' }))}</div></td>
        <td class="mono">${esc(a.ref_no)}</td>
        <td>${esc(a.patient_last)}, ${esc(a.patient_first)} ${esc(a.patient_middle || '')}
          <div class="sub">${a.patient_type === 'NEW' ? 'New' : 'Returning'} · ${esc(a.sex)} · DOB ${esc(a.birthdate)}${a.hospital_no ? ` · HRN ${esc(a.hospital_no)}` : ''}</div>
          <div class="sub">${esc(a.mobile)}</div></td>
        <td>${esc(a.department_name)}</td>
        <td>${esc(a.complaint)}</td>
        <td>${badge(a.status)}${a.remarks ? `<div class="sub">${esc(a.remarks)}</div>` : ''}${updatedBy(a)}</td>
        <td class="no-print nowrap">${quickAppt(a)}<button class="btn sm secondary" data-edit-appt="${a.id}">Edit</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">No appointments found.</td></tr>';
  });
  const quickAppt = (a) => {
    if (a.status === 'BOOKED') return `<button class="btn sm" data-appt-status="${a.id}:CHECKED_IN">Check in</button> <button class="btn sm secondary" data-appt-status="${a.id}:NO_SHOW">No show</button> `;
    if (a.status === 'CHECKED_IN') return `<button class="btn sm" data-appt-status="${a.id}:COMPLETED">Complete</button> `;
    return '';
  };
  apptFilters.addEventListener('input', debounce(loaders.appointments));
  apptFilters.querySelector('[data-clear]').addEventListener('click', () => (apptFilters.reset(), (apptFilters.date.value = ''), loaders.appointments()));

  // Raw version lets the edit dialog show validation errors inline
  const patchApptRaw = async (id, body) => {
    await api(`/admin/appointments/${id}`, { method: 'PATCH', body });
    loaders.appointments();
  };
  const patchAppt = guard(patchApptRaw);

  $('#apptRows').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-appt-status]');
    if (quick) {
      const [id, status] = quick.dataset.apptStatus.split(':');
      return patchAppt(id, { status });
    }
    const edit = e.target.closest('[data-edit-appt]');
    if (!edit) return;
    const a = apptRows.find((x) => x.id === Number(edit.dataset.editAppt));
    openDialog(
      `<h2>Appointment ${esc(a.ref_no)}</h2>
       <p class="muted small">${esc(a.patient_last)}, ${esc(a.patient_first)} · ${esc(a.department_name)}</p>
       <div class="grid grid-2">
         <label class="field span-2">Status<select name="status">${opts(APPT_STATUSES, a.status)}</select></label>
         <label class="field">Date<input type="date" name="appt_date" value="${esc(a.appt_date)}"></label>
         <label class="field">Time<select name="appt_time"><option value="${esc(a.appt_time)}">${fmtTime(a.appt_time)} (current)</option></select></label>
         <label class="field span-2">Remarks<textarea name="remarks">${esc(a.remarks || '')}</textarea></label>
         <label class="span-2" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notify" checked> Send SMS to patient if cancelled or rescheduled</label>
       </div>`,
      async (d) => patchApptRaw(a.id, { status: d.status, appt_date: d.appt_date, appt_time: d.appt_time, remarks: d.remarks, notify: d.notify === 'on' }),
    );
    // Load open slots when the date is changed for rescheduling
    const dateInput = $('#dlgForm [name=appt_date]');
    const timeSel = $('#dlgForm [name=appt_time]');
    dateInput.addEventListener('change', guard(async () => {
      if (dateInput.value === a.appt_date) {
        timeSel.innerHTML = `<option value="${esc(a.appt_time)}">${fmtTime(a.appt_time)} (current)</option>`;
        return;
      }
      const { slots } = await api(`/admin/opd/slots?department=${a.department}&date=${dateInput.value}`);
      timeSel.innerHTML = slots.length
        ? slots.map((s) => `<option value="${s.time}" ${s.remaining ? '' : 'disabled'}>${s.label} (${s.remaining} left)</option>`).join('')
        : '<option value="">Clinic closed on this date</option>';
    }));
  });

  // ---------- SMS ----------
  loaders.sms = guard(async () => {
    const { rows, provider } = await api('/admin/sms');
    const testMode = provider === 'console';
    $('#smsProvider').className = `alert small ${testMode ? 'warn' : 'info'}`;
    $('#smsProvider').innerHTML = testMode
      ? '<b>Test mode — no texts are being sent to phones.</b> SMS_PROVIDER is not set (or the site was not redeployed after setting it). Messages are only written to this log.'
      : `SMS provider: <b>${esc(provider)}</b>. “Sent” means the gateway accepted the message; use <b>Check delivery</b> to see whether it reached the phone.`;
    $('#smsRows').innerHTML =
      rows
        .map(
          (s) => `<tr>
        <td class="nowrap small">${esc(s.created_at)}</td>
        <td class="mono">${esc(s.recipient)}</td>
        <td class="small">${esc(s.kind)}${s.ref_no ? `<div class="sub mono">${esc(s.ref_no)}</div>` : ''}</td>
        <td class="small">${esc(s.message)}${s.error ? `<div class="sub" style="color:var(--danger)">${esc(s.error)}</div>` : ''}</td>
        <td>${s.provider === 'console' ? '<span class="badge CANCELLED">Test only</span>' : badge(s.status)}
          <div class="sub">via ${esc(s.provider)}${s.provider === 'console' ? ' (test mode, not sent to phone)' : ''}</div>
          ${s.provider_status ? `<div class="sub">Gateway: <b>${esc(s.provider_status)}</b></div>` : ''}
          ${s.provider_ref ? `<div class="sub mono">${esc(s.provider_ref)}</div>` : ''}
          ${s.provider_response ? `<details class="sub"><summary>Gateway reply</summary><code class="mono" style="white-space:pre-wrap;word-break:break-all">${esc(s.provider_response)}</code></details>` : ''}</td>
        <td class="nowrap">${s.status === 'FAILED' ? `<button class="btn sm secondary" data-resend="${s.id}">Resend</button>` : ''}
          ${s.provider === 'unisms' && s.provider_ref ? `<button class="btn sm secondary" data-check="${s.id}">Check delivery</button>` : ''}</td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="6" class="empty">No SMS sent yet.</td></tr>';
  });
  $('#smsRows').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-resend], [data-check]');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.resend) await api(`/admin/sms/${b.dataset.resend}/resend`, { method: 'POST' });
      else await api(`/admin/sms/${b.dataset.check}/check`, { method: 'POST' });
    } finally {
      loaders.sms();
    }
  }));

  // ---------- Settings ----------
  // ----- Fees & online payment (administrators) -----
  async function loadPaymentSettings() {
    const ps = await api('/admin/payment-settings');
    $('#feeFields').innerHTML = ps.fees
      .map((f) => `<label class="field">${esc(f.name)}<input type="number" min="0" step="0.01" name="${esc(f.code)}" value="${f.fee}"></label>`)
      .join('');
    $('#qrPreview').src = ps.qr_url;
    $('#qrSource').textContent = ps.custom_qr ? 'Uploaded by an administrator.' : 'Default QR code (included with the system).';
    $('#qrReset').classList.toggle('hidden', !ps.custom_qr);
    $('#payNoteForm').note.value = ps.note === ps.default_note ? '' : ps.note;
    $('#payNoteForm').note.placeholder = ps.default_note;
  }
  $('#feesForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/admin/fees', { method: 'PUT', body: { fees: formData($('#feeFields').closest('form')) } });
    $('#feesSaved').textContent = 'Saved.';
    setTimeout(() => ($('#feesSaved').textContent = ''), 3000);
  }));
  $('#payNoteForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/admin/payment-note', { method: 'PUT', body: { note: e.target.note.value } });
    $('#noteSaved').textContent = 'Saved.';
    setTimeout(() => ($('#noteSaved').textContent = ''), 3000);
  }));
  $('#qrUpload').addEventListener('change', guard(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Keep the QR sharp: send the original unless it's very large
    const image = file.size < 1.5 * 1024 * 1024
      ? await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); })
      : await photoToDataUrl(file, 1400);
    await api('/admin/payment-qr', { method: 'POST', body: { image } });
    e.target.value = '';
    loadPaymentSettings();
  }));
  $('#qrReset').addEventListener('click', guard(async () => {
    if (!confirm('Go back to the default QR code?')) return;
    await api('/admin/payment-qr', { method: 'DELETE' });
    loadPaymentSettings();
  }));

  // Public services on/off
  async function loadModules() {
    const d = await api('/admin/modules');
    const off = new Set(d.disabled);
    const box = (m, sub) =>
      `<label><input type="checkbox" data-mod="${m.key}" ${off.has(m.key) ? '' : 'checked'}${sub ? ` data-parent="${sub}"` : ''}> ${sub ? esc(m.name) : `<b>${esc(m.name)}</b>`} <span class="off-tag" data-off-tag="${m.key}">OFF</span></label>`;
    $('#modTree').innerHTML = d.modules
      .map((m) => `<li>${box(m)}${m.subs.length ? `<ul>${m.subs.map((x) => `<li>${box(x, m.key)}</li>`).join('')}</ul>` : ''}</li>`)
      .join('');
    $('#modulesForm').message.value = d.message || '';
    $('#modSaved').textContent = d.updated ? `Last saved by ${d.updated.by} · ${d.updated.at}` : '';
    syncModules();
  }
  // Sub-modules of a module that is off cannot be used; show them greyed out
  function syncModules() {
    $$('#modTree [data-mod]').forEach((c) => {
      const parent = c.dataset.parent && $(`#modTree [data-mod="${c.dataset.parent}"]`);
      c.disabled = !!parent && !parent.checked;
      $(`[data-off-tag="${c.dataset.mod}"]`).hidden = c.checked && !c.disabled;
    });
  }
  $('#modTree').addEventListener('change', syncModules);
  $('#modulesForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const disabled = $$('#modTree [data-mod]').filter((c) => !c.checked).map((c) => c.dataset.mod);
    await api('/admin/modules', { method: 'PUT', body: { disabled, message: e.target.message.value } });
    await loadModules();
    $('#modSaved').textContent = `Saved. ${$('#modSaved').textContent}`;
  }));

  loaders.settings = guard(async () => {
    if (me?.role === 'ADMIN') loadPaymentSettings();
    if (me?.role === 'ADMIN') loadModules();
    const { rows } = await api('/admin/closed-dates');
    $('#closedList').innerHTML = rows.length
      ? `<table><tbody>${rows.map((r) => `<tr><td class="nowrap">${esc(fmtDate(r.date))}</td><td>${esc(r.reason)}</td><td><button class="btn sm secondary admin-only" data-del-closed="${r.date}">Remove</button></td></tr>`).join('')}</tbody></table>`
      : '<p class="muted small">No closed dates set.</p>';
  });
  $('#closedForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const res = await api('/admin/closed-dates', { method: 'POST', body: formData(e.target) });
    const { appointments, pickups } = res.affected;
    showError($('#closedWarn'), appointments || pickups
      ? `Note: ${appointments} booked appointment(s) and ${pickups} records pickup(s) already exist on this date. Reschedule them from the Appointments / Records tabs (patients will be notified by SMS).`
      : '');
    e.target.reset();
    loaders.settings();
  }));
  $('#closedList').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-del-closed]');
    if (!b) return;
    await api(`/admin/closed-dates/${b.dataset.delClosed}`, { method: 'DELETE' });
    loaders.settings();
  }));
  $('#smsTestForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const { ok } = await api('/admin/sms/test', { method: 'POST', body: formData(e.target) });
    $('#smsTestResult').textContent = ok ? 'Sent. Check the SMS Log tab.' : 'Failed — see the SMS Log tab for the error.';
  }));
  $('#pwForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/admin/password', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    $('#pwResult').textContent = 'Password updated.';
  }));

  // ---------- Users ----------
  let userRows = [];
  const roleLabel = (r) => (r === 'ADMIN' ? 'Administrator' : 'Staff');
  const roleOpts = (sel) => ['STAFF', 'ADMIN'].map((r) => `<option value="${r}"${r === sel ? ' selected' : ''}>${roleLabel(r)}</option>`).join('');
  const accessLabel = (x) =>
    x.role === 'ADMIN' ? 'All' : [x.can_records && 'Records Requests', x.can_opd && 'OPD Appointments', x.can_referrals && 'Referrals', x.can_attendance && `Flag Ceremony${x.can_flag_scan ? ' + QR scanning' : ''}`].filter(Boolean).join('<br>');
  // Access checkboxes; disabled for Administrators, who always have both
  const accessFields = (x) => `
    <fieldset class="access" ${x.role === 'ADMIN' ? 'disabled' : ''}>
      <legend>Access</legend>
      <label><input type="checkbox" name="can_records" ${x.can_records !== false ? 'checked' : ''}> Records Requests</label>
      <label><input type="checkbox" name="can_opd" ${x.can_opd !== false ? 'checked' : ''}> OPD Appointments</label>
      <label><input type="checkbox" name="can_referrals" ${x.can_referrals ? 'checked' : ''}> Referrals (RHUs, health centers, hospitals)</label>
      <label><input type="checkbox" name="can_attendance" ${x.can_attendance ? 'checked' : ''}> Flag Ceremony Attendance (employees, ceremonies, reports)</label>
      <label class="sub-access"><input type="checkbox" name="can_flag_scan" ${x.can_flag_scan ? 'checked' : ''}> QR scanning at the venue (HR only)</label>
      <p class="hint">Administrators always have access to all sections.</p>
    </fieldset>`;
  const wireAccess = () => {
    const role = $('#dlgForm [name=role]');
    const fs = $('#dlgForm fieldset.access');
    role.addEventListener('change', () => (fs.disabled = role.value === 'ADMIN'));
    // QR scanning is part of Flag Ceremony access
    const att = $('#dlgForm [name=can_attendance]');
    const scanBox = $('#dlgForm [name=can_flag_scan]');
    const sync = () => {
      scanBox.disabled = !att.checked;
      if (!att.checked) scanBox.checked = false;
    };
    att.addEventListener('change', sync);
    sync();
  };
  const readAccess = () => ({
    can_records: $('#dlgForm [name=can_records]').checked,
    can_opd: $('#dlgForm [name=can_opd]').checked,
    can_referrals: $('#dlgForm [name=can_referrals]').checked,
    can_attendance: $('#dlgForm [name=can_attendance]').checked,
    can_flag_scan: $('#dlgForm [name=can_attendance]').checked && $('#dlgForm [name=can_flag_scan]').checked,
  });

  loaders.users = guard(async () => {
    userRows = (await api('/admin/users')).rows;
    $('#userRows').innerHTML = userRows
      .map(
        (x) => `<tr>
        <td class="mono">${esc(x.username)}${x.username === me.username ? ' <span class="sub">(you)</span>' : ''}</td>
        <td>${esc(x.full_name || '')}</td>
        <td>${roleLabel(x.role)}</td>
        <td class="small">${accessLabel(x)}</td>
        <td>${x.active ? '<span class="badge COMPLETED">Active</span>' : '<span class="badge CANCELLED">Inactive</span>'}</td>
        <td class="small nowrap">${esc(x.last_login_at || 'Never')}</td>
        <td class="nowrap"><button class="btn sm secondary" data-edit-user="${x.id}">Edit</button> <button class="btn sm secondary" data-pw-user="${x.id}">Reset password</button></td>
      </tr>`,
      )
      .join('');
  });

  $('#addUserBtn').addEventListener('click', () => {
    openDialog(
      `<h2>Add user</h2>
       <div class="grid">
         <label class="field">Full name<input name="full_name" required></label>
         <label class="field">Username<span class="hint">Used to log in. Letters, numbers, dot, dash or underscore.</span><input name="username" autocomplete="off" required></label>
         <label class="field">Role<select name="role">${roleOpts('STAFF')}</select></label>
         ${accessFields({ role: 'STAFF' })}
         <label class="field">Temporary password<span class="hint">At least 8 characters. Ask the user to change it after logging in.</span><input name="password" type="password" autocomplete="new-password" required></label>
       </div>`,
      async (d) => {
        await api('/admin/users', { method: 'POST', body: { ...d, ...readAccess() } });
        loaders.users();
      },
    );
    wireAccess();
  });

  $('#userRows').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-user]');
    const pw = e.target.closest('[data-pw-user]');
    const x = userRows.find((r) => r.id === Number((edit || pw)?.dataset.editUser || (edit || pw)?.dataset.pwUser));
    if (!x) return;
    const self = x.username === me.username;
    if (edit) {
      openDialog(
        `<h2>Edit user <span class="mono">${esc(x.username)}</span></h2>
         <div class="grid">
           <label class="field">Full name<input name="full_name" value="${esc(x.full_name || '')}" required></label>
           <label class="field">Role<select name="role" ${self ? 'disabled' : ''}>${roleOpts(x.role)}</select></label>
           ${accessFields(x)}
           <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${x.active ? 'checked' : ''} ${self ? 'disabled' : ''}> Active (can log in)</label>
           ${self ? '<p class="muted small">You can’t change your own role or deactivate yourself.</p>' : ''}
         </div>`,
        async (d) => {
          const body = { full_name: d.full_name, ...readAccess() };
          if (!self) Object.assign(body, { role: d.role, active: $('#dlgForm [name=active]').checked });
          await api(`/admin/users/${x.id}`, { method: 'PATCH', body });
          loaders.users();
          if (self) start();
        },
      );
      wireAccess();
    } else {
      openDialog(
        `<h2>Reset password for <span class="mono">${esc(x.username)}</span></h2>
         <p class="muted small">They will be signed out of all devices and must log in with the new password.</p>
         <label class="field">New password<span class="hint">At least 8 characters</span><input name="password" type="password" autocomplete="new-password" required></label>`,
        async (d) => {
          await api(`/admin/users/${x.id}/password`, { method: 'POST', body: { password: d.password } });
        },
      );
    }
  });

  // ---------- FAQs ----------
  let faqRows = [];
  let faqPlaceholders = {};
  loaders.faqs = guard(async () => {
    const [{ rows, placeholders }, { rows: unanswered }] = await Promise.all([api('/admin/faqs'), api('/admin/faq-unanswered')]);
    faqRows = rows;
    faqPlaceholders = placeholders;
    $('#faqRows').innerHTML =
      rows
        .map(
          (f) => `<tr>
        <td class="small">${f.sort_order}</td>
        <td><b>${esc(f.question)}</b><div class="sub" style="white-space:pre-line;max-width:520px">${esc(f.answer.length > 180 ? `${f.answer.slice(0, 180)}…` : f.answer)}</div></td>
        <td class="small" style="max-width:260px">${esc(f.keywords)}</td>
        <td class="small">${f.link_url ? `${esc(f.link_label || '')}<div class="sub mono">${esc(f.link_url)}</div>` : ''}</td>
        <td>${f.active ? '<span class="badge COMPLETED">Shown</span>' : '<span class="badge CANCELLED">Hidden</span>'}</td>
        <td class="nowrap"><button class="btn sm secondary" data-edit-faq="${f.id}">Edit</button> <button class="btn sm secondary" data-del-faq="${f.id}">Delete</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="6" class="empty">No FAQs yet.</td></tr>';
    $('#unansweredList').innerHTML = unanswered.length
      ? `<table><tbody>${unanswered
          .map(
            (u) => `<tr><td>${esc(u.message)}<div class="sub">${esc(u.created_at)}</div></td>
            <td class="nowrap"><button class="btn sm" data-faq-from="${u.id}">Create FAQ</button> <button class="btn sm secondary" data-dismiss="${u.id}">Dismiss</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="muted small">Nothing yet.</p>';
    $('#unansweredList').dataset.rows = JSON.stringify(unanswered);
  });

  // FAQ text is written content, so it keeps normal capitalisation (data-nocaps)
  function faqDialog(f = {}, fromUnansweredId = null) {
    const ph = Object.entries(faqPlaceholders)
      .map(([k, v]) => `<li><code>{${k}}</code> → ${esc(String(v).split('\n')[0])}${String(v).includes('\n') ? ' …' : ''}</li>`)
      .join('');
    openDialog(
      `<h2>${f.id ? 'Edit FAQ' : 'Add FAQ'}</h2>
       <div class="grid">
         <label class="field">Question<input name="question" data-nocaps value="${esc(f.question || '')}" required></label>
         <label class="field">Answer<textarea name="answer" data-nocaps rows="7" required>${esc(f.answer || '')}</textarea></label>
         <details class="small"><summary>Automatic values you can use in the answer</summary>
           <p class="muted" style="margin:6px 0">These are filled in from the system's settings, so the answer stays correct if they change.</p><ul class="list-tight">${ph}</ul></details>
         <label class="field">Keywords<span class="hint">Words or phrases visitors might type, separated by commas, e.g. claim, pick up, kailan, ready</span><textarea name="keywords" data-nocaps rows="3">${esc(f.keywords || '')}</textarea></label>
         <div class="grid grid-2">
           <label class="field">Button link (optional)<span class="hint">A page such as /request-records, or an https:// address</span><input name="link_url" data-nocaps value="${esc(f.link_url || '')}"></label>
           <label class="field">Button text<input name="link_label" data-nocaps value="${esc(f.link_label || '')}" placeholder="e.g. Request records"></label>
         </div>
         <div class="grid grid-2">
           <label class="field">Order<span class="hint">Lower numbers appear first in suggestions</span><input name="sort_order" type="number" value="${f.sort_order ?? 100}"></label>
           <label style="display:flex;gap:8px;align-items:center;margin-top:22px"><input type="checkbox" name="active" ${f.active === false ? '' : 'checked'}> Show in the assistant</label>
         </div>
       </div>`,
      async (d) => {
        const body = { ...d, active: $('#dlgForm [name=active]').checked };
        if (f.id) await api(`/admin/faqs/${f.id}`, { method: 'PATCH', body });
        else await api('/admin/faqs', { method: 'POST', body });
        if (fromUnansweredId) await api(`/admin/faq-unanswered/${fromUnansweredId}`, { method: 'DELETE' });
        loaders.faqs();
      },
    );
  }

  $('#addFaqBtn').addEventListener('click', () => faqDialog());
  $('#faqRows').addEventListener('click', guard(async (e) => {
    const edit = e.target.closest('[data-edit-faq]');
    const del = e.target.closest('[data-del-faq]');
    if (edit) return faqDialog(faqRows.find((f) => f.id === Number(edit.dataset.editFaq)));
    if (del && confirm('Delete this FAQ? The assistant will stop using it.')) {
      await api(`/admin/faqs/${del.dataset.delFaq}`, { method: 'DELETE' });
      loaders.faqs();
    }
  }));
  $('#unansweredList').addEventListener('click', guard(async (e) => {
    const from = e.target.closest('[data-faq-from]');
    const dismiss = e.target.closest('[data-dismiss]');
    if (from) {
      const u = JSON.parse($('#unansweredList').dataset.rows).find((x) => x.id === Number(from.dataset.faqFrom));
      return faqDialog({ question: u.message, keywords: u.message.toLowerCase() }, u.id);
    }
    if (dismiss) {
      await api(`/admin/faq-unanswered/${dismiss.dataset.dismiss}`, { method: 'DELETE' });
      loaders.faqs();
    }
  }));
  $('#clearUnansweredBtn').addEventListener('click', guard(async () => {
    if (!confirm('Remove all unanswered questions from this list?')) return;
    await api('/admin/faq-unanswered', { method: 'DELETE' });
    loaders.faqs();
  }));

  // ---------- Referrals ----------
  let refOpts = null;
  let refRows = [];
  const refBadge = (status, label) => `<span class="badge r-${esc(status)}">${esc(label || status)}</span>`;
  const urgBadge = (u, label) => `<span class="badge u-${esc(u)}">${esc(label || u)}</span>`;
  const refFilters = $('#refFilters');

  async function loadRefOptions() {
    refOpts = await api('/admin/referrals/options');
    refFilters.urgency.innerHTML = '<option value="">Any urgency</option>' + Object.entries(refOpts.urgency).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    refFilters.status.innerHTML =
      '<option value="OPEN">Waiting for response</option><option value="">All</option>' +
      Object.entries(refOpts.statuses).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    refFilters.facility_id.innerHTML = '<option value="">All facilities</option>' + refOpts.facilities.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  }

  loaders.referrals = guard(async () => {
    if (!refOpts) await loadRefOptions();
    const q = new URLSearchParams(Object.entries(formData(refFilters)).filter(([, v]) => v));
    const data = await api(`/admin/referrals?${q}`);
    refRows = data.rows;
    $('#refOpenCount').textContent = data.open.n ? `· ${data.open.n} waiting${data.open.emergency ? `, ${data.open.emergency} emergency` : ''}` : '';
    $('#refAdminRows').innerHTML =
      refRows
        .map(
          (r) => `<tr class="${r.urgency === 'EMERGENCY' && ['SENT', 'RECEIVED'].includes(r.status) ? 'urgent-row' : ''}">
        <td>${urgBadge(r.urgency, r.urgency_label)}</td>
        <td class="mono">${esc(r.ref_no)}<div class="sub">${esc(r.created_at)}</div></td>
        <td>${esc(r.facility_name)}<div class="sub">${esc(r.facility_type_label)}</div></td>
        <td>${esc(r.patient_last)}, ${esc(r.patient_first)}<div class="sub">${esc(r.age)} / ${esc(r.sex)}</div></td>
        <td class="small">${esc(r.department_name)}</td>
        <td class="small">${esc(r.working_diagnosis)}</td>
        <td>${refBadge(r.status, r.status_label)}${r.appt_date ? `<div class="sub">${esc(fmtDate(r.appt_date, { month: 'short', day: 'numeric' }))} ${esc(fmtTime(r.appt_time))}</div>` : ''}${r.exported_at ? '<div class="sub">Exported</div>' : ''}</td>
        <td class="no-print"><button class="btn sm" data-open-ref="${r.id}">Open</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="8" class="empty">No referrals found.</td></tr>';
  });
  refFilters.addEventListener('input', debounce(loaders.referrals));

  function refDetailHtml(r) {
    const kv = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '');
    const vit = [['BP', r.bp], ['HR', r.hr], ['RR', r.rr], ['Temp', r.temp], ['O2 sat', r.o2sat], ['Wt', r.weight]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ');
    const thumbs = r.attachments
      .map((a) => {
        const url = `/api/admin/referrals/${r.id}/attachments/${a.id}`;
        return a.mime.startsWith('image/')
          ? `<a href="${url}" target="_blank" rel="noopener" title="${esc(a.filename)}"><img src="${url}" alt="${esc(a.filename)}"></a>`
          : `<a href="${url}" target="_blank" rel="noopener"><span class="pdf">PDF<br>${esc(a.filename)}</span></a>`;
      })
      .join('');
    return `<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
        <h2 style="margin:0">Referral <span class="mono">${esc(r.ref_no)}</span></h2><div>${urgBadge(r.urgency, r.urgency_label)} ${refBadge(r.status, r.status_label)}</div></div>
      <p class="small muted" style="margin:6px 0 10px">From <b>${esc(r.facility_name)}</b> (${esc(r.facility_type_label)}${r.facility_municipality ? `, ${esc(r.facility_municipality)}` : ''}) · sent ${esc(r.created_at)}</p>
      ${r.response_note || r.appt_date ? `<div class="alert ${r.status === 'REDIRECTED' ? 'warn' : 'ok'} small"><b>Response:</b> ${esc(r.response_note || '')}${r.appt_date ? ` · Appointment ${esc(fmtDate(r.appt_date))} ${esc(fmtTime(r.appt_time))}` : ''}${r.responded_by ? ` · by ${esc(r.responded_by)}` : ''}</div>` : ''}
      <div class="grid grid-2">
        <dl class="kv small">
          ${kv('Patient', `${r.patient_last}, ${r.patient_first} ${r.patient_middle || ''}`)}${kv('Birthdate / age / sex', `${r.birthdate} / ${r.age} / ${r.sex}`)}
          ${kv('Address', r.address)}${kv('Mobile', r.mobile)}${kv('PhilHealth no.', r.philhealth_no)}
          ${kv('Referred by', [r.referring_name, r.referring_designation, r.referring_contact].filter(Boolean).join(' · '))}
        </dl>
        <dl class="kv small">
          ${kv('Refer to', r.department_name)}${kv('Reason', r.reason)}${kv('Chief complaint', r.chief_complaint)}
          ${kv('Vital signs', vit)}${kv('Working diagnosis', r.working_diagnosis)}
        </dl>
      </div>
      <dl class="kv small" style="margin-top:8px">${kv('History', r.history)}${kv('Treatment given', r.treatment_given)}${kv('Return slip feedback', r.feedback)}</dl>
      ${thumbs ? `<p class="small" style="margin:10px 0 4px"><b>Attachments</b></p><div class="ref-thumbs">${thumbs}</div>` : ''}
      <div class="actions">
        ${['SENT', 'RECEIVED'].includes(r.status) ? '<button class="btn danger" type="button" data-act="redirect">Redirect</button><button class="btn" type="button" data-act="accept">Accept</button>' : ''}
        ${r.status === 'ACCEPTED' ? '<button class="btn" type="button" data-act="arrived">Patient arrived</button>' : ''}
        ${['ACCEPTED', 'ARRIVED'].includes(r.status) ? '<button class="btn" type="button" data-act="seen">Seen / return slip</button>' : ''}
        ${r.status === 'SEEN' ? '<button class="btn secondary" type="button" data-print="return">Print return slip</button>' : ''}
        <button class="btn secondary" type="button" data-print="referral">Print referral slip</button>
        <button class="btn secondary" type="button" data-act="close">Close</button>
      </div>`;
  }

  // The referral dialog uses its own content (several action buttons), not the shared form dialog
  async function openReferral(id) {
    const r = await api(`/admin/referrals/${id}`);
    const dlg = $('#dlg');
    dlg.classList.add('wide');
    const form = $('#dlgForm');
    form.onsubmit = (e) => e.preventDefault();
    form.innerHTML = refDetailHtml(r);
    form.onclick = async (e) => {
      const p = e.target.closest('[data-print]');
      if (p) return printReferral(r, { kind: p.dataset.print, systemName: cat.systemName, hospitalName: cat.hospitalName });
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      form.onclick = null;
      if (act === 'close') return dlg.close();
      if (act === 'accept') return acceptDialog(r);
      if (act === 'redirect') return redirectDialog(r);
      if (act === 'seen') return seenDialog(r);
      if (act === 'arrived') {
        await api(`/admin/referrals/${r.id}/arrived`, { method: 'POST', body: {} });
        dlg.close();
        loaders.referrals();
      }
    };
    if (!dlg.open) dlg.showModal();
    loaders.referrals();
  }
  $('#refAdminRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open-ref]');
    if (b) guard(openReferral)(Number(b.dataset.openRef));
  });
  // Reset handlers left by the referral dialog when other dialogs reuse it
  $('#dlg').addEventListener('close', () => ($('#dlgForm').onclick = null));

  function acceptDialog(r) {
    const clinicOpts = refOpts.clinics.map((c) => `<option value="${esc(c.code)}"${c.code === r.department ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    openDialog(
      `<h2>Accept referral ${esc(r.ref_no)}</h2>
       <p class="small muted">${esc(r.patient_last)}, ${esc(r.patient_first)} · ${esc(r.department_name)} · ${esc(r.urgency_label)}</p>
       <label class="field">Message to the referring facility<span class="hint">e.g. "Proceed to ER", "Bring latest CBC"</span><input name="note" data-nocaps maxlength="500"></label>
       <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="bookToggle" ${r.urgency === 'ROUTINE' && refOpts.clinics.some((c) => c.code === r.department) ? 'checked' : ''}> Book an OPD appointment for the patient</label>
       <div class="grid grid-3 hidden" id="bookFields" style="margin-top:8px">
         <label class="field">Clinic<select name="clinic">${clinicOpts}</select></label>
         <label class="field">Date<input type="date" name="date" min="${esc(cat.today)}"></label>
         <label class="field">Time<select name="time"><option value="">Pick a date</option></select></label>
       </div>
       <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" name="notify" checked> Send SMS to the facility${r.mobile ? ' and the patient' : ''}</label>`,
      async (d) => {
        const book = $('#bookToggle').checked ? { clinic: d.clinic, date: d.date, time: d.time } : null;
        if (book && (!book.date || !book.time)) throw new Error('Choose the appointment date and time, or untick "Book an OPD appointment".');
        await api(`/admin/referrals/${r.id}/accept`, { method: 'POST', body: { note: d.note, book, notify: d.notify === 'on' } });
        loaders.referrals();
      },
      { wide: true, saveLabel: 'Accept referral' },
    );
    const toggle = () => $('#bookFields').classList.toggle('hidden', !$('#bookToggle').checked);
    $('#bookToggle').addEventListener('change', toggle);
    toggle();
    const loadSlots = guard(async () => {
      const clinic = $('#dlgForm [name=clinic]').value;
      const date = $('#dlgForm [name=date]').value;
      const sel = $('#dlgForm [name=time]');
      if (!clinic || !date) return;
      const { slots } = await api(`/admin/opd/slots?department=${encodeURIComponent(clinic)}&date=${date}`);
      sel.innerHTML = slots.length
        ? slots.map((s) => `<option value="${s.time}" ${s.remaining ? '' : 'disabled'}>${s.label} (${s.remaining} left)</option>`).join('')
        : '<option value="">No clinic on this date</option>';
    });
    $('#dlgForm [name=clinic]').addEventListener('change', loadSlots);
    $('#dlgForm [name=date]').addEventListener('change', loadSlots);
  }

  function redirectDialog(r) {
    openDialog(
      `<h2>Redirect referral ${esc(r.ref_no)}</h2>
       <p class="small muted">The referring facility is told why ZRMC can't accept the patient, and where to send them instead.</p>
       <label class="field">Reason and advice<textarea name="note" rows="4" data-nocaps required placeholder="e.g. No available bed in Pediatrics ICU; please refer to …"></textarea></label>
       <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="notify" checked> Send SMS to the facility</label>`,
      async (d) => {
        await api(`/admin/referrals/${r.id}/redirect`, { method: 'POST', body: { note: d.note, notify: d.notify === 'on' } });
        loaders.referrals();
      },
      { wide: true, saveLabel: 'Redirect' },
    );
  }

  function seenDialog(r) {
    openDialog(
      `<h2>Patient seen — ${esc(r.ref_no)}</h2>
       <p class="small muted">This feedback goes on the <b>return slip</b> the referring facility can see and print.</p>
       <label class="field">Findings, management and follow-up instructions<textarea name="feedback" rows="6"></textarea></label>`,
      async (d) => {
        await api(`/admin/referrals/${r.id}/seen`, { method: 'POST', body: { feedback: d.feedback } });
        loaders.referrals();
      },
      { wide: true, saveLabel: 'Save' },
    );
  }

  // ----- Export for Bizbox -----
  $('#refExportBtn').addEventListener('click', () => {
    openDialog(
      `<h2>Export referrals for Bizbox</h2>
       <p class="small muted">Downloads a CSV file (opens in Excel) of <b>accepted</b> referrals, to import into Bizbox.
         Columns: ${esc((refOpts?.export_columns || []).join(', '))}.</p>
       <div class="grid grid-2">
         <label class="field">Referred from<input type="date" name="from" value="${esc(cat.today)}"></label>
         <label class="field">Referred to<input type="date" name="to" value="${esc(cat.today)}"></label>
       </div>
       <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="only_new" checked> Only referrals not exported before</label>`,
      async (d) => {
        const q = new URLSearchParams({ from: d.from, to: d.to, ...(d.only_new === 'on' || $('#dlgForm [name=only_new]').checked ? { only_new: '1' } : {}) });
        window.location.href = `/api/admin/referrals/export.csv?${q}`;
        setTimeout(loaders.referrals, 1500);
      },
      { wide: true, saveLabel: 'Download CSV' },
    );
  });

  // ----- Monthly report -----
  $('#refReportBtn').addEventListener('click', guard(async () => {
    const month = cat.today.slice(0, 7);
    const draw = async (m) => {
      const rep = await api(`/admin/referrals/report?month=${m}`);
      $('#repBody').innerHTML = `
        <h3>By facility</h3>
        <div class="table-wrap"><table><thead><tr><th>Facility</th><th>Type</th><th>Total</th><th>Accepted</th><th>Redirected</th><th>Emergency</th></tr></thead><tbody>
        ${rep.by_facility.map((f) => `<tr><td>${esc(f.name)}</td><td class="small">${esc(f.type_label)}</td><td>${f.total}</td><td>${f.accepted}</td><td>${f.redirected}</td><td>${f.emergency}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No referrals this month.</td></tr>'}
        </tbody></table></div>
        <div class="grid grid-2" style="margin-top:12px">
          <div><h3>By receiving service</h3><table>${rep.by_department.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.total}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table></div>
          <div><h3>By status</h3><table>${rep.by_status.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.total}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</table></div>
        </div>`;
    };
    openDialog(
      `<h2>Referrals report</h2>
       <label class="field" style="max-width:220px">Month<input type="month" name="month" value="${month}"></label>
       <div id="repBody" style="margin-top:12px"></div>`,
      async () => window.print(),
      { wide: true, saveLabel: 'Print' },
    );
    $('#dlgForm [name=month]').addEventListener('change', (e) => guard(draw)(e.target.value));
    await draw(month);
  }));

  // ----- Facilities and their accounts -----
  $('#refFacilitiesBtn').addEventListener('click', () => guard(facilitiesDialog)());
  async function facilitiesDialog() {
    const { rows } = await api('/admin/facilities');
    openDialog(
      `<h2>Referring facilities</h2>
       <div class="dir-actions" style="margin:0 0 10px"><button class="btn sm" type="button" data-fac-add>+ Add facility</button></div>
       <div class="table-wrap"><table><thead><tr><th>Facility</th><th>Type</th><th>SMS number</th><th>Accounts</th><th>Referrals</th><th></th></tr></thead><tbody>
       ${rows.map((f) => `<tr${f.active ? '' : ' style="opacity:.6"'}><td><b>${esc(f.name)}</b><div class="sub">${esc(f.municipality || '')}${f.contact_person ? ` · ${esc(f.contact_person)}` : ''}</div></td>
         <td class="small">${esc(f.type_label)}</td><td class="small">${esc(f.phone || '—')}</td><td>${f.users}</td><td>${f.referrals}</td>
         <td class="nowrap"><button class="btn sm secondary" type="button" data-fac-edit="${f.id}">Edit</button> <button class="btn sm secondary" type="button" data-fac-users="${f.id}">Accounts</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No facilities yet.</td></tr>'}
       </tbody></table></div>
       <p class="small muted" style="margin-top:10px">Facility staff log in at <b>${esc(location.origin)}/facility</b>.</p>`,
      async () => {},
      { wide: true, saveLabel: 'Done' },
    );
    $('#dlgForm').onclick = (e) => {
      if (e.target.closest('[data-fac-add]')) return facilityDialog({});
      const ed = e.target.closest('[data-fac-edit]');
      if (ed) return facilityDialog(rows.find((f) => f.id === Number(ed.dataset.facEdit)));
      const us = e.target.closest('[data-fac-users]');
      if (us) return guard(facilityUsersDialog)(rows.find((f) => f.id === Number(us.dataset.facUsers)));
    };
  }

  function facilityDialog(f) {
    openDialog(
      `<h2>${f.id ? 'Edit facility' : 'Add facility'}</h2>
       <div class="grid grid-2">
         <label class="field span-2">Facility name<input name="name" value="${esc(f.name || '')}" required></label>
         <label class="field">Type<select name="type">${Object.entries(refOpts.facility_types).map(([k, v]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
         <label class="field">Municipality / city<input name="municipality" value="${esc(f.municipality || '')}"></label>
         <label class="field">Contact person<input name="contact_person" value="${esc(f.contact_person || '')}"></label>
         <label class="field">Mobile for SMS<span class="hint">Gets an SMS when ZRMC accepts or redirects a referral</span><input name="phone" type="tel" value="${esc(f.phone || '')}"></label>
         <label class="field">Email<input name="email" type="email" value="${esc(f.email || '')}"></label>
         <label style="display:flex;gap:8px;align-items:center;margin-top:22px"><input type="checkbox" name="active" ${f.active === false ? '' : 'checked'}> Active (can send referrals)</label>
       </div>`,
      async (d) => {
        const body = { ...d, active: $('#dlgForm [name=active]').checked };
        if (f.id) await api(`/admin/facilities/${f.id}`, { method: 'PATCH', body });
        else await api('/admin/facilities', { method: 'POST', body });
        await loadRefOptions();
        setTimeout(() => guard(facilitiesDialog)(), 0);
      },
      { wide: true },
    );
  }

  async function facilityUsersDialog(f) {
    const { rows } = await api(`/admin/facilities/${f.id}/users`);
    openDialog(
      `<h2>Accounts — ${esc(f.name)}</h2>
       <div class="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
       ${rows.map((x) => `<tr><td class="mono">${esc(x.username)}</td><td>${esc(x.full_name)}</td><td>${x.active ? '<span class="badge COMPLETED">Active</span>' : '<span class="badge CANCELLED">Inactive</span>'}</td>
         <td class="small">${esc(x.last_login_at || 'Never')}</td>
         <td class="nowrap"><button class="btn sm secondary" type="button" data-fu-toggle="${x.id}" data-active="${x.active}">${x.active ? 'Deactivate' : 'Activate'}</button>
           <button class="btn sm secondary" type="button" data-fu-pw="${x.id}">Reset password</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No accounts yet.</td></tr>'}
       </tbody></table></div>
       <h3 style="margin-top:14px">Add account</h3>
       <div class="grid grid-3">
         <label class="field">Full name<input name="full_name"></label>
         <label class="field">Username<input name="username" autocomplete="off"></label>
         <label class="field">Temporary password<input name="password" type="password" autocomplete="new-password"></label>
       </div>
       <p class="small muted">Give the username and temporary password to the facility; they can change it under Account after logging in at /facility.</p>`,
      async (d) => {
        if (d.username || d.full_name || d.password) {
          await api(`/admin/facilities/${f.id}/users`, { method: 'POST', body: { username: d.username, full_name: d.full_name, password: d.password } });
        }
        setTimeout(() => guard(facilityUsersDialog)(f), 0);
      },
      { wide: true, saveLabel: 'Add account' },
    );
    $('#dlgForm').onclick = guard(async (e) => {
      const t = e.target.closest('[data-fu-toggle]');
      if (t) {
        await api(`/admin/facility-users/${t.dataset.fuToggle}`, { method: 'PATCH', body: { active: t.dataset.active !== 'true' } });
        return facilityUsersDialog(f);
      }
      const p = e.target.closest('[data-fu-pw]');
      if (p) {
        const pw = prompt('New password for this account (at least 8 characters):');
        if (!pw) return;
        await api(`/admin/facility-users/${p.dataset.fuPw}/password`, { method: 'POST', body: { password: pw } });
        alert('Password reset. The user is signed out and must log in with the new password.');
      }
    });
  }

  // ---------- OPD Schedules ----------
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const shiftMonth = (m, n) => {
    const d = new Date(`${m}-01T00:00:00`);
    d.setMonth(d.getMonth() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  let schedMonth = cat.today.slice(0, 7);
  let schedData = { clinics: [], holidays: [] };

  loaders.schedules = guard(async () => {
    schedData = await api(`/admin/opd/schedules?month=${schedMonth}`);
    $('#monthLabel').textContent = monthLabel(schedMonth);
    const active = schedData.clinics.filter((c) => c.active);
    const set = active.filter((c) => c.schedule && !c.schedule.carried_over).length;
    const status = $('#schedStatus');
    status.className = `alert small ${set === active.length ? 'ok' : 'warn'}`;
    status.innerHTML =
      set === active.length
        ? `All ${active.length} clinics have their ${esc(monthLabel(schedMonth))} schedule.`
        : `<b>${set} of ${active.length} clinics</b> have a schedule set for ${esc(monthLabel(schedMonth))}. The others use their latest earlier schedule until you set this month — use <b>Copy last month to this month</b>, then adjust what changed.`;
    $('#schedRows').innerHTML = schedData.clinics
      .map((c) => {
        const s = c.schedule;
        const state = !c.active
          ? '<span class="badge CANCELLED">Hidden</span>'
          : !s
            ? '<span class="badge FAILED">Not scheduled</span>'
            : s.carried_over
              ? `<span class="badge PROCESSING">Carried over</span><div class="sub">from ${esc(monthLabel(s.source_month))}</div>`
              : `<span class="badge COMPLETED">Set</span><div class="sub">by ${esc(s.updated_by || '')}</div>`;
        const changes = s ? [s.closed_dates.length && `${s.closed_dates.length} closed`, s.extra_dates.length && `${s.extra_dates.length} extra`].filter(Boolean).join(', ') : '';
        return `<tr${c.active ? '' : ' style="opacity:.6"'}>
          <td><b>${esc(c.name)}</b><div class="sub mono">${esc(c.code)}</div></td>
          <td>${s ? esc(s.summary) : '<span class="muted">—</span>'}${s?.note ? `<div class="sub">${esc(s.note)}</div>` : ''}</td>
          <td class="small">${s ? `${s.slot_minutes} min · ${s.per_slot} per slot` : ''}</td>
          <td class="small">${esc(changes) || '<span class="muted">—</span>'}</td>
          <td>${state}</td>
          <td class="no-print nowrap"><button class="btn sm" data-edit-sched="${esc(c.code)}">Edit</button>
            <button class="btn sm secondary" data-edit-clinic="${esc(c.code)}">Clinic</button></td>
        </tr>`;
      })
      .join('');
    $('#schedHolidays').textContent = schedData.holidays.length
      ? `Hospital closed dates this month (Settings): ${schedData.holidays.map((h) => `${fmtDate(h.date, { month: 'short', day: 'numeric' })} – ${h.reason}`).join('; ')}. Clinics are closed on these days unless you add the date as an extra clinic day.`
      : '';
  });

  $('#prevMonth').addEventListener('click', () => ((schedMonth = shiftMonth(schedMonth, -1)), loaders.schedules()));
  $('#nextMonth').addEventListener('click', () => ((schedMonth = shiftMonth(schedMonth, 1)), loaders.schedules()));
  $('#copyPrevBtn').addEventListener('click', guard(async () => {
    const { copied } = await api(`/admin/opd/schedules/${schedMonth}/copy-previous`, { method: 'POST' });
    alert(copied ? `Copied the latest schedule of ${copied} clinic(s) into ${monthLabel(schedMonth)}. Now edit the clinics whose schedule changed.` : 'Every clinic already has a schedule for this month.');
    loaders.schedules();
  }));
  $('#addClinicBtn').addEventListener('click', () =>
    openDialog(
      `<h2>Add clinic</h2>
       <label class="field">Clinic name<input name="name" data-nocaps required placeholder="e.g. Cardiology"></label>
       <p class="muted small">After adding it, click <b>Edit</b> to set its schedule. Patients can book once it has one.</p>`,
      async (d) => {
        await api('/admin/opd/clinics', { method: 'POST', body: { name: d.name } });
        loaders.schedules();
      },
    ),
  );

  function clinicDialog(c) {
    openDialog(
      `<h2>Clinic</h2>
       <div class="grid">
         <label class="field">Name<input name="name" data-nocaps value="${esc(c.name)}" required></label>
         <label class="field">Order<span class="hint">Lower numbers appear first</span><input name="sort_order" type="number" value="${c.sort_order}"></label>
         <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Show and allow booking</label>
       </div>`,
      async (d) => {
        await api(`/admin/opd/clinics/${encodeURIComponent(c.code)}`, { method: 'PATCH', body: { name: d.name, sort_order: d.sort_order, active: $('#dlgForm [name=active]').checked } });
        loaders.schedules();
      },
    );
  }

  function scheduleDialog(c) {
    const s = c.schedule || { days: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '12:00', slot_minutes: 30, per_slot: 4, closed_dates: [], extra_dates: [], note: '' };
    const closed = new Set(s.closed_dates);
    const extra = new Set(s.extra_dates);
    const holidays = new Map(schedData.holidays.map((h) => [h.date, h.reason]));
    const [y, m] = schedMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstDow = new Date(y, m - 1, 1).getDay();
    const dateOf = (d) => `${schedMonth}-${String(d).padStart(2, '0')}`;
    const order = [1, 2, 3, 4, 5, 6, 0];

    openDialog(
      `<h2>${esc(c.name)} — ${esc(monthLabel(schedMonth))}</h2>
       ${s.carried_over ? `<div class="alert info small">Pre-filled from ${esc(monthLabel(s.source_month))}. Saving sets this month's schedule.</div>` : ''}
       <div class="grid">
         <div class="field">Clinic days<div class="weekday-pick">${order
           .map((d) => `<label><input type="checkbox" name="dow" value="${d}" ${s.days.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`)
           .join('')}</div></div>
         <div class="grid grid-2">
           <label class="field">Start time<input type="time" name="start_time" value="${esc(s.start_time)}" required></label>
           <label class="field">End time<input type="time" name="end_time" value="${esc(s.end_time)}" required></label>
           <label class="field">Minutes per slot<input type="number" name="slot_minutes" min="5" max="240" step="5" value="${s.slot_minutes}" required></label>
           <label class="field">Patients per slot<input type="number" name="per_slot" min="1" max="200" value="${s.per_slot}" required></label>
         </div>
         <p class="small muted" id="slotPreview" style="margin:0"></p>
         <div class="field">Dates this month<span class="hint">Click a clinic day to close it (e.g. doctor on leave). Click any other day to add an extra clinic day.</span>
           <div class="cal" id="schedCal"></div>
           <div class="cal-legend"><span class="l-open">Clinic day</span><span class="l-extra">Extra day</span><span class="l-closed">Closed</span><span class="l-holiday">Hospital closed</span></div>
           <p class="small" id="calSummary" style="margin:6px 0 0"></p>
         </div>
         <label class="field">Note for patients (optional)<span class="hint">Shown on the booking page and directory, e.g. "Dr. Santos on leave Nov 18–20"</span><input name="note" data-nocaps maxlength="300" value="${esc(s.note || '')}"></label>
       </div>`,
      async (d) => {
        const days = $$('#dlgForm [name=dow]:checked').map((x) => Number(x.value));
        await api(`/admin/opd/schedules/${encodeURIComponent(c.code)}/${schedMonth}`, {
          method: 'PUT',
          body: { days, start_time: d.start_time, end_time: d.end_time, slot_minutes: d.slot_minutes, per_slot: d.per_slot, note: d.note, closed_dates: [...closed], extra_dates: [...extra] },
        });
        loaders.schedules();
      },
      { wide: true },
    );

    const weekdays = () => new Set($$('#dlgForm [name=dow]:checked').map((x) => Number(x.value)));
    function drawCal() {
      const wd = weekdays();
      let html = order.map((d) => `<span class="dow">${DOW[d]}</span>`).join('');
      html += '<span></span>'.repeat((firstDow + 6) % 7);
      let open = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const date = dateOf(d);
        const dow = new Date(y, m - 1, d).getDay();
        let cls = '';
        let tag = '';
        if (extra.has(date)) (cls = 'extra'), (tag = 'extra');
        else if (closed.has(date)) (cls = 'closed'), (tag = 'closed');
        else if (holidays.has(date)) (cls = 'holiday'), (tag = 'holiday');
        else if (wd.has(dow)) cls = 'open';
        if (cls === 'open' || cls === 'extra') open++;
        html += `<button type="button" class="${cls}" data-date="${date}" title="${esc(holidays.get(date) || '')}">${d}${tag ? `<small>${tag}</small>` : ''}</button>`;
      }
      $('#schedCal').innerHTML = html;
      $('#calSummary').textContent = `${open} clinic day(s) in ${monthLabel(schedMonth)}.`;
    }
    function drawSlots() {
      const [sh, sm] = ($('#dlgForm [name=start_time]').value || '0:0').split(':').map(Number);
      const [eh, em] = ($('#dlgForm [name=end_time]').value || '0:0').split(':').map(Number);
      const len = Number($('#dlgForm [name=slot_minutes]').value);
      const per = Number($('#dlgForm [name=per_slot]').value);
      const n = len > 0 ? Math.floor((eh * 60 + em - (sh * 60 + sm)) / len) : 0;
      $('#slotPreview').textContent = n > 0 ? `${n} time slot(s) a day × ${per || 0} patient(s) = up to ${n * (per || 0)} patients per clinic day.` : 'End time must be after the start time.';
    }
    $('#schedCal').addEventListener('click', (e) => {
      const b = e.target.closest('[data-date]');
      if (!b) return;
      const date = b.dataset.date;
      const regular = weekdays().has(new Date(`${date}T00:00:00`).getDay()) && !holidays.has(date);
      if (extra.has(date)) extra.delete(date);
      else if (closed.has(date)) closed.delete(date);
      else if (regular) closed.add(date);
      else extra.add(date);
      drawCal();
    });
    $$('#dlgForm [name=dow]').forEach((x) => x.addEventListener('change', drawCal));
    $$('#dlgForm [name=start_time], #dlgForm [name=end_time], #dlgForm [name=slot_minutes], #dlgForm [name=per_slot]').forEach((x) => x.addEventListener('input', drawSlots));
    drawCal();
    drawSlots();
  }

  $('#schedRows').addEventListener('click', (e) => {
    const es = e.target.closest('[data-edit-sched]');
    const ec = e.target.closest('[data-edit-clinic]');
    const c = schedData.clinics.find((x) => x.code === (es || ec)?.dataset.editSched || x.code === (es || ec)?.dataset.editClinic);
    if (!c) return;
    if (es) scheduleDialog(c);
    else clinicDialog(c);
  });

  // ---------- Hospital Directory ----------
  let dir = { entries: [], guides: [], maps: [], contact: [], categories: [], clinics: [] };
  const optList = (items, sel, empty) =>
    (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
    items.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const shown = (on) => (on ? '<span class="badge COMPLETED">Shown</span>' : '<span class="badge CANCELLED">Hidden</span>');

  loaders.directory = guard(async () => {
    dir = await api('/admin/directory');
    const mapTitle = (id) => dir.maps.find((m) => m.id === id)?.title;
    $('#entryRows').innerHTML =
      dir.entries
        .map(
          (e) => `<tr>
        <td class="small">${e.sort_order}</td>
        <td><b>${esc(e.name)}</b><div class="sub">${esc(e.category)}${e.opd_code ? ' · linked to OPD booking' : ''}</div></td>
        <td class="small">${esc(e.location || '') || '<span class="muted">—</span>'}</td>
        <td class="small">${esc(e.hours || '')}${e.phone ? `<div class="sub">${esc(e.phone)}</div>` : ''}</td>
        <td class="small">${e.map_id ? `${esc(mapTitle(e.map_id) || '')}${e.pin_x !== null ? ' 📍' : ' <span class="muted">(no pin)</span>'}` : '<span class="muted">—</span>'}</td>
        <td>${shown(e.active)}</td>
        <td class="nowrap"><button class="btn sm secondary" data-edit-entry="${e.id}">Edit</button> <button class="btn sm secondary" data-del-entry="${e.id}">Delete</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">No places yet.</td></tr>';
    $('#adminMaps').innerHTML =
      dir.maps
        .map(
          (m) => `<div class="card map-card" style="cursor:default">
          <img src="${esc(m.url)}" alt="">
          <b>${esc(m.title)}</b>${m.description ? `<span class="muted small">${esc(m.description)}</span>` : ''}
          <span class="small muted">${dir.entries.filter((e) => e.map_id === m.id && e.pin_x !== null).length} pinned place(s)</span>
          <div class="dir-actions"><button class="btn sm" data-way-map="${m.id}">Wayfinding</button><button class="btn sm secondary" data-edit-map="${m.id}">Edit</button><button class="btn sm secondary" data-del-map="${m.id}">Delete</button></div>
        </div>`,
        )
        .join('') || '<p class="muted small">No maps uploaded yet.</p>';
    $('#guideRows').innerHTML =
      dir.guides
        .map(
          (g) => `<tr>
        <td class="small">${g.sort_order}</td>
        <td><b>${esc(g.title)}</b>${g.summary ? `<div class="sub">${esc(g.summary)}</div>` : ''}</td>
        <td class="small" style="white-space:pre-line;max-width:380px">${esc(g.requirements || '')}</td>
        <td>${shown(g.active)}</td>
        <td class="nowrap"><button class="btn sm secondary" data-edit-guide="${g.id}">Edit</button> <button class="btn sm secondary" data-del-guide="${g.id}">Delete</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="5" class="empty">No guides yet.</td></tr>';
    $('#contactForm').innerHTML =
      dir.contact
        .map((f) =>
          f.key === 'notice' || f.key === 'address'
            ? `<label class="field span-2">${esc(f.label)}<textarea name="${f.key}" rows="2" data-nocaps>${esc(f.value)}</textarea></label>`
            : `<label class="field">${esc(f.label)}<input name="${f.key}" value="${esc(f.value)}" data-nocaps></label>`,
        )
        .join('') + '<div class="span-2"><button class="btn" type="submit">Save contact information</button> <span class="small" id="contactSaved"></span></div>';
  });

  $('#contactForm').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('/admin/directory/contact', { method: 'PUT', body: formData(e.target) });
    $('#contactSaved').textContent = 'Saved.';
    setTimeout(() => ($('#contactSaved').textContent = ''), 3000);
  }));

  // Click on the map to place the pin (stored as % of width/height, so it works at any size)
  function wirePinPicker() {
    const sel = $('#dlgForm [name=map_id]');
    const box = $('#pinPicker');
    const draw = () => {
      const m = dir.maps.find((x) => String(x.id) === sel.value);
      if (!m) {
        box.innerHTML = '';
        box.classList.add('hidden');
        return;
      }
      box.classList.remove('hidden');
      box.innerHTML = `<img src="${esc(m.url)}" alt="">`;
      const x = $('#dlgForm [name=pin_x]').value;
      const y = $('#dlgForm [name=pin_y]').value;
      if (x !== '' && y !== '') box.insertAdjacentHTML('beforeend', `<span class="mv-pin on" style="left:${x}%;top:${y}%">●</span>`);
    };
    sel.addEventListener('change', () => {
      $('#dlgForm [name=pin_x]').value = '';
      $('#dlgForm [name=pin_y]').value = '';
      draw();
      // Bring the map into view so the next step (clicking on it) is obvious
      box.querySelector('img')?.addEventListener('load', () => box.scrollIntoView({ block: 'center', behavior: 'smooth' }), { once: true });
    });
    box.addEventListener('click', (ev) => {
      const r = box.querySelector('img').getBoundingClientRect();
      $('#dlgForm [name=pin_x]').value = (((ev.clientX - r.left) / r.width) * 100).toFixed(2);
      $('#dlgForm [name=pin_y]').value = (((ev.clientY - r.top) / r.height) * 100).toFixed(2);
      draw();
    });
    draw();
  }

  function entryDialog(e = {}) {
    openDialog(
      `<h2>${e.id ? 'Edit place' : 'Add place'}</h2>
       <div class="grid grid-2">
         <label class="field">Name<input name="name" data-nocaps value="${esc(e.name || '')}" required></label>
         <label class="field">Category<select name="category">${optList(dir.categories.map((c) => [c, c]), e.category || 'Department')}</select></label>
         <label class="field span-2">Short description<textarea name="description" rows="2" data-nocaps>${esc(e.description || '')}</textarea></label>
         <label class="field span-2">Location<span class="hint">Building, floor, room or landmark, e.g. "Main Building, 2nd floor, beside the pharmacy"</span><input name="location" data-nocaps value="${esc(e.location || '')}"></label>
         <label class="field">Hours<span class="hint">Leave blank for OPD clinics to use their booking schedule</span><input name="hours" data-nocaps value="${esc(e.hours || '')}"></label>
         <label class="field">Phone / local<input name="phone" data-nocaps value="${esc(e.phone || '')}"></label>
         <label class="field">Email<input name="email" type="email" value="${esc(e.email || '')}"></label>
         <label class="field">OPD clinic (for schedule &amp; booking)<select name="opd_code">${optList(dir.clinics.map((c) => [c.code, c.name]), e.opd_code, 'Not an OPD clinic')}</select></label>
         <label class="field span-2">Services<span class="hint">One per line</span><textarea name="services" rows="3" data-nocaps>${esc(e.services || '')}</textarea></label>
         <label class="field span-2">Search words<span class="hint">Other words people may search for, separated by commas</span><input name="keywords" data-nocaps value="${esc(e.keywords || '')}"></label>
         <label class="field span-2">Map<select name="map_id">${optList(dir.maps.map((m) => [m.id, m.title]), e.map_id, 'Not on a map')}</select>
           <span class="hint">Choose a map, then click on it where this place is. Click again to move the pin.</span></label>
         <div class="span-2 pin-picker hidden" id="pinPicker"></div>
         <input type="hidden" name="pin_x" value="${e.pin_x ?? ''}"><input type="hidden" name="pin_y" value="${e.pin_y ?? ''}">
         <label class="field">Order<span class="hint">Lower numbers appear first</span><input name="sort_order" type="number" value="${e.sort_order ?? 100}"></label>
         <label style="display:flex;gap:8px;align-items:center;margin-top:22px"><input type="checkbox" name="active" ${e.active === false ? '' : 'checked'}> Show on the public directory</label>
       </div>`,
      async (d) => {
        const body = { ...d, active: $('#dlgForm [name=active]').checked };
        if (e.id) await api(`/admin/directory/entries/${e.id}`, { method: 'PATCH', body });
        else await api('/admin/directory/entries', { method: 'POST', body });
        loaders.directory();
      },
      { wide: true },
    );
    wirePinPicker();
  }

  function guideDialog(g = {}) {
    openDialog(
      `<h2>${g.id ? 'Edit guide' : 'Add guide'}</h2>
       <div class="grid">
         <label class="field">Title<input name="title" data-nocaps value="${esc(g.title || '')}" required placeholder="e.g. Getting a Medical Certificate"></label>
         <label class="field">Short summary<input name="summary" data-nocaps value="${esc(g.summary || '')}"></label>
         <label class="field">What to bring<span class="hint">One requirement per line</span><textarea name="requirements" rows="5" data-nocaps>${esc(g.requirements || '')}</textarea></label>
         <label class="field">Steps<span class="hint">One step per line</span><textarea name="steps" rows="5" data-nocaps>${esc(g.steps || '')}</textarea></label>
         <label class="field">Where to go<select name="office_id">${optList(dir.entries.map((e) => [e.id, e.name]), g.office_id, '—')}</select></label>
         <div class="grid grid-2">
           <label class="field">Button link (optional)<span class="hint">e.g. /request-records or an https:// address</span><input name="link_url" data-nocaps value="${esc(g.link_url || '')}"></label>
           <label class="field">Button text<input name="link_label" data-nocaps value="${esc(g.link_label || '')}"></label>
           <label class="field">Order<input name="sort_order" type="number" value="${g.sort_order ?? 100}"></label>
           <label style="display:flex;gap:8px;align-items:center;margin-top:22px"><input type="checkbox" name="active" ${g.active === false ? '' : 'checked'}> Show on the public directory</label>
         </div>
       </div>`,
      async (d) => {
        const body = { ...d, active: $('#dlgForm [name=active]').checked };
        if (g.id) await api(`/admin/directory/guides/${g.id}`, { method: 'PATCH', body });
        else await api('/admin/directory/guides', { method: 'POST', body });
        loaders.directory();
      },
      { wide: true },
    );
  }

  // Shrink large photos in the browser before upload (max 2000 px, keeps uploads small)
  async function readMapImage(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Please choose a PNG, JPG or WebP image.');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That image could not be read.'));
        i.src = url;
      });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
        return await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.readAsDataURL(file);
        });
      }
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const webp = c.toDataURL('image/webp', 0.9);
      return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.88);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function mapDialog(m = {}) {
    openDialog(
      `<h2>${m.id ? 'Edit map' : 'Upload map'}</h2>
       <div class="grid">
         <label class="field">Title<input name="title" data-nocaps value="${esc(m.title || '')}" required placeholder="e.g. Main Building – Ground Floor"></label>
         <label class="field">Description<input name="description" data-nocaps value="${esc(m.description || '')}"></label>
         <label class="field">Image${m.id ? '<span class="hint">Leave empty to keep the current image. Pins stay where they are, so only replace it with the same plan.</span>' : ''}
           <input type="file" name="file" accept="image/png,image/jpeg,image/webp" ${m.id ? '' : 'required'}></label>
         <img id="mapPreview" alt="" style="max-width:100%;border-radius:8px;${m.url ? '' : 'display:none'}" src="${esc(m.url || '')}">
         <label class="field">Order<input name="sort_order" type="number" value="${m.sort_order ?? 100}"></label>
       </div>`,
      async (d) => {
        const file = $('#dlgForm [name=file]').files[0];
        const body = { title: d.title, description: d.description, sort_order: d.sort_order };
        if (file) body.image = await readMapImage(file);
        if (m.id) await api(`/admin/maps/${m.id}`, { method: 'PATCH', body });
        else await api('/admin/maps', { method: 'POST', body });
        loaders.directory();
      },
      { wide: true },
    );
    $('#dlgForm [name=file]').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      $('#mapPreview').src = URL.createObjectURL(f);
      $('#mapPreview').style.display = '';
    });
  }


  // ---------- Wayfinding editor (points, paths and directory links on a map) ----------
  const WAY_KINDS = { GATE: 'Gate / entrance', BUILDING: 'Building', LANDMARK: 'Landmark', JUNCTION: 'Path junction (no name)' };
  async function wayEditor(mapId) {
    const data = await api(`/admin/wayfinding/${mapId}`);
    const map = dir.maps.find((m) => m.id === mapId);
    let tmpSeq = 0;
    const st = {
      points: data.points.map((p) => ({ ...p, key: `id:${p.id}` })),
      edges: data.paths.map((e) => ({ a: `id:${e.a}`, b: `id:${e.b}`, step_free: e.step_free })),
      links: new Map(data.entries.filter((e) => e.way_point_id && data.points.some((p) => p.id === e.way_point_id)).map((e) => [e.id, `id:${e.way_point_id}`])),
      mode: 'select',
      sel: null, // { type: 'point', key } | { type: 'edge', i }
      connectFrom: null,
      measure: [],
      zoom: 1,
      ratio: 1,
      dirty: false,
    };
    const P = (key) => st.points.find((p) => p.key === key);
    const MODES = { select: 'Select / move', add: 'Add points', connect: 'Connect', delete: 'Delete', measure: 'Measure scale' };
    const HELP = {
      select: 'Drag a point to move it. Click a point or a path to edit it.',
      add: 'Click the map to add a point; it is joined to the selected point, so you can trace a road click by click. Click an existing point to continue from it.',
      connect: 'Click two points to join them with a path (or to remove the path between them).',
      delete: 'Click a point or a path to delete it.',
      measure: 'Click two places whose real distance you know (e.g. the ends of a building), then type the distance.',
    };
    openDialog(
      `<h2>Wayfinding — ${esc(map.title)}</h2>
       <div class="we-bar">
         <div class="we-modes" role="toolbar">${Object.entries(MODES).map(([k, l]) => `<button type="button" class="btn sm secondary" data-we-mode="${k}">${l}</button>`).join('')}</div>
         <div class="we-zoom"><button type="button" class="btn sm secondary" data-we-zoom="-1" aria-label="Zoom out">−</button><button type="button" class="btn sm secondary" data-we-zoom="1" aria-label="Zoom in">+</button></div>
       </div>
       <p class="muted small" id="weHelp" style="margin:6px 0"></p>
       <div class="we-body"><div class="we-canvas" id="weCanvas"><img src="${esc(map.url)}" alt="" id="weImg" draggable="false">
         <svg id="weSvg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg><div id="wePts"></div></div></div>
       <div class="we-panel" id="wePanel"></div>
       <div class="grid grid-2" style="margin-top:10px">
         <label class="field">Real width of the whole map (meters)<span class="hint">For distances and walking times; use <b>Measure scale</b> if unsure. Blank = no distances shown.</span>
           <input name="width_m" type="number" min="5" max="20000" step="any" value="${map.width_m ?? data.map.width_m ?? ''}"></label>
         <div class="field"><span>"You are here" QR signs</span><span class="hint">One sign per starting point, linking to directions from that spot. Save first.</span>
           <button type="button" class="btn sm secondary" id="weSigns" style="align-self:flex-start">Print signs</button></div>
       </div>
       <p class="muted small" id="weStats"></p>`,
      async (d) => {
        const body = {
          width_m: d.width_m,
          points: st.points.map((p) => ({ id: p.id || undefined, tmp: p.id ? undefined : p.key.slice(4), name: p.name, code: p.code, kind: p.kind, x: p.x, y: p.y, is_start: p.is_start })),
          paths: st.edges.map((e) => ({ a_key: e.a, b_key: e.b, step_free: e.step_free })),
          links: data.entries.map((e) => ({ entry_id: e.id, point: st.links.get(e.id) || null })).filter((l) => l.point || data.entries.find((e) => e.id === l.entry_id).way_point_id),
        };
        await api(`/admin/wayfinding/${mapId}`, { method: 'PUT', body });
        loaders.directory();
      },
      { wide: true, saveLabel: 'Save wayfinding' },
    );
    $('#dlg').classList.add('we-dialog');
    // Enter in a field just applies it (it would otherwise press the first button, Close)
    $('#dlgForm').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.matches('input')) {
        ev.preventDefault();
        ev.target.dispatchEvent(new Event('change'));
      }
    });
    $('#dlgForm [value=cancel]').addEventListener('click', (ev) => {
      if (st.dirty && !confirm('Close without saving your wayfinding changes?')) ev.preventDefault();
    });
    $('#dlg').addEventListener('close', () => $('#dlg').classList.remove('we-dialog'), { once: true });
    const img = $('#weImg');
    const canvas = $('#weCanvas');
    const setRatio = () => img.naturalWidth && (st.ratio = img.naturalHeight / img.naturalWidth);
    img.complete ? setRatio() : img.addEventListener('load', () => (setRatio(), draw()), { once: true });

    const pos = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.min(100, Math.max(0, ((ev.clientX - r.left) / r.width) * 100)), y: Math.min(100, Math.max(0, ((ev.clientY - r.top) / r.height) * 100)) };
    };
    const edgeIndex = (a, b) => st.edges.findIndex((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    const touch = () => (st.dirty = true);

    function draw() {
      $('#weSvg').innerHTML = st.edges
        .map((e, i) => {
          const a = P(e.a);
          const b = P(e.b);
          const on = st.sel?.type === 'edge' && st.sel.i === i;
          return `<line class="hit" data-edge="${i}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/><line class="${e.step_free ? 'way' : 'way stairs'}${on ? ' on' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
        })
        .join('') + (st.measure.length === 1 ? `<circle cx="${st.measure[0].x}" cy="${st.measure[0].y}" r="0.6" class="measure"/>` : '');
      $('#wePts').innerHTML = st.points
        .map((p) => {
          const cls = ['we-pt', p.kind.toLowerCase(), p.is_start ? 'start' : '', st.sel?.type === 'point' && st.sel.key === p.key ? 'on' : '', st.connectFrom === p.key ? 'from' : ''].join(' ');
          return `<span class="${cls}" data-pt="${esc(p.key)}" style="left:${p.x}%;top:${p.y}%" title="${esc(p.name || 'Junction')}">${p.kind === 'BUILDING' && p.code ? esc(p.code) : ''}</span>`;
        })
        .join('');
      $('#weHelp').textContent = HELP[st.mode];
      $$('[data-we-mode]').forEach((b) => b.classList.toggle('on', b.dataset.weMode === st.mode));
      const named = st.points.filter((p) => p.name).length;
      $('#weStats').textContent = `${st.points.length} points (${named} named, ${st.points.filter((p) => p.is_start).length} starting points) · ${st.edges.length} paths · ${st.links.size} directory places linked${st.dirty ? ' · not saved yet' : ''}`;
      panel();
    }

    function panel() {
      const box = $('#wePanel');
      if (st.sel?.type === 'edge') {
        const e = st.edges[st.sel.i];
        box.innerHTML = `<b>Path</b> between ${esc(P(e.a).name || 'junction')} and ${esc(P(e.b).name || 'junction')}
          <label class="check"><input type="checkbox" id="weStairs" ${e.step_free ? '' : 'checked'}> Has stairs or steps (left out of the step-free route)</label>
          <button type="button" class="btn sm danger" id="weDelEdge">Delete path</button>`;
        $('#weStairs').onchange = (ev) => ((e.step_free = !ev.target.checked), touch(), draw());
        $('#weDelEdge').onclick = () => (st.edges.splice(st.sel.i, 1), (st.sel = null), touch(), draw());
        return;
      }
      const p = st.sel?.type === 'point' && P(st.sel.key);
      if (!p) {
        box.innerHTML = '<p class="muted small" style="margin:0">Select a point or a path to edit it.</p>';
        return;
      }
      const here = data.entries.filter((e) => st.links.get(e.id) === p.key);
      box.innerHTML = `<div class="grid grid-2">
          <label class="field">Name<input id="weName" value="${esc(p.name || '')}" placeholder="e.g. MAIN GATE, E.R. BUILDING"></label>
          <label class="field">Type<select id="weKind">${Object.entries(WAY_KINDS).map(([k, l]) => `<option value="${k}"${k === p.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">Building no. on the map<input id="weCode" value="${esc(p.code || '')}" maxlength="10"></label>
          <label class="check" style="align-self:end"><input type="checkbox" id="weStart" ${p.is_start ? 'checked' : ''}> Starting point ("You are here" sign)</label>
        </div>
        <label class="field">Directory places here<span class="hint">Offices or clinics inside this building, so visitors can get directions to them</span>
          <select id="weAddLink"><option value="">+ Add a place…</option>${data.entries.filter((e) => st.links.get(e.id) !== p.key).map((e) => `<option value="${e.id}">${esc(e.name)}${st.links.get(e.id) ? ' (move here)' : ''}</option>`).join('')}</select></label>
        <div class="we-links">${here.map((e) => `<span class="chip">${esc(e.name)} <button type="button" data-unlink="${e.id}" aria-label="Remove ${esc(e.name)}">×</button></span>`).join('') || '<span class="muted small">None</span>'}</div>
        <button type="button" class="btn sm danger" id="weDelPt">Delete point</button>`;
      const upd = (k, v) => ((p[k] = v), touch(), draw());
      $('#weName').onchange = (ev) => upd('name', ev.target.value.trim().toUpperCase());
      $('#weKind').onchange = (ev) => upd('kind', ev.target.value);
      $('#weCode').onchange = (ev) => upd('code', ev.target.value.trim().toUpperCase());
      $('#weStart').onchange = (ev) => upd('is_start', ev.target.checked);
      $('#weAddLink').onchange = (ev) => ev.target.value && (st.links.set(Number(ev.target.value), p.key), touch(), draw());
      box.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = () => (st.links.delete(Number(b.dataset.unlink)), touch(), draw())));
      $('#weDelPt').onclick = () => removePoint(p.key);
    }

    function removePoint(key) {
      st.points = st.points.filter((p) => p.key !== key);
      st.edges = st.edges.filter((e) => e.a !== key && e.b !== key);
      for (const [k, v] of st.links) if (v === key) st.links.delete(k);
      st.sel = null;
      touch();
      draw();
    }

    // Map clicks and point dragging
    let drag = null;
    canvas.addEventListener('pointerdown', (ev) => {
      const ptEl = ev.target.closest('[data-pt]');
      if (ptEl && st.mode === 'select') {
        st.sel = { type: 'point', key: ptEl.dataset.pt };
        drag = { key: ptEl.dataset.pt, moved: false };
        canvas.setPointerCapture(ev.pointerId);
        draw();
        ev.preventDefault();
      }
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const p = P(drag.key);
      Object.assign(p, pos(ev));
      drag.moved = true;
      touch();
      const el = $(`#wePts [data-pt="${CSS.escape(drag.key)}"]`);
      el.style.left = `${p.x}%`;
      el.style.top = `${p.y}%`;
    });
    canvas.addEventListener('pointerup', () => {
      if (drag?.moved) draw();
      drag = null;
    });
    canvas.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-pt]') && st.mode === 'select') return; // handled by pointerdown
      const ptKey = ev.target.closest('[data-pt]')?.dataset.pt;
      const edge = ev.target.closest('[data-edge]')?.dataset.edge;
      const at = pos(ev);
      if (st.mode === 'measure') {
        st.measure.push(at);
        if (st.measure.length === 2) {
          const [a, b] = st.measure;
          st.measure = [];
          const frac = Math.hypot((b.x - a.x) / 100, ((b.y - a.y) / 100) * st.ratio);
          const meters = Number(prompt('Real distance between the two places, in meters:'));
          if (meters > 0 && frac > 0) {
            $('#dlgForm [name=width_m]').value = Math.round(meters / frac);
            touch();
          }
        }
        return draw();
      }
      if (st.mode === 'delete') {
        if (ptKey) return removePoint(ptKey);
        if (edge !== undefined) return st.edges.splice(Number(edge), 1), touch(), draw();
        return;
      }
      if (st.mode === 'connect') {
        if (!ptKey) return;
        if (!st.connectFrom) st.connectFrom = ptKey;
        else if (st.connectFrom === ptKey) st.connectFrom = null;
        else {
          const i = edgeIndex(st.connectFrom, ptKey);
          if (i >= 0) st.edges.splice(i, 1);
          else st.edges.push({ a: st.connectFrom, b: ptKey, step_free: true });
          st.connectFrom = ptKey; // keep chaining
          touch();
        }
        return draw();
      }
      if (st.mode === 'add') {
        if (ptKey) {
          st.sel = { type: 'point', key: ptKey };
          return draw();
        }
        const key = `tmp:${++tmpSeq}`;
        st.points.push({ key, name: '', code: '', kind: 'JUNCTION', x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100, is_start: false });
        if (st.sel?.type === 'point') st.edges.push({ a: st.sel.key, b: key, step_free: true });
        st.sel = { type: 'point', key };
        touch();
        return draw();
      }
      // select mode: paths
      if (edge !== undefined) st.sel = { type: 'edge', i: Number(edge) };
      else if (!ptKey) st.sel = null;
      draw();
    });

    $$('[data-we-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        st.mode = b.dataset.weMode;
        st.connectFrom = null;
        st.measure = [];
        draw();
      }),
    );
    $$('[data-we-zoom]').forEach((b) =>
      b.addEventListener('click', () => {
        st.zoom = Math.min(4, Math.max(1, st.zoom + Number(b.dataset.weZoom) * 0.5));
        canvas.style.width = `${st.zoom * 100}%`;
      }),
    );

    // Printable "You are here" signs with a QR code to directions from that spot
    $('#weSigns').addEventListener('click', guard(async () => {
      if (st.dirty) return alert('Save the wayfinding first, then print the signs.');
      const starts = st.points.filter((p) => p.is_start && p.id);
      if (!starts.length) return alert('No starting points yet. Select a point and tick "Starting point".');
      await loadScript('/vendor/qr/qrcode.js', () => window.qrcode);
      const qr = (text) => {
        const q = window.qrcode(0, 'M');
        q.addData(text);
        q.make();
        return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      };
      const signs = starts
        .map((p) => {
          const url = `${location.origin}/directory?from=${p.id}`;
          return `<section class="sign"><div class="org">${esc(cat.hospitalName)}</div>
            <div class="here">YOU ARE HERE</div><div class="name">${esc(p.name)}${p.code ? ` <span>(Bldg. ${esc(p.code)})</span>` : ''}</div>
            <div class="qr">${qr(url)}</div>
            <div class="how">Scan with your phone camera for <b>directions</b> to any building, clinic or office.</div>
            <div class="url">${esc(url)}</div></section>`;
        })
        .join('');
      const w = window.open('', '_blank');
      if (!w) return alert('Allow pop-ups for this site to print the signs.');
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>You are here signs</title><style>
        body { font-family: Arial, sans-serif; margin: 0; color: #111; } .bar { padding: 10px; } .bar button { font-size: 14px; padding: 6px 14px; }
        .sign { width: 148mm; min-height: 200mm; margin: 0 auto 8mm; box-sizing: border-box; border: 3mm solid #1b7a3e; border-radius: 6mm; padding: 10mm; text-align: center; break-after: page; }
        .org { font-weight: bold; color: #0f4d26; text-transform: uppercase; font-size: 12pt; }
        .here { font-size: 34pt; font-weight: 900; color: #c62828; margin: 6mm 0 2mm; letter-spacing: .03em; }
        .name { font-size: 18pt; font-weight: bold; } .name span { font-weight: normal; font-size: 13pt; }
        .qr { width: 95mm; height: 95mm; margin: 8mm auto; } .qr svg { width: 100%; height: 100%; }
        .how { font-size: 14pt; } .url { font-size: 8pt; color: #666; margin-top: 4mm; word-break: break-all; }
        @media print { .bar { display: none; } @page { size: A5; margin: 6mm; } .sign { margin: 0 auto; } }
      </style></head><body><div class="bar"><b>${starts.length} sign${starts.length === 1 ? '' : 's'}</b> (A5) — print and post at each spot. <button onclick="print()">Print</button></div>${signs}</body></html>`);
      w.document.close();
    }));
    draw();
  }

  $('#addEntryBtn').addEventListener('click', () => entryDialog());
  $('#addGuideBtn').addEventListener('click', () => guideDialog());
  $('#addMapBtn').addEventListener('click', () => mapDialog());
  $('[data-view="directory"]').addEventListener('click', guard(async (ev) => {
    const b = ev.target.closest('[data-edit-entry],[data-del-entry],[data-edit-guide],[data-del-guide],[data-edit-map],[data-del-map],[data-way-map]');
    if (!b) return;
    const d = b.dataset;
    if (d.wayMap) return wayEditor(Number(d.wayMap));
    if (d.editEntry) return entryDialog(dir.entries.find((x) => x.id === Number(d.editEntry)));
    if (d.editGuide) return guideDialog(dir.guides.find((x) => x.id === Number(d.editGuide)));
    if (d.editMap) return mapDialog(dir.maps.find((x) => x.id === Number(d.editMap)));
    if (d.delEntry && confirm('Delete this place from the directory?')) await api(`/admin/directory/entries/${d.delEntry}`, { method: 'DELETE' });
    else if (d.delGuide && confirm('Delete this guide?')) await api(`/admin/directory/guides/${d.delGuide}`, { method: 'DELETE' });
    else if (d.delMap && confirm('Delete this map? Places on it will lose their pins.')) await api(`/admin/maps/${d.delMap}`, { method: 'DELETE' });
    else return;
    loaders.directory();
  }));

  // ---------- Flag Ceremony Attendance ----------
  let flagOpts = null;
  let flagSub = 'ceremonies';
  // Plantilla / Job Order tag
  const typeTag = (t) => (t === 'PLANTILLA' ? '<span class="emp-tag plantilla">Plantilla</span>' : t === 'JOB_ORDER' ? '<span class="emp-tag jo" title="Job Order">JO</span>' : '');
  const FLAG_LABEL = { ON_TIME: 'Present', EXCUSED: 'Excused', ABSENT: 'Absent', NOT_YET: 'Not yet', CANCELLED: 'Cancelled' };
  const flagPill = (s) => `<span class="flag-pill ${{ ON_TIME: 'ok', EXCUSED: 'info', ABSENT: 'bad' }[s] || ''}">${esc(FLAG_LABEL[s] || s)}</span>`;
  const flagTimes = (c) => `${fmtTime(c.opens)} – ${fmtTime(c.closes)}<div class="sub">starts ${fmtTime(c.starts)}</div>`;

  async function loadFlagOptions(force) {
    if (flagOpts && !force) return;
    flagOpts = await api('/admin/flag/options');
    $('#flagNotReady').classList.toggle('hidden', flagOpts.ready);
    if (!monthF.month.value) monthF.month.value = flagOpts.today.slice(0, 7);
    if (!sumF.from.value) sumF.from.value = `${flagOpts.today.slice(0, 7)}-01`;
    if (!sumF.to.value) sumF.to.value = flagOpts.today;
    $$('[data-flag-dept]').forEach((sel) => {
      const v = sel.value;
      sel.innerHTML = '<option value="">All divisions</option>' + flagOpts.divisions.map((d) => `<option${d === v ? ' selected' : ''}>${esc(d)}</option>`).join('');
    });
    $$('[data-flag-unit]').forEach((sel) => {
      const v = sel.value;
      sel.innerHTML = '<option value="">All units</option>' + flagOpts.units.map((d) => `<option${d === v ? ' selected' : ''}>${esc(d)}</option>`).join('');
    });
  }
  function showFlagSub(name) {
    if (name === 'scan' && !me?.access.flag_scan) name = 'ceremonies'; // Administrators and HR only
    flagSub = name;
    $$('#flagTabs button').forEach((b) => b.classList.toggle('on', b.dataset.flag === name));
    $$('[data-flagview]').forEach((v) => v.classList.toggle('hidden', v.dataset.flagview !== name));
    flagLoaders[name]();
  }
  $$('#flagTabs button').forEach((b) => b.addEventListener('click', () => showFlagSub(b.dataset.flag)));
  $$('[data-flag-goto]').forEach((a) => a.addEventListener('click', (e) => (e.preventDefault(), showFlagSub(a.dataset.flagGoto))));
  loaders.flag = guard(async () => {
    await loadFlagOptions(true);
    showFlagSub(flagSub);
  });
  const flagLoaders = {};

  // Ceremonies (month list)
  const monthF = $('#flagMonthForm');
  let flagRowsData = [];
  flagLoaders.ceremonies = guard(async () => {
    $('#flagList').classList.remove('hidden');
    $('#flagDetail').classList.add('hidden');
    const data = await api(`/admin/flag/ceremonies?month=${monthF.month.value}`);
    flagRowsData = data.rows;
    $('#flagExpected').textContent = `${data.expected} active employee${data.expected === 1 ? ' is' : 's are'} expected at each ceremony (manage under Employees).`;
    $('#flagRows').innerHTML =
      data.rows
        .map((c) => {
          const n = (v) => (v === null ? '' : v);
          return `<tr class="${c.cancelled ? 'voided' : ''}">
        <td class="nowrap"><b>${esc(fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</b>${c.phase === 'OPEN' ? '<div class="sub"><span class="flag-pill ok">Check-in open</span></div>' : ''}</td>
        <td>${esc(c.title)}${c.moved_from_date ? `<div class="sub">Moved from ${esc(fmtDate(c.moved_from_date, { weekday: 'short', month: 'short', day: 'numeric' }))}</div>` : c.source === 'MANUAL' ? '<div class="sub">special / edited</div>' : ''}
          ${c.moved_to_date ? `<div class="sub" style="color:var(--warn)">MOVED TO ${esc(fmtDate(c.moved_to_date, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase())}: ${esc(c.cancel_reason || '')}</div>` : c.cancelled ? `<div class="sub" style="color:var(--danger)">CANCELLED: ${esc(c.cancel_reason || '')}</div>` : ''}
          ${c.remarks ? `<div class="flag-remarks">📝 ${esc(c.remarks)}</div>` : ''}</td>
        <td class="small nowrap">${flagTimes(c)}</td>
        <td>${c.cancelled ? '' : c.on_time}</td><td>${c.cancelled ? '' : c.excused}</td>
        <td>${c.cancelled ? '' : c.absent !== null ? `<b style="color:${c.absent ? 'var(--danger)' : 'inherit'}">${c.absent}</b>` : `<span class="muted small">${n(c.not_yet)} not yet</span>`}</td>
        <td class="no-print nowrap">
          ${c.cancelled ? '' : `<button class="btn sm" data-flag-open="${c.id}">Attendance</button>`}
          ${c.moved_to_date ? '' : c.cancelled ? (c.phase === 'CLOSED' ? '' : `<button class="btn sm secondary" data-flag-restore="${c.id}">Restore</button>`) : ''}
          ${!c.cancelled && c.phase !== 'CLOSED' ? `<button class="btn sm secondary" data-flag-edit="${c.id}">Edit</button>` : ''}
          ${!c.cancelled && c.phase === 'UPCOMING' ? `<button class="btn sm secondary" data-flag-move="${c.id}">Move date</button>` : ''}
          ${!c.cancelled ? `<button class="btn sm secondary" data-flag-remarks="${c.id}">Remarks</button>` : ''}
          ${!c.cancelled && c.phase !== 'CLOSED' ? `<button class="btn sm danger" data-flag-cancel="${c.id}">Cancel</button>` : ''}
        </td>
      </tr>`;
        })
        .join('') ||
      `<tr><td colspan="8" class="empty">${data.ready ? 'No ceremonies this month.' : 'No ceremonies yet — set the venue under Venue & schedule first.'}</td></tr>`;
  });
  monthF.month.addEventListener('change', flagLoaders.ceremonies);

  function ceremonyDialog(c) {
    const isNew = !c;
    c = c || { title: 'FLAG LOWERING CEREMONY', opens: '16:30', starts: '17:00', closes: '17:30', date: flagOpts.today };
    openDialog(
      `<h2>${isNew ? 'Special ceremony' : 'Edit ceremony'}</h2>
       ${isNew ? '<p class="muted small">For a one-time ceremony, e.g. flag lowering, a holiday program or a rescheduled flag raising.</p>' : `<p class="muted small">${esc(fmtDate(c.date))}..</p>`}
       <div class="grid grid-2">
         ${isNew ? `<label class="field"><span class="req">Date</span><input type="date" name="date" min="${flagOpts.today}" value="${esc(c.date)}" required></label><span></span>` : ''}
         <label class="field span-2"><span class="req">Ceremony</span><input name="title" value="${esc(c.title)}" required></label>
         <label class="field"><span class="req">Check-in opens</span><input type="time" name="opens" value="${esc(c.opens)}" required></label>
         <label class="field"><span class="req">Starts</span><input type="time" name="starts" value="${esc(c.starts)}" required></label>
         <label class="field"><span class="req">Check-in closes</span><input type="time" name="closes" value="${esc(c.closes)}" required></label>
         <label class="field span-2">Remarks <span class="hint">Shown to employees, e.g. HELD AT THE MAIN LOBBY DUE TO RAIN</span><input name="remarks" maxlength="300" value="${esc(c.remarks || '')}"></label>
       </div>`,
      async (d) => {
        await api(isNew ? '/admin/flag/ceremonies' : `/admin/flag/ceremonies/${c.id}`, { method: isNew ? 'POST' : 'PATCH', body: d });
        if (isNew) monthF.month.value = d.date.slice(0, 7);
        flagLoaders.ceremonies();
      },
    );
  }
  $('#flagAddBtn').addEventListener('click', guard(async () => (await loadFlagOptions(), ceremonyDialog(null))));
  $('#flagRows').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.flagOpen) return openCeremony(Number(d.flagOpen));
    if (d.flagEdit) return ceremonyDialog(flagRowsData.find((c) => c.id === Number(d.flagEdit)));
    if (d.flagCancel) {
      const c = flagRowsData.find((x) => x.id === Number(d.flagCancel));
      return openDialog(
        `<h2>Cancel ceremony?</h2><p>${esc(c.title)} · ${esc(fmtDate(c.date))}</p>
         <p class="muted small">Nobody can check in and it is not counted in the summary. You can restore it later.</p>
         <label class="field"><span class="req">Reason</span><input name="cancel_reason" required placeholder="E.G. HOLIDAY, BAD WEATHER"></label>`,
        async (f) => {
          await api(`/admin/flag/ceremonies/${c.id}`, { method: 'PATCH', body: { cancelled: true, cancel_reason: f.cancel_reason } });
          flagLoaders.ceremonies();
        },
        { saveLabel: 'Cancel ceremony' },
      );
    }
    if (d.flagMove) {
      const c = flagRowsData.find((x) => x.id === Number(d.flagMove));
      return openDialog(
        `<h2>Move ceremony to another date</h2>
         <p>${esc(c.title)} · <b>${esc(fmtDate(c.date))}</b></p>
         <p class="muted small">For a holiday or another event on that day. ${esc(fmtDate(c.date, { weekday: 'short', month: 'short', day: 'numeric' }))} is kept in the list as "moved" (not counted), and excuses already recorded go with the ceremony.</p>
         <div class="grid grid-2">
           <label class="field"><span class="req">New date</span><input type="date" name="date" min="${flagOpts.today}" required></label>
           <span></span>
           <label class="field span-2"><span class="req">Reason</span><input name="reason" required placeholder="E.G. HOLIDAY: BONIFACIO DAY"></label>
           <label class="field"><span class="req">Check-in opens</span><input type="time" name="opens" value="${esc(c.opens)}" required></label>
           <label class="field"><span class="req">Starts</span><input type="time" name="starts" value="${esc(c.starts)}" required></label>
           <label class="field"><span class="req">Check-in closes</span><input type="time" name="closes" value="${esc(c.closes)}" required></label>
         </div>`,
        async (f) => {
          await api(`/admin/flag/ceremonies/${c.id}/move`, { method: 'POST', body: f });
          monthF.month.value = f.date.slice(0, 7);
          flagLoaders.ceremonies();
        },
        { saveLabel: 'Move ceremony' },
      );
    }
    if (d.flagRemarks) {
      const c = flagRowsData.find((x) => x.id === Number(d.flagRemarks));
      return openDialog(
        `<h2>Remarks</h2><p>${esc(c.title)} · ${esc(fmtDate(c.date))}</p>
         <label class="field">Remarks <span class="hint">e.g. bad weather. Shown to employees on the check-in page and on this list. Leave blank to remove.</span>
           <textarea name="remarks" maxlength="300" rows="3" placeholder="E.G. HELD AT THE MAIN LOBBY DUE TO RAIN; SHORTENED DUE TO BAD WEATHER">${esc(c.remarks || '')}</textarea></label>
         ${c.phase === 'UPCOMING' || c.phase === 'OPEN' ? '<p class="muted small">If the ceremony will not push through at all, use <b>Cancel</b> instead so nobody is marked absent.</p>' : ''}`,
        async (f) => {
          await api(`/admin/flag/ceremonies/${c.id}`, { method: 'PATCH', body: { remarks: f.remarks } });
          flagLoaders.ceremonies();
        },
      );
    }
    if (d.flagRestore) {
      await api(`/admin/flag/ceremonies/${d.flagRestore}`, { method: 'PATCH', body: { cancelled: false } });
      flagLoaders.ceremonies();
    }
  }));

  // One ceremony's attendance
  const detF = $('#flagDetailFilters');
  let detail = null;
  async function openCeremony(id) {
    detail = await api(`/admin/flag/ceremonies/${id}`);
    const c = detail.ceremony;
    $('#flagList').classList.add('hidden');
    $('#flagDetail').classList.remove('hidden');
    $('#flagCsv').href = `/api/admin/flag/ceremonies/${c.id}/export.csv`;
    $('#flagDetailHead').innerHTML = `<h2 style="margin:0">${esc(c.title)}</h2>
      <p class="muted" style="margin:2px 0 12px">${esc(fmtDate(c.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))} · ${esc(detail.venue)} ·
      Check-in ${fmtTime(c.opens)} – ${fmtTime(c.closes)}, starts ${fmtTime(c.starts)}${c.phase === 'OPEN' ? ' · <b>check-in open now</b>' : ''}
      ${c.moved_from_date ? `<br>Moved from ${esc(fmtDate(c.moved_from_date))}` : ''}</p>
      ${c.remarks ? `<p class="flag-remarks" style="margin:-6px 0 12px">📝 Remarks: ${esc(c.remarks)}</p>` : ''}`;
    const count = (s) => detail.rows.filter((r) => r.status === s).length;
    const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    $('#flagStats').innerHTML = [
      stat(count('ON_TIME'), 'Present'),
      stat(count('EXCUSED'), 'Excused'),
      stat(count('ABSENT') + count('NOT_YET'), c.phase === 'CLOSED' ? 'Absent' : 'Not yet checked in'),
    ].join('');
    renderDetail();
  }
  function renderDetail() {
    const f = formData(detF);
    const q = (f.q || '').toUpperCase();
    const closed = detail.ceremony.phase === 'CLOSED';
    const rows = detail.rows.filter(
      (r) =>
        (!q || r.name.includes(q) || r.employee_no.includes(q)) &&
        (!f.division || r.division === f.division) &&
        (!f.unit || r.unit === f.unit) &&
        (!f.employment_type || (f.employment_type === 'NONE' ? !r.employment_type : r.employment_type === f.employment_type)) &&
        (!f.status || (f.status === 'MISSING' ? ['ABSENT', 'NOT_YET'].includes(r.status) : r.status === f.status)),
    );
    $('#flagDetailRows').innerHTML =
      rows
        .map(
          (r) => `<tr>
        <td>${esc(r.name)} ${typeTag(r.employment_type)}<div class="sub mono">${esc(r.employee_no)}${r.position ? ` · ${esc(r.position)}` : ''}</div></td>
        <td class="small">${esc(r.division || '')}</td>
        <td class="small">${esc(r.unit || '')}</td>
        <td>${flagPill(r.status)}</td>
        <td class="nowrap">${r.time && r.status !== 'EXCUSED' ? fmtTime(r.time) : ''}</td>
        <td class="small">${r.source === 'GPS' ? `Phone GPS<div class="sub">${r.distance_m} m from venue (±${r.accuracy_m} m)</div>` : r.source === 'MANUAL' ? `By ${esc(r.marked_by)}` : r.source === 'QR' ? `QR scan<div class="sub">by ${esc(r.marked_by)}</div>` : ''}${r.source === 'GPS' && r.marked_by ? `<div class="sub">changed by ${esc(r.marked_by)}</div>` : ''}</td>
        <td class="no-print">${r.has_photo ? `<img class="att-thumb" loading="lazy" src="/api/admin/flag/checkins/${r.checkin_id}/photo" alt="Selfie" data-flag-photo>` : ''}</td>
        <td class="small">${esc(r.remarks || '')}</td>
        <td class="no-print">${detail.ceremony.phase === 'CANCELLED' ? '' : `<button class="btn sm secondary" data-flag-mark="${r.id}">${r.checkin_id ? 'Change' : closed || detail.ceremony.phase === 'OPEN' ? 'Mark' : 'Excuse'}</button>`}</td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="9" class="empty">No employees match.</td></tr>';
  }
  detF.addEventListener('input', renderDetail);
  $('#flagBack').addEventListener('click', () => flagLoaders.ceremonies());
  $('#flagDetailRows').addEventListener('click', (e) => {
    const img = e.target.closest('[data-flag-photo]');
    if (img) return openDialog(`<h2>Check-in selfie</h2><img src="${img.src}" alt="" style="width:100%;max-width:480px;border-radius:8px">`, async () => {}, { saveLabel: 'OK' });
    const b = e.target.closest('[data-flag-mark]');
    if (!b) return;
    const r = detail.rows.find((x) => x.id === Number(b.dataset.flagMark));
    const c = detail.ceremony;
    const choices = (c.phase === 'UPCOMING' ? ['EXCUSED'] : ['ON_TIME', 'EXCUSED']).concat(r.checkin_id && ['MANUAL', 'QR'].includes(r.source) ? ['CLEAR'] : []);
    const label = { ...FLAG_LABEL, ON_TIME: 'Present', CLEAR: r.status === 'EXCUSED' ? 'Remove excuse' : 'Remove (back to absent)' };
    openDialog(
      `<h2>${esc(r.name)}</h2>
       <p class="muted small">${esc(c.title)} · ${esc(fmtDate(c.date))}. Now: ${flagPill(r.status)}${r.source === 'GPS' ? ' (checked in by phone)' : ''}</p>
       <div class="grid">
         <label class="field"><span class="req">Set to</span><select name="status">${choices.map((s) => `<option value="${s}"${s === r.status ? ' selected' : ''}>${esc(label[s])}</option>`).join('')}</select></label>
         <label class="field"><span class="req">Reason</span><input name="remarks" value="${esc(r.remarks || '')}" placeholder="E.G. ON APPROVED LEAVE, ON DUTY AT ER, GPS NOT WORKING (SEEN BY HR)"></label>
       </div>
       <p class="muted small">Your username and the reason are recorded.</p>`,
      async (d) => {
        await api(`/admin/flag/ceremonies/${c.id}/mark`, { method: 'POST', body: { employee_id: r.id, ...d } });
        await openCeremony(c.id);
      },
    );
  });

  // Summary
  const sumF = $('#flagSumForm');
  const sumQuery = () => new URLSearchParams(Object.entries(formData(sumF)).filter(([, v]) => v));
  flagLoaders.summary = guard(async () => {
    const data = await api(`/admin/flag/summary?${sumQuery()}`);
    $('#flagSumNote').textContent =
      `${data.ceremonies} ceremon${data.ceremonies === 1 ? 'y' : 'ies'} held from ${fmtDate(data.from)} to ${fmtDate(data.to)} (cancelled ones and ceremonies still open are not counted). ` +
      'Attendance % = present ÷ ceremonies not excused. Ceremonies before an employee was added are not counted for them.';
    $('#flagSumRows').innerHTML =
      data.rows
        .map(
          (r) => `<tr>
        <td>${esc(r.employee.name)} ${typeTag(r.employee.employment_type)}<div class="sub mono">${esc(r.employee.employee_no)}</div></td>
        <td class="small">${esc(r.employee.division || '')}</td>
        <td class="small">${esc(r.employee.unit || '')}</td>
        <td>${r.held}</td><td>${r.on_time}</td><td>${r.excused || '—'}</td>
        <td>${r.absent ? `<b style="color:var(--danger)">${r.absent}</b>` : '—'}</td>
        <td>${r.rate === null ? '—' : `${r.rate}%`}</td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="9" class="empty">No employees.</td></tr>';
  });
  sumF.addEventListener('submit', (e) => (e.preventDefault(), flagLoaders.summary()));
  $('#flagSumCsv').addEventListener('click', () => (window.location.href = `/api/admin/flag/summary.csv?${sumQuery()}`));

  // Employees
  const empF = $('#flagEmpFilters');
  flagLoaders.employees = guard(async () => {
    const q = new URLSearchParams(Object.entries(formData(empF)).filter(([, v]) => v));
    const { rows } = await api(`/admin/flag/employees?${q}`);
    empF._rows = rows;
    $('#flagEmpRows').innerHTML =
      rows
        .map(
          (e) => `<tr>
        <td class="mono">${esc(e.employee_no)}</td>
        <td>${esc(e.name)}</td>
        <td class="small">${esc(e.position || '')}</td>
        <td class="small">${esc(e.division || '')}</td>
        <td class="small">${esc(e.unit || '')}</td>
        <td>${typeTag(e.employment_type) || '<span class="muted small">—</span>'}</td>
        <td class="small">${e.flag_required ? 'Required' : '<span class="muted">Not required</span>'}</td>
        <td>${e.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}${e.locked ? '<div class="sub" style="color:var(--danger)">PIN locked</div>' : ''}</td>
        <td class="no-print nowrap"><button class="btn sm" data-emp-edit="${e.id}">Edit</button> <button class="btn sm secondary" data-emp-pin="${e.id}">Reset PIN</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="9" class="empty">No employees yet. Add them one by one or import a list.</td></tr>';
  });
  empF.addEventListener('input', debounce(flagLoaders.employees));

  const suggest = (id, list) => `<datalist id="${id}">${(list || []).map((d) => `<option value="${esc(d)}">`).join('')}</datalist>`;
  const pinShown = (e) =>
    openDialog(
      `<h2>PIN for ${esc(e.name)}</h2>
       <p>Employee no. <b class="mono">${esc(e.employee_no)}</b></p>
       <p class="pin-slip">${esc(e.pin)}</p>
       <p class="muted small">Give this PIN to the employee privately. It is shown only now. They sign in at <b>${esc(location.host)}/flag-ceremony</b> and can change it there (Change PIN).</p>`,
      async () => {},
      { saveLabel: 'Done' },
    );

  function employeeDialog(e) {
    const isNew = !e;
    e = e || { flag_required: true };
    openDialog(
      `<h2>${isNew ? 'Add employee' : 'Edit employee'}</h2>
       <div class="grid grid-2">
         <label class="field"><span class="req">Employee no.</span><input name="employee_no" value="${esc(e.employee_no || '')}" required></label>
         <span></span>
         <label class="field"><span class="req">Last name</span><input name="last_name" value="${esc(e.last_name || '')}" required></label>
         <label class="field"><span class="req">First name</span><input name="first_name" value="${esc(e.first_name || '')}" required></label>
         <label class="field">Middle name<input name="middle_name" value="${esc(e.middle_name || '')}"></label>
         <label class="field">Position<input name="position" value="${esc(e.position || '')}"></label>
         <label class="field">Division<select name="division"><option value="">— Select division —</option>${[...new Set([...(flagOpts?.division_choices || []), ...(e.division ? [e.division] : [])])]
           .map((d) => `<option${d === e.division ? ' selected' : ''}>${esc(d)}</option>`)
           .join('')}</select></label>
         <label class="field">Unit<input name="unit" list="flagUnitList" value="${esc(e.unit || '')}" placeholder="E.G. EMERGENCY ROOM">${suggest('flagUnitList', flagOpts?.units)}</label>
         <label class="field">Employment type<select name="employment_type"><option value="">— Select —</option>${Object.entries(flagOpts?.employment_types || { PLANTILLA: 'Plantilla', JOB_ORDER: 'Job Order' })
           .map(([k, l]) => `<option value="${k}"${k === e.employment_type ? ' selected' : ''}>${esc(l)}</option>`)
           .join('')}</select></label>
         <span></span>
         <label class="check span-2"><input type="checkbox" name="flag_required" ${e.flag_required ? 'checked' : ''}> Required to attend flag ceremonies (untick e.g. for fixed night duty; they are then not counted absent)</label>
         ${isNew ? '<label class="field span-2">PIN (6 digits)<input name="pin" inputmode="numeric" maxlength="6" placeholder="Leave blank for a random PIN"></label>' : `<label class="check span-2"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> Active (can sign in and check in)</label>`}
       </div>`,
      async (d) => {
        const body = { ...d, flag_required: $('#dlgForm [name=flag_required]').checked };
        if (!isNew) body.active = $('#dlgForm [name=active]').checked;
        const saved = await api(isNew ? '/admin/flag/employees' : `/admin/flag/employees/${e.id}`, { method: isNew ? 'POST' : 'PATCH', body });
        await loadFlagOptions(true);
        flagLoaders.employees();
        if (isNew) setTimeout(() => pinShown(saved), 0);
      },
    );
  }
  $('#flagAddEmpBtn').addEventListener('click', guard(async () => (await loadFlagOptions(), employeeDialog(null))));
  $('#flagEmpRows').addEventListener('click', (ev) => {
    const ed = ev.target.closest('[data-emp-edit]');
    if (ed) return employeeDialog(empF._rows.find((r) => r.id === Number(ed.dataset.empEdit)));
    const pb = ev.target.closest('[data-emp-pin]');
    if (!pb) return;
    const e = empF._rows.find((r) => r.id === Number(pb.dataset.empPin));
    openDialog(
      `<h2>Reset PIN</h2><p>${esc(e.name)} · <span class="mono">${esc(e.employee_no)}</span></p>
       <label class="field">New PIN (6 digits)<input name="pin" inputmode="numeric" maxlength="6" placeholder="Leave blank for a random PIN"></label>
       <p class="muted small">This also unlocks the employee no. after too many wrong PINs and signs the employee out of their phone.</p>`,
      async (d) => {
        const r = await api(`/admin/flag/employees/${e.id}/pin`, { method: 'POST', body: d });
        flagLoaders.employees();
        setTimeout(() => pinShown(r), 0);
      },
      { saveLabel: 'Reset PIN' },
    );
  });
  $('#flagImportBtn').addEventListener('click', () =>
    openDialog(
      `<h2>Import employees</h2>
       <p class="muted small">Paste from Excel or a CSV file, one employee per line, in this column order:<br>
       <b>Employee no., Last name, First name, Middle name, Position, Division, Unit, Employment type</b> (Plantilla or Job Order / JO; optional). Division must be ${esc((flagOpts?.division_choices || []).join(', '))} (short forms work too, e.g. "Nursing" is read as NURSING SERVICE DIVISION). A header row is skipped. Each employee gets a random 6-digit PIN, listed after the import for printing.</p>
       <textarea name="csv" rows="10" data-nocaps placeholder="2023-0001, DELA CRUZ, JUAN, SANTOS, NURSE II, NURSING, EMERGENCY ROOM, PLANTILLA" required></textarea>`,
      async (d) => {
        const { rows } = await api('/admin/flag/employees/import', { method: 'POST', body: { csv: d.csv } });
        await loadFlagOptions(true);
        flagLoaders.employees();
        setTimeout(
          () =>
            openDialog(
              `<h2>${rows.length} employee${rows.length === 1 ? '' : 's'} imported</h2>
               <p class="muted small">Print this list and give each employee their PIN privately. The PINs are not shown again. Employees sign in at <b>${esc(location.host)}/flag-ceremony</b>.</p>
               <div class="table-wrap"><table><thead><tr><th>Employee no.</th><th>Name</th><th>Division / unit</th><th>PIN</th></tr></thead><tbody>
               ${rows.map((r) => `<tr><td class="mono">${esc(r.employee_no)}</td><td>${esc(r.name)}</td><td class="small">${esc([r.division, r.unit].filter(Boolean).join(' / '))}</td><td class="mono"><b>${esc(r.pin)}</b></td></tr>`).join('')}
               </tbody></table></div>`,
              async () => window.print(),
              { wide: true, saveLabel: 'Print' },
            ),
          0,
        );
      },
      { wide: true, saveLabel: 'Import' },
    ),
  );



  // ---------- Division and unit names ----------
  async function namesDialog() {
    const data = await api('/admin/flag/divisions');
    const row = (kind, n, extra = '') => `<tr>
      <td><input data-${kind}-name value="${esc(n.name)}" data-was="${esc(n.name)}" aria-label="Name" maxlength="120"></td>
      <td class="small nowrap">${n.employees} employee${n.employees === 1 ? '' : 's'}${extra}</td>
      <td class="nowrap"><button type="button" class="btn sm secondary" data-${kind}-save="${esc(kind === 'div' ? n.id : n.name)}">Rename</button>
        ${kind === 'div' && !n.employees ? `<button type="button" class="btn sm danger" data-div-del="${n.id}">Remove</button>` : ''}</td>
    </tr>`;
    openDialog(
      `<h2>Divisions &amp; units</h2>
       <p class="muted small">Renaming changes it for every employee in that division or unit. Renaming to a name that already exists merges the two.</p>
       <h3 class="small" style="margin:12px 0 6px">Divisions (the Division dropdown)</h3>
       <div class="table-wrap"><table class="names-table"><tbody>
         ${data.divisions.map((d) => row('div', d)).join('')}
         <tr><td><input id="newDivName" placeholder="New division name" maxlength="120"></td><td></td><td><button type="button" class="btn sm" id="newDivBtn">+ Add division</button></td></tr>
       </tbody></table></div>
       ${data.other_divisions.length ? `<p class="muted small">Not in the list (older values still on employees): ${data.other_divisions.map((d) => `<b>${esc(d.name)}</b> (${d.employees})`).join(', ')}. Edit those employees to choose a division.</p>` : ''}
       <h3 class="small" style="margin:16px 0 6px">Units</h3>
       ${data.units.length
         ? `<div class="table-wrap"><table class="names-table"><tbody>${data.units.map((n) => row('unit', n, n.divisions ? `<div class="sub">${esc(n.divisions)}</div>` : '')).join('')}</tbody></table></div>`
         : '<p class="muted small">No units yet. Units are typed when adding or editing an employee.</p>'}
       <div class="alert error hidden" id="namesError"></div>`,
      async () => {},
      { wide: true, saveLabel: 'Done' },
    );
    const form = $('#dlgForm');
    const fail = (err) => showError($('#namesError'), err.message);
    const changed = async () => {
      await loadFlagOptions(true);
      flagLoaders.employees();
      await namesDialog();
    };
    form.onclick = async (e) => {
      const b = e.target.closest('button[type=button]');
      if (!b) return;
      try {
        if (b.id === 'newDivBtn') {
          await api('/admin/flag/divisions', { method: 'POST', body: { name: $('#newDivName').value } });
          return changed();
        }
        if (b.dataset.divDel) {
          if (!confirm('Remove this division from the list?')) return;
          await api(`/admin/flag/divisions/${b.dataset.divDel}`, { method: 'DELETE' });
          return changed();
        }
        const input = b.closest('tr').querySelector('input');
        if (input.value.trim().toUpperCase() === input.dataset.was) return;
        if (b.dataset.divSave) {
          const body = { name: input.value };
          try {
            await api(`/admin/flag/divisions/${b.dataset.divSave}`, { method: 'PATCH', body });
          } catch (err) {
            if (err.status !== 409 || !confirm(err.message)) throw err;
            await api(`/admin/flag/divisions/${b.dataset.divSave}`, { method: 'PATCH', body: { ...body, merge: true } });
          }
          return changed();
        }
        if (b.dataset.unitSave) {
          const to = input.value.trim().toUpperCase();
          const exists = data.units.some((u) => u.name === to);
          if (exists && !confirm(`${to} already exists. Merge ${b.dataset.unitSave} into it?`)) return;
          await api('/admin/flag/units/rename', { method: 'POST', body: { from: b.dataset.unitSave, to } });
          return changed();
        }
      } catch (err) {
        if (err.status === 401) return start();
        fail(err);
      }
    };
  }
  $('#flagNamesBtn').addEventListener('click', guard(namesDialog));

  // ---------- QR scan at the venue (employees without a phone) ----------
  const loadScript = (src, test) =>
    new Promise((resolve, reject) => {
      if (test()) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('A part of the page could not be loaded. Check the connection and try again.'));
      document.head.appendChild(el);
    });
  const scan = { stream: null, timer: null, detector: null, canvas: null, last: { code: '', at: 0 }, busy: false, count: 0 };

  flagLoaders.scan = guard(async () => {
    await loadFlagOptions();
    const { rows } = await api(`/admin/flag/ceremonies?month=${flagOpts.today.slice(0, 7)}`);
    const todays = rows.filter((c) => c.date === flagOpts.today && !c.cancelled);
    const open = todays.filter((c) => c.phase === 'OPEN');
    const sel = $('#scanCeremony');
    const keep = sel.value;
    sel.innerHTML = open.map((c) => `<option value="${c.id}"${String(c.id) === keep ? ' selected' : ''}>${esc(c.title)} · check-in until ${fmtTime(c.closes)}</option>`).join('');
    sel.disabled = !open.length;
    const next = todays.find((c) => c.phase === 'UPCOMING');
    const none = $('#scanNone');
    none.classList.toggle('hidden', !!open.length);
    none.innerHTML = open.length
      ? ''
      : next
        ? `Check-in for <b>${esc(next.title)}</b> opens at <b>${fmtTime(next.opens)}</b>. Come back to this tab then.`
        : 'No ceremony is open for check-in right now.';
    $('#scanStart').disabled = !open.length;
    $('#scanManual button').disabled = !open.length;
    if (!open.length) stopScanner();
  });

  function stopScanner() {
    clearTimeout(scan.timer);
    scan.timer = null;
    scan.stream?.getTracks().forEach((t) => t.stop());
    scan.stream = null;
    $('#scanVideo').srcObject = null;
    $('#scanCam').classList.remove('on');
    $('#scanCamNote').textContent = 'Camera is off';
    $('#scanStart').classList.remove('hidden');
    $('#scanStop').classList.add('hidden');
  }

  async function startScanner() {
    const note = $('#scanCamNote');
    if (!navigator.mediaDevices?.getUserMedia) {
      note.textContent = 'This browser cannot use the camera. Type the employee no. below instead.';
      return;
    }
    note.textContent = 'Starting the camera…';
    try {
      scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (err) {
      note.textContent = err.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow the camera for this site, or type the employee no. below.' : 'The camera could not be started. Type the employee no. below instead.';
      return;
    }
    const video = $('#scanVideo');
    video.srcObject = scan.stream;
    await video.play().catch(() => {});
    // The browser's own QR reader where available (Android Chrome), else jsQR (works everywhere)
    scan.detector = null;
    if ('BarcodeDetector' in window) {
      try {
        if ((await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) scan.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        scan.detector = null;
      }
    }
    if (!scan.detector) await loadScript('/vendor/qr/jsQR.js', () => window.jsQR);
    $('#scanCam').classList.add('on');
    note.textContent = 'Point the camera at the QR code on the ID';
    $('#scanStart').classList.add('hidden');
    $('#scanStop').classList.remove('hidden');
    scanFrame();
  }

  async function readFrame() {
    const video = $('#scanVideo');
    if (!video.videoWidth) return null;
    if (scan.detector) {
      const codes = await scan.detector.detect(video);
      return codes[0]?.rawValue || null;
    }
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    scan.canvas = scan.canvas || document.createElement('canvas');
    scan.canvas.width = w;
    scan.canvas.height = h;
    const ctx = scan.canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    return code?.data || null;
  }

  async function scanFrame() {
    if (!scan.stream) return;
    try {
      const code = await readFrame();
      // The same QR held in front of the camera is read once (until 4 s after it was last seen)
      const now = Date.now();
      if (code && !(code === scan.last.code && now - scan.last.at < 4000)) {
        scan.last = { code, at: now };
        await recordScan(code);
      } else if (code) scan.last.at = now;
    } catch {
      // a frame that could not be read; try the next one
    }
    if (scan.stream) scan.timer = setTimeout(scanFrame, 180);
  }

  // Short sound and vibration so the marshal knows without looking
  function feedback(ok) {
    try {
      navigator.vibrate?.(ok ? 80 : [60, 60, 60]);
      const ac = (feedback.ac = feedback.ac || new (window.AudioContext || window.webkitAudioContext)());
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = ok ? 880 : 220;
      g.gain.value = 0.08;
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + (ok ? 0.12 : 0.35));
    } catch {
      // sound is optional
    }
  }

  const SOURCE_LABEL = { GPS: 'phone GPS', QR: 'QR scan', MANUAL: 'HR' };
  async function recordScan(code) {
    if (scan.busy) return;
    const id = $('#scanCeremony').value;
    if (!id) return;
    scan.busy = true;
    const box = $('#scanResult');
    try {
      const r = await api(`/admin/flag/ceremonies/${id}/scan`, { method: 'POST', body: { code } });
      const e = r.employee;
      const who = `<div class="scan-name">${esc(e.name)}</div><div class="small">${esc(e.employee_no)}${e.position ? ` · ${esc(e.position)}` : ''}${e.division ? ` · ${esc(e.division)}` : ''}${e.unit ? ` / ${esc(e.unit)}` : ''}</div>`;
      if (r.result === 'RECORDED') {
        box.innerHTML = `<div class="scan-result ok"><div class="scan-big">✓ PRESENT · ${fmtTime(r.time)}</div>${who}</div>`;
        scan.count += 1;
        $('#scanCount').textContent = scan.count;
        $('#scanLog').insertAdjacentHTML('afterbegin', `<li><b>${fmtTime(r.time)}</b> ${esc(e.name)} <span class="muted">${esc(e.employee_no)}</span></li>`);
        feedback(true);
      } else {
        const what = r.status === 'EXCUSED' ? 'is excused for this ceremony' : `was already recorded present${r.time ? ` at ${fmtTime(r.time)}` : ''}${r.source ? ` (${SOURCE_LABEL[r.source] || r.source})` : ''}`;
        box.innerHTML = `<div class="scan-result info"><div class="scan-big">Already recorded</div>${who}<div class="small">${esc(what)}.</div></div>`;
        feedback(true);
      }
    } catch (err) {
      if (err.status === 401) return start();
      box.innerHTML = `<div class="scan-result bad"><div class="scan-big">✗ Not recorded</div><div>${esc(err.message)}</div></div>`;
      feedback(false);
      if (err.status === 409) flagLoaders.scan(); // check-in closed: refresh the ceremony list
    } finally {
      scan.busy = false;
    }
  }

  $('#scanStart').addEventListener('click', startScanner);
  $('#scanStop').addEventListener('click', stopScanner);
  $('#scanManual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.code;
    if (!input.value.trim()) return input.focus();
    await recordScan(input.value.trim());
    input.value = '';
    input.focus();
  });
  // The camera is switched off whenever the scan screen is left or hidden
  $$('#flagTabs button, #tabs button').forEach((b) => b.addEventListener('click', () => b.dataset.flag !== 'scan' && stopScanner()));
  document.addEventListener('visibilitychange', () => document.hidden && stopScanner());

  // ---------- Printable QR cards for employee IDs ----------
  $('#flagQrCardsBtn').addEventListener('click', guard(async () => {
    const rows = (empF._rows || []).filter((e) => e.active);
    if (!rows.length) return alert('No active employees in the list. Change the filters first.');
    if (rows.length > 500 && !confirm(`Print QR cards for ${rows.length} employees?`)) return;
    await loadScript('/vendor/qr/qrcode.js', () => window.qrcode);
    const svg = (text) => {
      const q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    };
    const cards = rows
      .map(
        (e) => `<div class="card">
          <div class="qr">${svg(`ZRMC-EMP:${e.employee_no}`)}</div>
          <div class="info"><div class="org">${esc(cat.hospitalName)}</div><div class="what">FLAG CEREMONY ATTENDANCE</div>
            <div class="name">${esc(e.name)}</div><div class="no">${esc(e.employee_no)}</div>
            <div class="div">${esc([e.division, e.unit].filter(Boolean).join(' / '))}</div></div>
        </div>`,
      )
      .join('');
    const w = window.open('', '_blank');
    if (!w) return alert('Allow pop-ups for this site to print the QR cards.');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Employee QR cards</title><style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 12px; color: #111; }
      .bar { margin-bottom: 12px; font-size: 14px; } .bar button { font-size: 14px; padding: 6px 14px; }
      .grid { display: flex; flex-wrap: wrap; gap: 6mm; }
      .card { width: 85.6mm; height: 54mm; box-sizing: border-box; border: 1px dashed #999; border-radius: 3mm; padding: 3mm; display: flex; gap: 3mm; align-items: center; break-inside: avoid; }
      .qr { width: 40mm; height: 40mm; flex: none; } .qr svg { width: 100%; height: 100%; }
      .info { min-width: 0; } .org { font-size: 7pt; color: #0f4d26; font-weight: bold; text-transform: uppercase; }
      .what { font-size: 6.5pt; color: #666; margin-bottom: 2mm; letter-spacing: .03em; }
      .name { font-size: 10pt; font-weight: bold; line-height: 1.15; } .no { font-family: monospace; font-size: 11pt; margin-top: 1mm; }
      .div { font-size: 7pt; color: #444; margin-top: 1mm; }
      @media print { .bar { display: none; } body { padding: 0; } @page { margin: 10mm; } }
    </style></head><body><div class="bar"><b>${rows.length} QR card${rows.length === 1 ? '' : 's'}</b> — cut along the dashed lines and attach to the back of each employee's ID. <button onclick="print()">Print</button></div>
    <div class="grid">${cards}</div></body></html>`);
    w.document.close();
    w.focus();
  }));

  // Venue, geofence and weekly schedule
  const setF = $('#flagSettingsForm');
  const dayOpts = (sel) => flagOpts.weekdays.map((d, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${d}</option>`).join('');
  // Ceremony types for the weekly schedule, with their usual check-in times
  const CEREMONY_TYPES = {
    'FLAG RAISING CEREMONY': { opens: '07:00', starts: '08:00', closes: '09:00' },
    'FLAG LOWERING CEREMONY': { opens: '16:30', starts: '17:00', closes: '17:30' },
  };
  // A title saved before the dropdown existed stays selectable
  const ceremonyOpts = (sel) =>
    [...new Set([...Object.keys(CEREMONY_TYPES), ...(sel ? [sel] : [])])]
      .map((t) => `<option value="${esc(t)}"${t === sel ? ' selected' : ''}>${esc(t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))}</option>`)
      .join('');
  const schedRow = (x) => `<tr>
    <td><select data-k="weekday">${dayOpts(x.weekday)}</select></td>
    <td><select data-k="title" aria-label="Ceremony">${ceremonyOpts(x.title)}</select></td>
    <td><input type="time" data-k="opens" value="${esc(x.opens)}"></td>
    <td><input type="time" data-k="starts" value="${esc(x.starts)}"></td>
    <td><input type="time" data-k="closes" value="${esc(x.closes)}"></td>
    <td><button class="btn sm danger" type="button" data-sched-del>Remove</button></td>
  </tr>`;
  // Venue map: staff pin the venue by clicking the map or dragging the pin; the circle is the geofence
  const DEFAULT_CENTER = [6.9214, 122.079]; // Zamboanga City, until a venue is pinned
  let venueMap = null;
  let venuePin = null;
  let venueCircle = null;
  const pinIcon = () =>
    window.L &&
    L.icon({ iconUrl: '/vendor/leaflet/images/marker-icon.png', iconRetinaUrl: '/vendor/leaflet/images/marker-icon-2x.png', shadowUrl: '/vendor/leaflet/images/marker-shadow.png', iconSize: [25, 41], iconAnchor: [12, 41], shadowSize: [41, 41] });
  const readLatLng = () => {
    const lat = parseFloat(setF.lat.value);
    const lng = parseFloat(setF.lng.value);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
  };
  // Moves the pin (and fields) to a point chosen on the map
  function setVenue(lat, lng, { pan = false } = {}) {
    setF.lat.value = lat.toFixed(6);
    setF.lng.value = lng.toFixed(6);
    drawMap({ pan });
    $('#flagMapNote').innerHTML = `<b>Pin moved</b> to ${lat.toFixed(6)}, ${lng.toFixed(6)}. Drag it to fine-tune, then <b>Save settings</b>.`;
  }
  function drawMap({ pan = true } = {}) {
    const box = $('#flagMap');
    if (!window.L) {
      box.innerHTML = '<p class="muted small" style="padding:12px">The map could not be loaded. You can still type the latitude and longitude.</p>';
      return;
    }
    if (!venueMap) {
      venueMap = L.map(box, { center: DEFAULT_CENTER, zoom: 15, scrollWheelZoom: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(venueMap);
      venueMap.on('click', (e) => setVenue(e.latlng.lat, e.latlng.lng));
    }
    const at = readLatLng();
    const radius = Math.max(0, Number(setF.radius_m.value) || 0);
    // visibility (not display) so the layout never shifts under the Save button
    $('#flagGmaps').style.visibility = at ? 'visible' : 'hidden';
    if (!at) {
      venuePin?.remove();
      venueCircle?.remove();
      venuePin = venueCircle = null;
      if (pan) venueMap.setView(DEFAULT_CENTER, 15);
      return;
    }
    if (!venuePin) {
      venuePin = L.marker(at, { draggable: true, icon: pinIcon(), title: 'Venue (drag to move)', keyboard: true }).addTo(venueMap);
      venuePin.on('drag', (e) => venueCircle?.setLatLng(e.target.getLatLng()));
      venuePin.on('dragend', (e) => {
        const p = e.target.getLatLng();
        setVenue(p.lat, p.lng);
      });
      venueCircle = L.circle(at, { radius, color: '#1b7a3e', weight: 2, fillColor: '#1b7a3e', fillOpacity: 0.12, interactive: false }).addTo(venueMap);
    } else {
      venuePin.setLatLng(at);
      venueCircle.setLatLng(at).setRadius(radius);
    }
    if (pan) venueMap.setView(at, Math.max(venueMap.getZoom(), 17));
    $('#flagGmaps').href = `https://www.google.com/maps?q=${at[0]},${at[1]}`;
  }
  // The map is created while its tab is hidden; let it measure itself once shown
  const refreshMapSize = () => venueMap && setTimeout(() => venueMap.invalidateSize(), 50);

  // Place search (OpenStreetMap Nominatim), Philippines only
  async function searchPlace() {
    const q = $('#flagSearch').value.trim();
    const list = $('#flagSearchResults');
    if (!q) return;
    list.classList.remove('hidden');
    list.innerHTML = '<li class="muted small">Searching…</li>';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ph&limit=5&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const rows = await res.json();
      list.innerHTML = rows.length
        ? rows.map((r, i) => `<li><button type="button" class="linklike" data-place="${i}">${esc(r.display_name)}</button></li>`).join('')
        : '<li class="muted small">No place found. Try another name, or move the map and click on the venue.</li>';
      list.onclick = (e) => {
        const b = e.target.closest('[data-place]');
        if (!b) return;
        const r = rows[Number(b.dataset.place)];
        list.classList.add('hidden');
        venueMap?.setView([Number(r.lat), Number(r.lon)], 18);
        $('#flagMapNote').innerHTML = '<b>Now click the exact spot</b> of the flagpole on the map to drop the pin.';
      };
    } catch {
      list.innerHTML = '<li class="muted small">Search is not available right now. Move the map and click on the venue instead.</li>';
    }
  }
  $('#flagSearchBtn').addEventListener('click', searchPlace);
  $('#flagSearch').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), searchPlace()));
  flagLoaders.settings = guard(async () => {
    await loadFlagOptions(true);
    const s = flagOpts.settings;
    for (const k of ['venue', 'radius_m', 'max_accuracy_m']) setF[k].value = s[k];
    setF.lat.value = s.lat ?? '';
    setF.lng.value = s.lng ?? '';
    setF.require_selfie.checked = !!s.require_selfie;
    $('#flagRetention').textContent = flagOpts.photo_retention_days;
    $('#flagSchedRows').innerHTML = s.schedule.map(schedRow).join('');
    $('#flagSettingsSaved').textContent = flagOpts.settings_updated ? `Last saved by ${flagOpts.settings_updated.by} · ${flagOpts.settings_updated.at}` : 'Not saved yet.';
    showError($('#flagSettingsError'), '');
    drawMap();
    refreshMapSize();
  });
  // Typed coordinates move the pin as they are typed
  const typedLatLng = debounce(() => drawMap());
  setF.lat.addEventListener('input', typedLatLng);
  setF.lng.addEventListener('input', typedLatLng);
  setF.radius_m.addEventListener('input', () => drawMap({ pan: false }));
  $('#flagSchedAdd').addEventListener('click', () =>
    $('#flagSchedRows').insertAdjacentHTML('beforeend', schedRow({ weekday: 5, title: 'FLAG LOWERING CEREMONY', opens: '16:30', starts: '17:00', closes: '17:30' })),
  );
  $('#flagSchedRows').addEventListener('click', (e) => e.target.closest('[data-sched-del]')?.closest('tr').remove());
  // Choosing a ceremony fills in its usual times (they can still be changed)
  $('#flagSchedRows').addEventListener('change', (e) => {
    if (e.target.dataset.k !== 'title') return;
    const t = CEREMONY_TYPES[e.target.value];
    if (!t) return;
    const tr = e.target.closest('tr');
    for (const k of ['opens', 'starts', 'closes']) $(`[data-k=${k}]`, tr).value = t[k];
  });
  $('#flagHereBtn').addEventListener('click', () => {
    const note = $('#flagHereNote');
    if (!navigator.geolocation) return (note.textContent = 'This browser cannot share its location.');
    note.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setVenue(p.coords.latitude, p.coords.longitude, { pan: true });
        note.textContent = `Set (GPS ±${Math.round(p.coords.accuracy)} m). ${p.coords.accuracy > 30 ? 'For a better fix, use a phone outdoors near the flagpole. ' : ''}Remember to save.`;
      },
      (err) => (note.textContent = err.code === 1 ? 'Location permission was blocked for this site.' : 'Your location could not be read. Try again outdoors.'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  });
  setF.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const d = formData(setF);
    d.require_selfie = setF.require_selfie.checked;
    d.schedule = $$('#flagSchedRows tr').map((tr) => Object.fromEntries($$('[data-k]', tr).map((i) => [i.dataset.k, i.value])));
    try {
      await api('/admin/flag/settings', { method: 'PUT', body: d });
      await flagLoaders.settings();
      $('#flagSettingsSaved').textContent = `Saved. ${$('#flagSettingsSaved').textContent}`;
    } catch (err) {
      if (err.status === 401) throw err;
      showError($('#flagSettingsError'), err.message);
    }
  }));

  // ---------- Dialog ----------
  function openDialog(html, onSave, { wide = false, saveLabel = 'Save' } = {}) {
    const dlg = $('#dlg');
    dlg.classList.toggle('wide', wide);
    const form = $('#dlgForm');
    form.onclick = null; // a previous dialog may have left a click handler
    form.innerHTML = `${html}<div class="alert error hidden" id="dlgError"></div>
      <div class="actions"><button class="btn secondary" value="cancel" formnovalidate>Close</button><button class="btn" value="save">${esc(saveLabel)}</button></div>`;
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      const d = formData(form);
      d.notify = form.notify?.checked ? 'on' : '';
      try {
        await onSave(d);
        dlg.close();
      } catch (err) {
        showError($('#dlgError'), err.message);
      }
    };
    if (!dlg.open) dlg.showModal();
  }

  start();
})();
