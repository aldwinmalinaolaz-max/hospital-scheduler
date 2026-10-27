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
  async function start() {
    try {
      await api('/admin/me');
      $('#login').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#logoutBtn').classList.remove('hidden');
      showTab(location.hash.slice(1) || 'dashboard');
    } catch {
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
    if (!loaders[name]) name = 'dashboard';
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('[data-view]').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
    history.replaceState(null, '', `#${name}`);
    loaders[name]();
  }
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- Dashboard ----------
  loaders.dashboard = guard(async () => {
    const s = await api('/admin/stats');
    const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    $('#stats').innerHTML = [
      stat(s.appointmentsToday, 'OPD appointments today'),
      stat(s.checkedInToday, 'Checked in / seen today'),
      stat(s.upcomingAppointments, 'Upcoming appointments'),
      stat(s.recordsPending, 'Records pending / processing'),
      stat(s.recordsReady, 'Records ready for pickup'),
      stat(s.smsFailed, `Failed SMS (7 days) · ${esc(s.smsProvider)}`),
    ].join('');
    const [{ rows: appts }, { rows: recs }] = await Promise.all([
      api(`/admin/appointments?date=${s.today}`),
      api(`/admin/records?pickup_date=${s.today}`),
    ]);
    const active = appts.filter((a) => a.status !== 'CANCELLED');
    $('#dashAppts').innerHTML = active.length
      ? `<table><tbody>${active.map((a) => `<tr><td class="nowrap">${fmtTime(a.appt_time)}</td><td>${esc(a.patient_last)}, ${esc(a.patient_first)}<div class="sub">${esc(a.department_name)}</div></td><td>${badge(a.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No appointments today.</p>';
    const pick = recs.filter((r) => !['CANCELLED', 'REJECTED'].includes(r.status));
    $('#dashPickups').innerHTML = pick.length
      ? `<table><tbody>${pick.map((r) => `<tr><td class="mono">${esc(r.ref_no)}</td><td>${esc(r.patient_last)}, ${esc(r.patient_first)}<div class="sub">${r.items.map((i) => esc(i.name)).join(', ')}</div></td><td>${badge(r.status)}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">No pickups scheduled today.</p>';
  });

  // ---------- Records ----------
  const recFilters = $('#recFilters');
  recFilters.status.innerHTML += opts(REC_STATUSES);
  recFilters.type.innerHTML += cat.recordTypes.map((t) => `<option value="${t.code}">${esc(t.name)}</option>`).join('');
  let recRows = [];
  loaders.records = guard(async () => {
    const q = new URLSearchParams(Object.entries(formData(recFilters)).filter(([, v]) => v));
    recRows = (await api(`/admin/records?${q}`)).rows;
    $('#recRows').innerHTML =
      recRows
        .map(
          (r) => `<tr>
        <td class="mono">${esc(r.ref_no)}<div class="sub">${esc(r.created_at)}</div></td>
        <td>${esc(r.patient_last)}, ${esc(r.patient_first)} ${esc(r.patient_middle || '')}
          <div class="sub">DOB ${esc(r.birthdate)}${r.hospital_no ? ` · #${esc(r.hospital_no)}` : ''}</div>
          ${r.admission_date ? `<div class="sub">Adm ${esc(r.admission_date)}${r.discharge_date ? ` – ${esc(r.discharge_date)}` : ''}</div>` : ''}</td>
        <td>${r.items.map((i) => `${esc(i.name)}${i.details ? ` <i>(${esc(i.details)})</i>` : ''} ×${i.copies}`).join('<br>')}
          <div class="sub">Purpose: ${esc(r.purpose)}</div></td>
        <td>${esc(r.requester_name)}<div class="sub">${esc(r.requester_relation)}</div><div class="sub">${esc(r.mobile)}</div></td>
        <td class="nowrap">${esc(fmtDate(r.pickup_date, { month: 'short', day: 'numeric', weekday: 'short' }))}</td>
        <td>${badge(r.status)}${r.remarks ? `<div class="sub">${esc(r.remarks)}</div>` : ''}</td>
        <td class="no-print nowrap">${quickRec(r)}<button class="btn sm secondary" data-edit-rec="${r.id}">Edit</button></td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="7" class="empty">No records requests found.</td></tr>';
  });
  const quickRec = (r) => {
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
         <label class="field">Pickup date<input type="date" name="pickup_date" value="${esc(r.pickup_date)}"></label>
         <label class="field">Remarks<span class="hint">Shown to the requester. Required when rejecting.</span><textarea name="remarks">${esc(r.remarks || '')}</textarea></label>
         <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="notify" checked> Send SMS to requester for this change</label>
       </div>`,
      async (d) => patchRecRaw(r.id, { status: d.status, pickup_date: d.pickup_date, remarks: d.remarks, notify: d.notify === 'on' }),
    );
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
          <div class="sub">${a.patient_type === 'NEW' ? 'New' : 'Returning'} · ${esc(a.sex)} · DOB ${esc(a.birthdate)}${a.hospital_no ? ` · #${esc(a.hospital_no)}` : ''}</div>
          <div class="sub">${esc(a.mobile)}</div></td>
        <td>${esc(a.department_name)}</td>
        <td>${esc(a.complaint)}</td>
        <td>${badge(a.status)}${a.remarks ? `<div class="sub">${esc(a.remarks)}</div>` : ''}</td>
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
    $('#smsProvider').textContent =
      provider === 'console'
        ? 'SMS provider: console (messages are printed to the server log, not actually sent). Set SMS_PROVIDER in .env to go live.'
        : `SMS provider: ${provider}`;
    $('#smsRows').innerHTML =
      rows
        .map(
          (s) => `<tr>
        <td class="nowrap small">${esc(s.created_at)}</td>
        <td class="mono">${esc(s.recipient)}</td>
        <td class="small">${esc(s.kind)}${s.ref_no ? `<div class="sub mono">${esc(s.ref_no)}</div>` : ''}</td>
        <td class="small">${esc(s.message)}${s.error ? `<div class="sub" style="color:var(--danger)">${esc(s.error)}</div>` : ''}</td>
        <td>${badge(s.status)}</td>
        <td>${s.status === 'FAILED' ? `<button class="btn sm secondary" data-resend="${s.id}">Resend</button>` : ''}</td>
      </tr>`,
        )
        .join('') || '<tr><td colspan="6" class="empty">No SMS sent yet.</td></tr>';
  });
  $('#smsRows').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-resend]');
    if (!b) return;
    b.disabled = true;
    await api(`/admin/sms/${b.dataset.resend}/resend`, { method: 'POST' });
    loaders.sms();
  }));

  // ---------- Settings ----------
  loaders.settings = guard(async () => {
    const { rows } = await api('/admin/closed-dates');
    $('#closedList').innerHTML = rows.length
      ? `<table><tbody>${rows.map((r) => `<tr><td class="nowrap">${esc(fmtDate(r.date))}</td><td>${esc(r.reason)}</td><td><button class="btn sm secondary" data-del-closed="${r.date}">Remove</button></td></tr>`).join('')}</tbody></table>`
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

  // ---------- Dialog ----------
  function openDialog(html, onSave) {
    const dlg = $('#dlg');
    const form = $('#dlgForm');
    form.innerHTML = `${html}<div class="alert error hidden" id="dlgError"></div>
      <div class="actions"><button class="btn secondary" value="cancel" formnovalidate>Close</button><button class="btn" value="save">Save</button></div>`;
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
    dlg.showModal();
  }

  start();
})();
