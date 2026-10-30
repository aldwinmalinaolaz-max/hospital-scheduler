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
      $('#whoami').innerHTML = `${esc(me.full_name || me.username)} · <b>${me.role === 'ADMIN' ? 'Administrator' : 'Staff'}</b>`;
      $('#whoami').classList.remove('hidden');
      $('#login').classList.add('hidden');
      $('#app').classList.remove('hidden');
      $('#logoutBtn').classList.remove('hidden');
      showTab(location.hash.slice(1) || 'dashboard');
    } catch {
      me = null;
      document.body.classList.remove('signed-in', 'is-admin', 'can-records', 'can-opd');
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
    const allowed = { users: me?.role === 'ADMIN', faqs: me?.role === 'ADMIN', directory: me?.role === 'ADMIN', records: me?.access.records, appointments: me?.access.opd };
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
          <div class="sub">Purpose: ${esc(r.purpose)}</div></td>
        <td>${esc(r.requester_name)}<div class="sub">${esc(r.requester_relation)}</div><div class="sub">${esc(r.mobile)}</div></td>
        <td class="nowrap">${esc(fmtDate(r.pickup_date, { month: 'short', day: 'numeric', weekday: 'short' }))}</td>
        <td>${badge(r.status)}${r.remarks ? `<div class="sub">${esc(r.remarks)}</div>` : ''}${updatedBy(r)}</td>
        <td class="no-print nowrap">${quickRec(r)}<button class="btn sm secondary" data-edit-rec="${r.id}">Edit</button>
          ${/^self/i.test(r.requester_relation) ? '' : `<a class="btn sm secondary" href="/api/admin/records/${r.id}/authorization-letter" download title="Authorization letter filled in with this request's details">Letter</a>`}</td>
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
  loaders.settings = guard(async () => {
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
    x.role === 'ADMIN' ? 'All' : [x.can_records && 'Records Requests', x.can_opd && 'OPD Appointments'].filter(Boolean).join('<br>');
  // Access checkboxes; disabled for Administrators, who always have both
  const accessFields = (x) => `
    <fieldset class="access" ${x.role === 'ADMIN' ? 'disabled' : ''}>
      <legend>Access</legend>
      <label><input type="checkbox" name="can_records" ${x.can_records !== false ? 'checked' : ''}> Records Requests</label>
      <label><input type="checkbox" name="can_opd" ${x.can_opd !== false ? 'checked' : ''}> OPD Appointments</label>
      <p class="hint">Administrators always have access to both.</p>
    </fieldset>`;
  const wireAccess = () => {
    const role = $('#dlgForm [name=role]');
    const fs = $('#dlgForm fieldset.access');
    role.addEventListener('change', () => (fs.disabled = role.value === 'ADMIN'));
  };
  const readAccess = () => ({
    can_records: $('#dlgForm [name=can_records]').checked,
    can_opd: $('#dlgForm [name=can_opd]').checked,
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
          <div class="dir-actions"><button class="btn sm secondary" data-edit-map="${m.id}">Edit</button><button class="btn sm secondary" data-del-map="${m.id}">Delete</button></div>
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

  $('#addEntryBtn').addEventListener('click', () => entryDialog());
  $('#addGuideBtn').addEventListener('click', () => guideDialog());
  $('#addMapBtn').addEventListener('click', () => mapDialog());
  $('[data-view="directory"]').addEventListener('click', guard(async (ev) => {
    const b = ev.target.closest('[data-edit-entry],[data-del-entry],[data-edit-guide],[data-del-guide],[data-edit-map],[data-del-map]');
    if (!b) return;
    const d = b.dataset;
    if (d.editEntry) return entryDialog(dir.entries.find((x) => x.id === Number(d.editEntry)));
    if (d.editGuide) return guideDialog(dir.guides.find((x) => x.id === Number(d.editGuide)));
    if (d.editMap) return mapDialog(dir.maps.find((x) => x.id === Number(d.editMap)));
    if (d.delEntry && confirm('Delete this place from the directory?')) await api(`/admin/directory/entries/${d.delEntry}`, { method: 'DELETE' });
    else if (d.delGuide && confirm('Delete this guide?')) await api(`/admin/directory/guides/${d.delGuide}`, { method: 'DELETE' });
    else if (d.delMap && confirm('Delete this map? Places on it will lose their pins.')) await api(`/admin/maps/${d.delMap}`, { method: 'DELETE' });
    else return;
    loaders.directory();
  }));

  // ---------- Dialog ----------
  function openDialog(html, onSave, { wide = false } = {}) {
    const dlg = $('#dlg');
    dlg.classList.toggle('wide', wide);
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
