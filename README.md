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

The home page has two buttons: **Public** (records, OPD, tracking, directory and the referral portal) and **Staff** (Flag Ceremony Attendance and the Staff Panel). `/#staff` opens the Staff side directly, e.g. for a bookmark on hospital PCs.

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

### Automatic ID check (OCR) for digital copies
When a requester adds the photo of their valid ID, the page reads the text on the ID with OCR (Tesseract.js) **in their own browser** and compares it with the patient's last, first and middle name and birthdate. Right under the photo they see either **✓ ID check passed** or a note listing exactly what didn't match, e.g. *Last name "DELA CRUZ" was not found on the ID* or *Birthdate May 14, 1990 was not found on the ID. Date read on the ID: May 15, 1990.* They can fix a typo in the patient details (the note updates immediately) or retake a clearer photo. A mismatch never blocks the request, because OCR can misread photos. The same check runs when new photos are uploaded on the Track page.

- **Staff:** the records list shows an **ID check** badge (Matches / Partly matched / Does not match / ID not readable; hover for the notes). **Verify ID & payment** reads the stored ID photo again in the staff member's browser (the requester's own result could be tampered with) and shows the notes and the text read; **Re-check ID** runs it again. Staff still compare the photos themselves and decide.
- **Matching:** names allow for OCR slips (one wrong letter in longer names, 0/O and 1/I mix-ups), accents (PEÑA = PENA) and joined or split surnames (DELACRUZ / DELA CRUZ); dates are recognised in the usual ID formats (MAY 14, 1990 · 14 MAY 1990 · 1990/05/14 · 05/14/1990). Middle names that are not found are noted but don't count as a mismatch, since many IDs show only the initial.
- **Privacy:** the photo is not sent anywhere for reading; the OCR files are served from this site (`public/vendor/tesseract`, about 8 MB, downloaded once per browser). The text read from the ID is stored with the request for staff and deleted together with the ID photos after the retention period.

### Flag Ceremony Attendance (staff)
Employees check in on **their own phones** at `/flag-ceremony` (home page → **Staff** → Flag Ceremony Attendance). They sign in once with their employee no. and 6-digit PIN and the phone remembers them (`FLAG_REMEMBER_DAYS`, default 180). During the check-in window the page shows how far they are from the venue and a big **CHECK IN** button.

