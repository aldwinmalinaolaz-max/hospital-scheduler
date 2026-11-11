# ZRMC ONE Hospital System

Zamboanga Regional Medical Center's online system for patients, staff and referring facilities.

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

The home page has two buttons: **Public** (records, OPD, tracking, directory and the referral portal) and **Staff** (Attendance Monitoring and the Staff Panel). `/#staff` opens the Staff side directly, e.g. for a bookmark on hospital PCs.

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

### Hardcopy or digital copy
On the last step of a records request (email is required), the requester chooses:
- **Hardcopy:** claim the printed documents at HHIMS on the claiming date.
- **Digital copy:** documents are emailed after the requester's identity is checked. The requester uploads a **photo of a valid ID** and a **selfie holding the same ID**, taken with the phone camera or chosen from the gallery and shrunk in the browser before upload. Digital copies are only offered when the **patient** is the requester; representatives claim hardcopies with the signed authorization letter.

Staff workflow (Records Requests; filter by *Digital copy*, *ID to check* or *Assigned to me*):
1. **Verify ID:** compare the ID and selfie with the request, then **Approve** or **Reject (with a reason)**. Approving moves the request to Processing and assigns it to you. Rejecting texts the reason, and the requester uploads new photos on **Track / Cancel**.
2. Reassign the request with **Edit → Assigned to** if someone else will send it.
3. **Send by email:** opens the staff member's email app with the recipient, subject and message filled in. Attach the scanned documents, send from the hospital's official account, then click **Mark as sent**. This releases the request and texts the requester (email partly hidden).

**Fees and online payment.** Each document shows its fee per copy, and the form keeps a running **total payable**. The Review step shows the breakdown, and the total is saved with the request (for hardcopies it's for reference). Digital copy requesters pay the total by scanning the **GCash / InstaPay QR code** (a **Save QR code** button lets phone users upload it in their app), then upload a **screenshot of the receipt** and optionally the payment reference number. Staff check the receipt together with the ID in **Verify ID & payment**. Administrators set the fees, replace the QR code (e.g. with the hospital's official account) and edit the payment instructions in **Settings → Fees & online payment**. The default fees are in `src/catalog.js` and the default QR is `public/img/payment-qr.jpg`.

ID photos and receipts are visible only to staff with Records access and are deleted automatically `ID_PHOTO_RETENTION_DAYS` (default 30) days after the request is released, rejected or cancelled. Deletion runs with the scheduled reminders job. The dashboard shows how many digital requests are waiting for an ID check.

### Authorization letter (requests by a representative)
When the requester is not the patient, the form also asks for the **patient's address**. After submitting, the requester can download the hospital's **Authorization Letter (FM-HHIM-05 Rev 2)** as a Word file, already filled in:
- the patient's name and address, and the representative's name;
- the requested documents ticked (Medical Certificate, Certificate of Confinement), with everything else listed under **Others**;
- the printed names and the request date beside both signature lines.

The requester prints it, has it signed by the patient and the representative, and brings it with both valid IDs. The letter can be downloaded again from **Track / Cancel**, and staff can download it from the **Letter** button in the Records list. The template is `templates/authorization-letter.docx`; if the form is revised, the blanks are found by their paragraph IDs in `src/letter.js`.

### OPD appointments
- Each clinic's days, hours, slot length and patients per slot are set per month in **Admin → OPD Schedules** (see below).
- Patients can't double-book the same clinic on the same day. When an appointment is cancelled, its slot opens up again.
- Statuses: **Booked → Checked in → Completed**, or **No show** / **Cancelled**. Staff can reschedule to any open slot.
- **SMS:**
  - A confirmation when the appointment is booked.
  - A reminder **the day before** at `REMINDER_DAY_BEFORE_TIME`.
  - A reminder **`REMINDER_HOURS_BEFORE` hours before** the appointment.
  - A message when the appointment is cancelled or rescheduled.
  - If someone books after a reminder's send time has passed, that reminder is skipped, because the confirmation SMS already covers it.

