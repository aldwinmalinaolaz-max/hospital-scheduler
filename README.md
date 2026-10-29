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

## Quick start (on your computer)

Requires **Node.js 22**. Without a `DATABASE_URL`, the app uses a built-in database stored in `./data`, so nothing else needs installing.

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start                 # http://localhost:3000
npm test
```
On Windows PowerShell, if `npm` is blocked by "running scripts is disabled", type `npm.cmd` instead of `npm`.

| Page | URL |
|---|---|
| Home | `/` |
| Request records | `/request-records` |
| Book OPD | `/book-opd` (add `?department=PEDIA` to preselect a clinic) |
| Track / cancel | `/track` |
| Staff panel | `/admin` (first login: `admin` / `admin123`, or the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set) |

## Deploy on Vercel with Supabase

Vercel runs the API as a serverless function and serves the pages from `public/`. Supabase stores the data. The app creates its tables automatically on first use.

### 1. Create the Supabase database
1. Sign in at https://supabase.com and click **New project**. Choose the **Southeast Asia (Singapore)** region and save the database password you set.
2. When the project is ready, click **Connect** at the top of the dashboard.
3. Under **Connection string**, choose **Transaction pooler** (port **6543**) and copy the URI. It looks like:
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`
4. Replace `[YOUR-PASSWORD]` with your database password. If the password contains symbols such as `@`, `#` or `/`, reset it to letters and numbers only in **Project Settings → Database**.

### 2. Set the Vercel environment variables
In Vercel, open your project and go to **Settings → Environment Variables**. Add these:

