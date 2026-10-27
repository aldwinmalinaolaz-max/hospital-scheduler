# Hospital Online Scheduling

A web app with two patient services:

1. **Hospital records requests.** Patients pick one or more documents and choose a pickup date.
   - Clinical Abstract / Discharge Summary
   - OPTECH Report
   - Medical Certificate
   - Certificate of Confinement
   - Medico-Legal Certificate
   - Diagnostic Test Result
   - Laboratory Test Result
   - Others (patient specifies)
2. **OPD appointments.** Patients book by clinic, date and time slot.

Patients get SMS messages at each step, plus automatic reminders.

## Quick start

Requires **Node.js 22.13 or newer**. The database is Node's built-in SQLite, so nothing else needs installing.

```bash
npm install
cp .env.example .env      # set the hospital name, admin password, SESSION_SECRET and SMS provider
npm start                 # http://localhost:3000
npm test
```

| Page | URL |
|---|---|
| Home | `/` |
| Request records | `/request-records` |
| Book OPD | `/book-opd` (add `?department=PEDIA` to preselect a clinic) |
| Track / cancel | `/track` |
| Staff panel | `/admin` (default login: `admin` / `admin123`, or what you set in `.env`) |

## How it works

### Records requests
- Each document type has a processing time in working days. The earliest pickup date is based on the slowest document selected, and it skips Sundays, Saturdays (configurable) and the closed dates set in Settings.
- Each day has a pickup capacity (`RECORDS_DAILY_CAPACITY`). Full days can't be chosen.
- Statuses run **Pending → Processing → Ready → Released**. A request can also end as **Rejected** (a reason is required) or **Cancelled** (by the requester, only while Pending).
- SMS is sent when the request is submitted, when it's Ready, when it's Rejected, and when staff move the pickup date. A pickup reminder goes out at 7:00 AM on the pickup date if the request is Ready.

### OPD appointments
- Each clinic has its own clinic days (see `src/catalog.js`). Slots run from `OPD_START` to `OPD_END`, `OPD_SLOT_MINUTES` long, with up to `OPD_PATIENTS_PER_SLOT` patients each.
- Patients can't double-book the same clinic on the same day. When an appointment is cancelled, its slot opens up again.
- Statuses: **Booked → Checked in → Completed**, or **No show** / **Cancelled**. Staff can reschedule to any open slot.
- **SMS:**
  - A confirmation when the appointment is booked.
  - A reminder **the day before** at `REMINDER_DAY_BEFORE_TIME`.
  - A reminder **`REMINDER_HOURS_BEFORE` hours before** the appointment.
  - A message when the appointment is cancelled or rescheduled.
  - If someone books after a reminder's send time has passed, that reminder is skipped, because the confirmation SMS already covers it.

### Tracking
Patients look up a request with its reference number and their mobile number. Records references start with `R-` and appointment references start with `A-`.

### Staff panel
- **Dashboard:** today's counts, today's OPD list and today's pickups.
- **Records and Appointments:** search and filter, one-click status buttons, an edit dialog for rescheduling and remarks (with an option to notify the patient), and a printable daily list.
- **SMS Log:** every message sent, with failures shown and a **Resend** button.
- **Settings:** holidays and closed dates, a test SMS, and password change.

## SMS setup
Set `SMS_PROVIDER` in `.env` to one of these:
- `console`: messages are only printed to the server log. This is the default and is meant for testing.
- `semaphore`: [Semaphore](https://semaphore.co), a Philippine gateway. Set `SEMAPHORE_API_KEY`, and optionally `SMS_SENDER_NAME` (it must be registered with Semaphore).
- `twilio`: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`.

Mobile numbers are stored in E.164 format, so `09171234567` becomes `+639171234567`. You can change the message wording in `src/messages.js`.

## Customising
- **Document types, processing days, requirements, clinics and clinic days:** `src/catalog.js`
- **Capacities, hours and reminder times:** `.env`

## Project layout
```
src/
  server.js       Express app + reminder scheduler startup
  config.js       .env settings
  catalog.js      document types, clinics, statuses
  db.js           SQLite schema
  scheduling.js   pickup-date & OPD slot availability
  reminders.js    background SMS reminder job
  sms.js          SMS providers + logging
  messages.js     SMS templates
  routes/         public and admin JSON APIs
public/           HTML/CSS/JS front end (no build step)
test/             node:test API + reminder tests
```

## Before going live
- Set a strong `ADMIN_PASSWORD` and a random `SESSION_SECRET`. Serve the app over HTTPS, for example behind nginx or Caddy.
- Back up `data/hospital.db`.
- Have your Data Protection Officer review the consent text in `public/js/common.js`, since the app handles health information under RA 10173.
- Each request form has a rate limit of 20 submissions per IP per 10 minutes. It is kept in memory, so it resets when the server restarts.