### OPD Schedules (monthly)
Clinic schedules change every month, so they're managed in **Admin → OPD Schedules**, by Administrators and by Staff with OPD access:
- Use the arrows to pick a month. For each clinic, **Edit** sets its clinic days, start and end time, minutes per slot and patients per slot.
- On the month calendar, **click a clinic day to close it** (e.g. doctor on leave), or **click any other day to add an extra clinic day**. Hospital closed dates from Settings are shown, and an extra day can open a clinic on one of them.
- Add a **note for patients** (e.g. "Dr. Santos on leave Nov 18–20"). It's shown on the booking page and in the Hospital Directory.
- **Copy last month to this month** fills the month for every clinic not yet set, so only the changes need editing.
- If a month hasn't been set, each clinic's latest earlier schedule **carries over** (without its date changes), so booking never stops. The screen marks clinics as *Set*, *Carried over* or *Not scheduled*.
- **+ Add clinic** creates a new clinic, and **Clinic** renames, reorders or hides one. A new clinic can be booked once it has a schedule.

Booking (dates and time slots), the Hospital Directory (this month and, once published, next month), the FAQ assistant's schedule answer and SMS messages all follow these schedules. Changing a schedule doesn't move existing appointments; reschedule those from **OPD Appointments**.

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

Starter content (the OPD clinics, the Hospital Health Information Management Section (HHIMS), the Emergency Room and four transaction guides) is created on first start. Locations, phone numbers, maps and contact details are left blank on purpose. Please fill them in with the hospital's real information.

### Referrals (RHUs, barangay health centers, other hospitals)
Referring facilities use the **Referral Portal** at `/facility`, with their own accounts. These are separate from staff accounts and can't open the staff panel. There they can:
- send a referral: patient details, urgency (Emergency / Urgent / Routine), receiving service (ER, Admission, or an OPD clinic), reason, chief complaint, history, vital signs, working diagnosis, treatment given, the referring health worker, and up to 5 photo or PDF attachments (3 MB total);
- follow its status (Sent → Received → Accepted / Redirected → Patient arrived → Seen) and ZRMC's response or appointment;
- print the **referral slip**, and the **return slip** once ZRMC has entered its feedback;
- cancel a referral ZRMC hasn't answered yet.

Staff with the **Referrals** permission (Users → Access; administrators always have it) use **Referrals** in the staff panel:
- **Inbox:** emergencies first. Opening a referral marks it received, and the dashboard shows how many are waiting.
- **Accept:** with a message to the facility and, optionally, an **OPD appointment** booked straight from the clinic schedules. SMS goes to the facility's number and the patient.
- **Redirect:** a reason is required and is texted to the facility. **Patient arrived** and **Seen** add return-slip feedback.
- **Export for Bizbox:** a CSV (opens in Excel) of accepted referrals for a date range, optionally only those not exported before. The columns are generic until the Bizbox vendor provides their import layout, which can then be matched in `EXPORT_COLUMNS` in `src/referrals.js`.
- **Monthly report:** referrals by facility (total, accepted, redirected, emergency), by receiving service and by status.
- **Facilities & accounts:** add or edit facilities (type, municipality, contact person, SMS number) and their user accounts (add, deactivate, reset password).

### Attendance Monitoring (staff)
Employees time in and out at **attendance kiosks**: a tablet or PC at an entrance with `/attendance` open. They type their employee no. and PIN and tap **TIME IN** or **TIME OUT**; the screen greets them and shows the time recorded. The time always comes from the server, never from the device.

