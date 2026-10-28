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
    const allowed = { users: me?.role === 'ADMIN', records: me?.access.records, appointments: me?.access.opd };
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
          <div class="sub">DOB ${esc(r.birthdate)}${r.hospital_no ? ` · #${esc(r.hospital_no)}` : ''}</div>
          ${r.admission_date ? `<div class="sub">Adm ${esc(r.admission_date)}${r.discharge_date ? ` – ${esc(r.discharge_date)}` : ''}</div>` : ''}</td>
        <td>${r.items.map((i) => `${esc(i.name)}${i.details ? ` <i>(${esc(i.details)})</i>` : ''} ×${i.copies}`).join('<br>')}
          <div class="sub">Purpose: ${esc(r.purpose)}</div></td>
        <td>${esc(r.requester_name)}<div class="sub">${esc(r.requester_relation)}</div><div class="sub">${esc(r.mobile)}</div></td>
        <td class="nowrap">${esc(fmtDate(r.pickup_date, { month: 'short', day: 'numeric', weekday: 'short' }))}</td>
        <td>${badge(r.status)}${r.remarks ? `<div class="sub">${esc(r.remarks)}</div>` : ''}${updatedBy(r)}</td>
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