| Name | Value |
|---|---|
| `DATABASE_URL` | the Supabase connection string from step 1 |
| `SESSION_SECRET` | a long random string (40+ letters and numbers) |
| `ADMIN_PASSWORD` | the first staff password (you can change it later in Settings) |
| `CRON_SECRET` | another long random string, used for reminders (step 3) |
| `HOSPITAL_NAME` | your hospital's name |
| `SMS_PROVIDER`, `SEMAPHORE_API_KEY`, … | see [SMS setup](#sms-setup) |

Then go to **Deployments**, open the **⋯** menu on the latest deployment and choose **Redeploy**. Environment variable changes only take effect after a redeploy.

### 3. Schedule the SMS reminders
Vercel's free plan only runs scheduled jobs once a day, so reminders use a free external scheduler:
1. Create a free account at https://cron-job.org and click **Create cronjob**.
2. Set **URL** to `https://YOUR-APP.vercel.app/api/cron/reminders?key=YOUR_CRON_SECRET`.
3. Set the schedule to **Every 5 minutes** and save.

Each call sends any reminders that are due. A reminder is never sent twice, even if calls overlap. You can test the URL in your browser: it should show `{"ok":true,"sent":0}`.

### Security notes
- The app turns on Row Level Security for every table, which blocks Supabase's public REST API from reading patient data. The app itself connects as the database owner and is not affected. Don't add RLS policies, and don't use the Supabase `anon` key anywhere.
- The function refuses to start without `SESSION_SECRET`.

## How it works

### Records requests
- Documents may be claimed 3 calendar days after the request (`RECORDS_CLAIM_DAYS`). If that date falls on a weekend or a closed date set in Settings, it moves to the next working day, so a Friday request is claimable on Monday.
- The requester doesn't choose a date: the claiming date is set automatically and shown on the Review step, the confirmation screen and the SMS. Staff can still move it from the admin panel.
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

### Hospital Directory & Navigation
The public **Hospital Directory** page (`/directory`) is a phone-friendly guide with five sections:
- **Directory:** departments, clinics and offices, with search and category filters. Each shows its location, hours, phone, email and services, plus **Show on map**, **Book appointment** (OPD clinics) and call links.
- **Schedules:** OPD clinic days and hours (taken from the booking settings, so they always match) and office hours.
- **Requirements:** step-by-step guides for common transactions (what to bring, steps, where to go).
- **Contact:** address, phone numbers, email, Facebook, website and an **Open in Google Maps** link.
- **Maps:** building and floor maps. Places with a pin are numbered on the map, and **Show on map** highlights the place and zooms to it.

Administrators manage everything in **Admin → Directory**:
- **Places:** add, edit or hide departments, clinics and offices. Link an OPD clinic to use its booking schedule and show a Book button.
- **Maps:** upload a floor plan or photo (PNG/JPG/WebP; large photos are shrunk in the browser before upload). Then edit a place, choose the map and **click on the map** to put its pin.
- **Guides:** requirements and steps, one per line, with an optional button link and "where to go" office.
- **Contact information:** empty fields are hidden on the public page.

Starter content (the OPD clinics, the Medical Records Section, the Emergency Room and four transaction guides) is created on first start. Locations, phone numbers, maps and contact details are left blank on purpose. Please fill them in with the hospital's real information.

### FAQ assistant
Every public page has a **Questions? Ask us** button that opens a chat window. Visitors can tap a suggested question or type their own. The assistant picks the staff-written FAQ whose keywords best match the message, so it only ever gives answers you have approved.

Administrators manage it in **Admin → FAQs**:
- Add, edit, hide or delete FAQs, with an optional button link (a page such as `/track`, or an `https://` address).
- **Keywords** are the words visitors are likely to type, separated by commas, in any language (e.g. `claim, pick up, kailan, kanus a`).
- Answers can include automatic values that follow the system's settings: `{hospital}`, `{claim_days}`, `{office_days}`, `{opd_hours}`, `{documents}`, `{clinic_schedule}`.
- **Questions the assistant couldn't answer** are listed so you can turn them into new FAQs or keywords. Visitors may type personal details, so clear the list once reviewed.

A set of starter FAQs is created the first time the app starts. Review them, especially fees and office hours, and edit them to match the hospital's actual policies.

### Users and roles
Staff accounts are managed in **Admin → Users** by administrators. There are two roles:
- **Administrator:** everything, plus managing users, holidays/closed dates and the test SMS.
- **Staff:** works only in the sections they're given access to, can view the SMS log for those sections, and can change their own password.

Each Staff user has two access checkboxes: **Records Requests** and **OPD Appointments**. They need at least one. A Records-only user doesn't see the OPD tab, OPD dashboard numbers or OPD text messages, and the server refuses OPD requests from them; the same applies the other way round. Access changes take effect on the user's next click, without logging them out. Administrators always have both.

Usernames aren't case-sensitive. Resetting a user's password, changing their role or deactivating them signs them out of every device immediately. You can't deactivate or demote yourself, and there is always at least one active administrator. Each records request and appointment shows which user last changed it.

The first administrator is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` the first time the app starts.

### Capital letters
Everything typed into the forms is converted to capital letters, both in the browser and when it's saved. Passwords, usernames and email addresses are kept exactly as typed.

### Staff panel
- **Dashboard:** today's counts, today's OPD list and today's pickups.
- **Records and Appointments:** search and filter, one-click status buttons, an edit dialog for rescheduling and remarks (with an option to notify the patient), and a printable daily list.
- **SMS Log:** every message sent, with failures shown and a **Resend** button.
- **Users** (administrators only): add users, change roles, deactivate, reset passwords.
- **Settings:** holidays and closed dates, a test SMS, and password change.

## SMS setup
Set `SMS_PROVIDER` in `.env` to one of these:
- `console`: messages are only printed to the server log. This is the default and is meant for testing.
- `unisms`: [UniSMS](https://unismsapi.com), a Philippine gateway. Set `UNISMS_API_KEY` to your UniSMS secret key, and optionally `SMS_SENDER_NAME` to a sender ID registered with UniSMS.
- `semaphore`: [Semaphore](https://semaphore.co), a Philippine gateway. Set `SEMAPHORE_API_KEY`, and optionally `SMS_SENDER_NAME` (it must be registered with Semaphore).
- `twilio`: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM`.

Mobile numbers are stored in E.164 format, so `09171234567` becomes `+639171234567`. You can change the message wording in `src/messages.js`.

## Customising
- **Document types, processing days, requirements, clinics and clinic days:** `src/catalog.js`
- **Capacities, hours and reminder times:** `.env`

## Project layout
```
api/index.js      Vercel serverless entry (wraps the Express app)
vercel.json       Vercel routing: /api/* → function, everything else → public/
src/
  server.js       Express app, cron endpoint, local server + reminder scheduler
  config.js       .env settings
  catalog.js      document types, clinics, statuses
  db.js           Postgres schema + drivers (Supabase via DATABASE_URL, else embedded PGlite)
  scheduling.js   pickup-date & OPD slot availability
  reminders.js    background SMS reminder job
  sms.js          SMS providers + logging
  messages.js     SMS templates
  routes/         public and admin JSON APIs
public/           HTML/CSS/JS front end (no build step)
test/             node:test API + reminder tests (set TEST_DATABASE_URL to run against a throwaway Postgres)
```

## Before going live
- Set a strong `ADMIN_PASSWORD` and a random `SESSION_SECRET`. Vercel serves HTTPS automatically. If you self-host, put the app behind nginx or Caddy for HTTPS.
- Backups: Supabase's paid plans include daily backups. On the free plan, export regularly (Supabase → Database → Backups, or `pg_dump`). Note that free Supabase projects pause after a week with no activity.
- Have your Data Protection Officer review the consent text in `public/js/common.js`, since the app handles health information under RA 10173.
- Each request form has a rate limit of 20 submissions per IP per 10 minutes. It is kept in memory per server instance, so on Vercel it is only a light safeguard.