- **Kiosks only.** Time in/out works only on devices registered as kiosks, so nobody can clock in from home. To register one, open `/attendance` on the device, choose **Set up this device as an attendance kiosk**, name it (e.g. MAIN LOBBY) and log in with an account that has Attendance access. Remove a kiosk in **Staff Panel → Attendance → Kiosks**.
- **Photo at every punch** (optional per kiosk, on by default): the kiosk camera takes a small photo so supervisors can spot buddy punching. Photos are visible only to staff with Attendance access and deleted after `ATTENDANCE_PHOTO_RETENTION_DAYS` (default 90).
- **PINs:** 4–6 digits. HR sets or generates one when adding the employee; employees can change it at the kiosk (**Change my PIN**). After `ATTENDANCE_MAX_PIN_ATTEMPTS` wrong PINs (default 5) the employee no. is locked for `ATTENDANCE_LOCK_MINUTES` (default 15); **Reset PIN** unlocks it.
- Tapping the same button twice within 5 minutes records it once. A time-out without a time-in (or two time-ins in a row) shows a warning to the employee and appears in the DTR remarks.

**Staff Panel → Attendance** (Administrators, and Staff given **Attendance Monitoring** access in Users):
- **Today:** who is on duty now, who has not timed in, who was late; filter by department; printable.
- **Time logs:** every time in/out with kiosk, photo and who made manual entries. **Manual entry** adds a missed punch (e.g. kiosk down, official business) with a required reason. Wrong entries are **voided** with a reason, never deleted, and stay visible crossed out for audit.
- **Employees:** add, edit, deactivate, reset PIN, or **Import list** pasted from Excel (employee no., last, first, middle, position, department); imported employees get random PINs listed once for printing.
- **DTR & reports:** prints the **Daily Time Record (CSC Form No. 48)**, two copies per page, for one employee or a whole department; an on-screen monthly summary; and a CSV (days present, times late, tardiness, undertime, missing time-in/out, hours worked).
- **Kiosks:** registered devices, last used, photo on/off, remove.

How the DTR is computed: each time-in is paired with the next time-out (up to 20 hours later), so night shifts count for the day they started. With one time-in/out pair, the times go to A.M. arrival and P.M. departure; with a lunch break out/in they fill all four columns. **Undertime** is tardiness (time-in after the official start plus `ATTENDANCE_GRACE_MINUTES`, default 0) plus leaving before the official end. Each employee has official hours (default `ATTENDANCE_SHIFT_START`–`ATTENDANCE_SHIFT_END`, 08:00–17:00) or is marked **Shifting**, in which case no tardiness/undertime is computed.

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

Each Staff user has access checkboxes: **Records Requests**, **OPD Appointments**, **Referrals** and **Attendance Monitoring**. They need at least one. A Records-only user doesn't see the OPD tab, OPD dashboard numbers or OPD text messages, and the server refuses OPD requests from them; the same applies the other way round. Access changes take effect on the user's next click, without logging them out. Administrators always have both.

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
- **Document types and requirements:** `src/catalog.js`. Clinics and their schedules: **Admin → OPD Schedules**.
- **Capacities, hours and reminder times:** `.env`

## Project layout
```
api/index.js      Vercel serverless entry (wraps the Express app)
vercel.json       Vercel routing: /api/* → function, everything else → public/
src/
  server.js       Express app, cron endpoint, local server + reminder scheduler
  config.js       .env settings
  catalog.js      document types, statuses, starting clinic list
  clinics.js      OPD clinics and monthly schedules (carry-over, open days, slots)
  db.js           Postgres schema + drivers (Supabase via DATABASE_URL, else embedded PGlite)
  scheduling.js   pickup-date & OPD slot availability
  reminders.js    background SMS reminder job
  attendance.js   attendance: time-in/out pairing, DTR (CSC Form 48), PIN and kiosk helpers
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
- Each request form has a rate limit of 20 submissions per IP per 10 minutes (`SUBMIT_RATE_LIMIT`), and staff login 10 attempts (`LOGIN_RATE_LIMIT`). These are kept in memory per server instance, so on Vercel they are only a light safeguard.