- **GPS geofence.** A check-in counts only when the phone's location is within the set radius of the venue (default 150 m) and the GPS reading is precise enough (default ±100 m). Otherwise the employee is told how far away they are, or to step outdoors and try again. The distance and accuracy of every check-in are kept for HR. Location needs HTTPS (Vercel provides it) and the employee's permission in the browser.
- **No late:** anyone who checks in between the check-in opening and closing times (by the server's clock) is **present**. The ceremony's start time is shown to employees for information only.
- **One phone, one employee.** A phone that has checked in one employee cannot check in another for the same ceremony, so an employee at the venue cannot check in absent co-workers. For extra assurance, **Require a selfie** makes employees take a selfie at check-in. Selfies are visible only to staff with Flag Ceremony access and deleted after `FLAG_PHOTO_RETENTION_DAYS` (default 90).
- **PINs:** 6 digits, set or randomly generated by HR. Employees can change theirs on the check-in page. After `FLAG_MAX_PIN_ATTEMPTS` wrong PINs (default 5) the employee no. is locked for `FLAG_LOCK_MINUTES` (default 15). **Reset PIN** unlocks it and signs the employee out of their phone.

**Staff Panel → Flag Ceremony** (Administrators, and Staff given **Flag Ceremony Attendance** access in Users):
- **Venue & schedule:** venue name and location: **pin it manually** on the map (click the spot or drag the pin; **Find** searches for a place, and the circle shows the check-in area as you change the radius), type the latitude/longitude, or tap **Use my current location** while standing at the flagpole; geofence radius, required GPS accuracy, selfie on/off; and the **weekly schedule** (default: Monday flag raising, check-in 7:00–9:00 AM, starts 8:00 AM). Check-in stays off until the location is saved. Weekly ceremonies are created automatically from that day on.
- **Ceremonies:** each month's ceremonies with present / excused / absent counts. **+ Special ceremony** adds a one-time ceremony (e.g. Friday flag lowering, a holiday program); **Edit** changes times; **Move date** moves a ceremony that hasn't started to another date with a reason (e.g. the Monday is a holiday → Tuesday); the original date stays in the list marked *moved to …* (not counted, and the weekly schedule doesn't recreate it), the new date shows *moved from …*, and excuses already recorded move with it. **Remarks** adds a note to any ceremony, before or after it (e.g. *held at the main lobby due to rain*, *shortened due to bad weather*); employees see it on their check-in page. **Cancel** (with a reason, e.g. typhoon) removes a date from check-in and the summary. **Attendance** opens the list of everyone expected, with time, distance from the venue and selfie; filter by division or status; print or download CSV. **Mark / Change** sets an employee present or excused with a reason (e.g. on approved leave, on duty at the ER, GPS not working), recorded with the staff username.
- **Scan QR** (for employees without a phone or who forgot it; **Administrators and HR only**: in Users, tick *QR scanning at the venue (HR only)* under Flag Ceremony Attendance — other Flag Ceremony users don't see this tab and the server refuses their scans): HR opens this tab on a phone or tablet at the venue, taps **Start camera** and scans the QR code on each employee's ID, or types the employee no. A big green **PRESENT** with the employee's name, number, division and unit appears (with a beep), so the marshal can check it is the right person; a second scan of the same person shows *Already recorded*. Works only while check-in is open; the entry is recorded as *QR scan by <staff>* and can be removed from the attendance list if scanned by mistake. Reads the QR codes printed by the system (`ZRMC-EMP:<employee no.>`), a QR that holds just the employee no., or a longer QR text containing it. Uses the phone's built-in QR reader where available, otherwise jsQR (`public/vendor/qr`), so it also works on iPhones.
- **Employees → Print QR cards** prints ID-sized cards (QR, name, employee no., division / unit) for the employees in the list, to attach to the back of their IDs.
- **Summary:** per employee over any date range, filtered by division and unit: ceremonies held, present, excused, absent and attendance %; printable and CSV. Only ceremonies whose check-in has closed count, and ceremonies before an employee was added don't count against them.
- **Employees:** add, edit, deactivate, reset PIN, or **Import list**: choose an **Excel file (.xlsx)** or CSV, or paste rows copied from Excel. Columns are matched by their titles in any order (employee no., last, first, middle, position, division, unit, employment type; a template can be downloaded). The whole list is checked first and every problem is listed (nothing is imported until it is fixed); then it is imported in batches of 100 with progress shown. *Skip employees already in the list* leaves existing employee numbers as they are, for re-importing an updated list; imported employees get random PINs listed once for printing. Division and unit are separate fields. **Division** is chosen from a list: HOSPITAL OPERATIONS AND PATIENT SUPPORT SERVICES, FINANCE SERVICE DIVISION, MEDICAL SERVICE DIVISION, NURSING SERVICE DIVISION and OMCC to start with (imports also accept short or older names like *Nursing*, *Administrative* or *Office of the Medical Center Chief*). **Unit** is typed, with suggestions (e.g. EMERGENCY ROOM). The summary, attendance lists, filters and CSV exports show division and unit in separate columns. Each employee can be tagged **Plantilla** or **Job Order** (JO): shown as a tag in the lists, filterable in the Employees list, a ceremony's attendance and the Summary, and included in CSV exports; *Import list* takes it as an optional 8th column (Plantilla / Permanent / Regular, or Job Order / JO). **Divisions & units** (Employees tab) renames a division or unit for every employee in it at once, adds or removes divisions (only empty ones can be removed), and merges two by renaming one to the other's name. Untick **Required to attend flag ceremonies** for employees who are excused by default (e.g. fixed night duty) so they are not counted absent.

GPS on a phone can be faked with special apps; the geofence, one-phone rule and optional selfie make cheating hard but not impossible, so spot checks at the venue are still worthwhile.

### Public services on/off
**Staff Panel → Settings → Public services** (Administrators) turns public services and their parts on or off: Request Records (and its *Digital copies* option), Book OPD Appointment, Track / Cancel (and *online cancellation*), Hospital Directory (and each section: departments list, schedules & hours, requirements, contact information, Find your way, maps), the FAQ assistant, the Referral Portal and Flag Ceremony check-in. A service that is off disappears from the menu, home page and footer; its page shows *Not available online right now* with an optional message; and the server refuses its online requests, so old links and bookmarks don't work either. Turning off a service also turns off its parts. The Staff Panel is never affected (existing requests and appointments can still be processed, and HR's QR scan still works when employee check-in is off). Everything is on by default; the list is in `src/modules.js`.

### Digital Wayfinding System
The Hospital Directory's **Find your way** section gives walking directions on the campus map. Visitors choose **From** (gates, the plaza, main buildings or any building) and **To** (a department, clinic or office linked to a building, or any building), optionally **Avoid stairs**, and tap **Show the way**: the map opens zoomed to the route (A → B, animated line) with numbered steps such as *Walk about 100 m, passing CENTRAL PLAZA, then turn right at the junction near NEW DIETARY BUILDING (Bldg. 7)*, plus the total distance and walking time. Directory cards linked to a building also get a **Directions** button. Routes are worked out in the visitor's browser (`public/js/wayfind.js`); they run along paths and never cut through a building or gate.

- **Campus map:** the *ZRMC Campus Map* is cropped from the **Master Development Plan 2025** (title block, signatures and lot description left out) and loaded once into a new database (`seed/campus-map.jpg`, `src/wayfinding-seed.js`): the 35 existing buildings in the plan's legend (nos. 1–30, with 4A, 5A, 5B, 10A, 20A and 22A; no. 25 is not on the drawing), the main and back gates, the central plaza, and a path network traced along the existing roads and walkways. The plan's proposed projects (nos. 31–42) and DPWH roads are not destinations. The Emergency Room and the OPD clinics are linked to their buildings. The plan is *not to scale*: distances use an estimated map width of 315 m (adjust it in the editor).
- **"You are here" QR signs:** each starting point gets an A5 sign with a QR code to `/directory?from=<point>`, which opens directions with that spot already chosen. Print them from the editor **on the live site**, so the QR codes carry its address.
- **Staff Panel → Directory → map → Wayfinding** (Administrators): drag points; **Add points** (each click adds a point joined to the selected one, to trace a road); **Connect** / **Delete**; set a point's name, type (gate, building, landmark or junction), building no., *starting point* and the directory places inside it; mark paths with stairs; set the map's real width or **Measure scale** between two known points; **Print signs**. Changes are saved together with **Save wayfinding**.

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

Each Staff user has access checkboxes: **Records Requests**, **OPD Appointments**, **Referrals** and **Flag Ceremony Attendance**. They need at least one. A Records-only user doesn't see the OPD tab, OPD dashboard numbers or OPD text messages, and the server refuses OPD requests from them; the same applies the other way round. Access changes take effect on the user's next click, without logging them out. Administrators always have both.

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
  idphotos.js     ID / selfie / receipt photos and the automatic ID check result
  modules.js      public services that can be turned on and off
  wayfinding.js   wayfinding: path network load/save, campus map seed (wayfinding-seed.js)
  flag.js         flag ceremony: settings, weekly ceremonies, geofence check, PIN helpers
  sms.js          SMS providers + logging
  messages.js     SMS templates
  routes/         public and admin JSON APIs
public/           HTML/CSS/JS front end (no build step); js/idmatch.js is shared with the server
test/             node:test API + reminder tests (set TEST_DATABASE_URL to run against a throwaway Postgres)
```

## Before going live
- Set a strong `ADMIN_PASSWORD` and a random `SESSION_SECRET`. Vercel serves HTTPS automatically. If you self-host, put the app behind nginx or Caddy for HTTPS.
- Backups: Supabase's paid plans include daily backups. On the free plan, export regularly (Supabase → Database → Backups, or `pg_dump`). Note that free Supabase projects pause after a week with no activity.
- Have your Data Protection Officer review the consent text in `public/js/common.js`, since the app handles health information under RA 10173.
- Each request form has a rate limit of 20 submissions per IP per 10 minutes (`SUBMIT_RATE_LIMIT`), and staff login 10 attempts (`LOGIN_RATE_LIMIT`). These are kept in memory per server instance, so on Vercel they are only a light safeguard.
