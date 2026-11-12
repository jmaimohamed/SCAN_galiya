# GALIA Control

Verification of finished-goods boxes of seat covers (« coiffes »):

1. the operator logs in and scans the box's main **GALIA** label: this **starts** the control;
2. the operator scans every seat-cover label; every distinct cover is recorded and counted honestly (conforming, wrong PN, already in another box, beyond the GALIA quantity, duplicate scans, invalid scans) — reaching the GALIA quantity never ends anything;
3. the operator **rescans the same GALIA** (or presses « Terminer le contrôle ») to **end** the control; the server recomputes everything and decides **OK** (strict) or **NOT OK**, and saves an immutable report;
4. ending requests the browser print dialog **once**: a landscape **OK** or **NOT OK** label is printed on the Zebra ZD421 **of that operator's PC** through `window.print()` and its installed Windows ZD421 driver (the operator confirms the dialog);
5. a NOT OK box can later be **recontrolled from zero** (rescan its GALIA → « OUI — Recommencer à zéro »): old assignments are released and audited, every cover is rescanned, and prior reports stay immutable.

Deployment: the application and PostgreSQL run on **one server PC**; several **operator PCs** open it through the server's LAN address. Each operator PC has its own DS2208 (USB) and its own ZD421 (USB). Each operator must select their own locally installed ZD421 in the browser dialog. The website cannot inspect or enforce that physical printer choice.

Everything is stored in PostgreSQL for traceability. The application verifies scanned **identities and quantities**; it cannot prove that a scanned item is physically inside the box.

Stack: Next.js 16 (App Router, route handlers) · TypeScript · Tailwind CSS 4 + shadcn/ui-style components · PostgreSQL + Prisma 6 · Zod · argon2id · Vitest.
UI language: French. One Next.js application, no other service.

---

## 1. Windows setup (exact commands)

All commands are run from **PowerShell** in the project folder (the path contains spaces — keep the quotes):

```powershell
cd "C:\Users\moham\OneDrive - ESPRIT\Bureau\LEAR Corporation\galia-control"
```

| Step | Command | Notes |
|---|---|---|
| 1. Dependencies | `npm install` | Node.js 20.12+ (tested with Node 24). Also runs `prisma generate`. |
| 2. Configuration | `if (!(Test-Path .env)) { Copy-Item .env.example .env }` then edit `.env` | `.env` is git-ignored. Already present on the development PC. |
| 3. Database | `npm run db:create` | Creates the database named in `DATABASE_URL` (`Scann`) **only if it is missing**. Never drops or alters anything. |
| 4. Migrations | `npm run db:migrate` | `prisma migrate deploy`: applies pending migrations only (non-destructive). `npm run db:status` shows the state. |
| 5. First administrator | `npm run create-admin` | Interactive; password typed twice, hidden, never printed or stored in a file. Run it in PowerShell/cmd/Windows Terminal (not Git Bash/mintty). |
| 6. Build | `npm run build` | Production build. |
| 7. Start | `npm start` → **port 3006** | Binds `0.0.0.0` (LAN). |
| 7b. Alternative port | `npm run start:3007` → **port 3007** | Use only if 3006 is taken. |

`npm run dev` (3006) / `npm run dev:3007` exist for development only; production use is `build` + `start`.

**Port policy.** Only 3006 (default) and 3007 (approved alternative) are used. Before starting, `scripts/check-port.mjs` checks the port; if 3006 is busy it stops with a message pointing to `npm run start:3007`. It never kills another process.

### Upgrading an existing installation (browser-print version)

Run on the server PC, in PowerShell, from the project folder:

```powershell
# 1. Stop the running server (Ctrl+C in its window), then back up the database (non-destructive)
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -h localhost -U postgres -d Scann -Fc -f "backups\Scann-$(Get-Date -Format yyyyMMdd-HHmm).dump"
# 2. Regenerate the client, apply pending migrations, build, start again
npx prisma generate
npm run db:migrate
npm run build
npm run start:3007        # or: npm start  (port 3006)
```

`db:migrate` only applies pending migrations; never use `migrate reset` on the main database. The `strict_counting` migration (honest counting) adds the `EXCESS` scan outcome, report quantity columns (legacy reports are backfilled as « counting version 1 » from their original accepted count, results unchanged), a stricter report guard and the per-workstation label orientation; it **clears existing label confirmations** because the label is now landscape: every workstation must print and measure a new TEST label. The `print_dialog` migration preserves legacy jobs and adds SVG/dialog jobs; `print_dialog_guards` strengthens snapshot immutability and clears legacy label confirmations, requiring a new measured TEST label per workstation. Existing migration files are not rewritten; the `correction_attempts` migration backfills existing boxes as attempt #1 and keeps every existing report unchanged. To build a new version for checking while the old server still runs, use a separate folder: `$env:GALIA_DIST_DIR=".next-qa"; npx next build` (then start that copy with the same variable on the other port).

### URLs

| Where the browser runs | URL | Notes |
|---|---|---|
| On the server PC itself | `http://localhost:3006` (or `:3007`) | Standard browser printing through this PC's Windows driver (see §6). |
| On another workstation (LAN) | `http://<server-name-or-IP>:3006` | Add that exact origin to `APP_TRUSTED_ORIGINS`. Standard printing works over LAN HTTP. HTTPS is recommended to protect credentials and session cookies. |

### `.env` reference

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection (`Scann`). Server-side only — never sent to the browser or logged. |
| `TEST_DATABASE_URL` | Separate database for automated integration tests; its name **must end with `_test`** (tests empty its tables). |
| `APP_TRUSTED_ORIGINS` | Comma-separated exact origins (`scheme://host:port`). Mutations must carry one of them in `Origin` (CSRF protection); requests for any other `Host` get **421**. Default: `http://localhost:3006,http://localhost:3007,http://127.0.0.1:3006,http://127.0.0.1:3007`. Example for LAN: add `http://GALIA-SRV:3006,http://192.168.1.20:3006` or your HTTPS origin. Restart after changing. |
| `SESSION_TTL_HOURS` / `SESSION_IDLE_MINUTES` | Absolute session lifetime (default 12 h) and idle timeout (default 120 min). |
| `SESSION_COOKIE_SECURE` | Force the `Secure` cookie flag. Default: `Secure` when the request origin is `https://`. |
| `LOGIN_MAX_FAILURES_PER_USER` / `_PER_IP` / `LOGIN_WINDOW_MINUTES` | Login rate limiting (defaults 5 / 20 / 15 min). |
| `PRISMA_LOG=error` | Optional Prisma error logging. |

---

## 2. Users and security

- Roles: **OPERATOR** (scan, finalize, NOT OK correction, authorized current-box print/reprint, duplicate/error details and local TEST label) and **ADMIN** (administration, unrestricted history, users, audited removal/reset and workstation settings); any authenticated operator can configure their workstation's label size. No public registration, no e-mail.
- User IDs are case-insensitive and stored upper-case (`op042` → `OP042`), 2–32 characters `A–Z 0–9 . _ -`. Passwords 8–128 characters, hashed with **argon2id** (`@node-rs/argon2`, 19 MiB / 2 iterations).
- Sessions are database-backed: the cookie `galia_session` holds a random 256-bit token (only its SHA-256 is stored), `HttpOnly`, `SameSite=Strict`, `Secure` under HTTPS. Each request re-checks expiry, idle time, revocation and that the user is still active — **disabling a user or changing their role/password ends their sessions immediately**.
- Every API route checks the session and role on the server; the operator identity always comes from the session, never from the request body.
- Login rate limiting is counted in the database (per user ID and per client address). Unknown user, disabled user and wrong password get the same answer.
- Users are never deleted (deactivation only), so history stays attributable. The last active admin cannot be disabled or demoted.
- Security headers (CSP, `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy`) are set in `proxy.ts`. The CSP restricts network connections to this application; only same-origin frames may load the saved label view.

---

## 3. Barcode formats (source of truth)

| Label | Format | Example | Parsed |
|---|---|---|---|
| Box (GALIA) | `P<PN>_Q<QTY>_S<BOX SERIAL>` | `PL002815593B96AG_Q20_S10428865` | PN `L002815593B96AG`, qty 20, box serial `10428865` |
| Seat cover | `<PN>_S<SERIAL>` | `L002815593B96AG_S70166592310` | PN `L002815593B96AG`, serial `70166592310` |

Rules (`lib/barcode.ts`):

- Whole payload matched by an anchored pattern; only surrounding transport CR/LF is removed; spaces and tabs are rejected. Case is never changed; nothing internal is removed; no fuzzy matching.
- Only the leading `P` field marker of the **box** label is removed. The first character of an item PN is kept.
- **PN**: `A–Z` and `0–9`, 3–40 characters. **Serials**: digits only, 4–30, kept as strings (leading zeros preserved). **Quantity**: digits, value 1–999. Whole scan ≤ 128 characters.
- A PN alone, a serial alone, a truncated code (`…_S`), extra fields, lower-case letters, spaces/control characters or other characters are rejected with a precise message (e.g. « Code incomplet : référence seule »). Characters typical of an AZERTY/QWERTY mismatch (`& é " ' ( è ç à °`) are reported as a keyboard-layout problem.
- These limits are constants in `lib/barcode.ts` and can be widened if real labels require it — check them first with the diagnostic page.
- Raw scans are stored bounded (160 characters + true length) and always rendered as text.

**Page « Diagnostic scan »** shows exactly what the scanner typed (visible escapes, character codes, parse result) without saving anything. Use it to validate the real scanner output before production.

---

## 4. Workflow rules

- **Opening a box**: the GALIA scan creates the box or loads it. The same serial never creates a second record; the same serial with a different PN or quantity is a **conflict** (nothing changed). A finalized box opens **read-only**.
- **One controller at a time**: opening a box gives the tab a *lease* (random token + session). Only the lease holder can scan, suspend or finalize — enforced on the server, so two tabs or workstations cannot both write. Another operator can take over with an explicit, audited « Reprendre le contrôle »; the previous tab is then refused.
- **Another GALIA scanned while a box is active** → dialog « Autre boîte scannée » (suspend and open the new one, or cancel). Never a silent switch. Scans typed while a dialog is open are captured and queued, never lost and never turned into a button press by the trailing Enter.
- **Start / end.** The GALIA scan starts the control and shows PN, box serial, expected quantity, « Pièces distinctes scannées », « Quantité conforme », non-conforming pieces and the current issues. Covers are collected until the operator **ends** the control. At 5/5 the page shows « Quantité cible atteinte : 5/5 — Rescanner la GALIA de cette boîte pour terminer » and keeps accepting scans; a 6th distinct cover is recorded and shown in red « DÉPASSEMENT — 6 pièces scannées pour 5 attendues ».
- **Ending** = rescanning the **exact same GALIA payload** while the control is open (or « Terminer le contrôle », same server path). Ending waits for every scan already received (ordered queue), then the server — under the box lock — recomputes all counts, decides OK / NOT OK, saves one immutable report + label snapshot, and the page requests the print dialog once. A **different** GALIA never ends or switches silently (explicit « Autre boîte scannée » dialog); the same box serial with another payload does not end the control either. Retries of an end request (same attempt) return the same report and the same print job.
- **Duplicate input events.** The same payload received again within **0.8 s** with nothing in between is one physical trigger delivered twice: it is suppressed and is not a mistake. The GALIA that just opened the box, received again within **2 s** of that opening scan, is ignored (so a double trigger cannot immediately close the new box); the same GALIA within 2 s after the end is ignored too. A deliberate later rescan ends the control.
- **Cover checks**, in one transaction with the box row locked: control open → lease → format → already seen in this box/attempt → exact PN → serial reserved by another box → GALIA quantity reached. Answers: « OK — Pièce conforme comptée », « FORMAT INVALIDE — non compté », « SCAN EN DOUBLE — déjà compté », « RÉFÉRENCE DIFFÉRENTE — pièce non conforme », « SÉRIE DÉJÀ UTILISÉE dans une autre boîte », « DÉPASSEMENT — pièce en excédent ».
- Only conforming covers within the GALIA quantity create an accepted item and **reserve** the serial (including in a NOT OK box). Excess, wrong-PN and other-box covers are recorded observations that reserve nothing: the other box keeps its reservation, and an excess serial stays free for its real box. Operators cannot remove or edit reservations. An explicitly confirmed, reasoned administrator void/reset releases the targeted assignment while retaining its original scan history; the released serial can then be scanned again.
- Every end creates a new immutable **report**; reports are never modified. The quantities the operator saw are only a precondition: if the server holds a scan the page has not shown yet, nothing is finalized (« le décompte a changé ») and the operator rescans the GALIA after checking.

### Counting rules (honest quantities)

A cover's identity is its serial. Per control attempt:

| Number | Meaning |
|---|---|
| Pièces distinctes scannées | conforming + non-conforming distinct covers |
| Quantité conforme | right PN and serial free: covers reserved in the current generation + excess covers |
| Non conformes | wrong PN + serial already used in another box |
| Manquant | max(0, expected − conforming) |
| Excédent | max(0, distinct − expected) (matching covers beyond the quantity are also counted as excess) |
| Scans en double / Formats invalides | tentatives (each recorded), never a quantity |

**OK** only if distinct = expected = reserved conforming covers, and there is no excess, missing, wrong PN, other-box serial, duplicate scan or invalid scan in this attempt. Not mistakes: the GALIA rescan that ends the control, a retried request (same idempotency key), a suppressed duplicate input event. Lease refusals and scans arriving after the end are recorded (not lost) but are not part of the tally. The database report guard recomputes these numbers from the recorded scans, so no code path can save an OK report over a recorded mistake. Mistakes are resolved only through the audited correction (or administrator) workflow — there is no « effacer les erreurs » button.

### Correction of a NOT OK box

A box has one stable identity (serial, PN, GALIA quantity, original GALIA payload) and numbered **attempts**: #1 = initial control, #2, #3… = corrections. Each finalized attempt has its own immutable report.

- Rescanning the GALIA of a **NOT OK** box offers **« OUI — Recommencer à zéro » / « NON — Annuler »**, showing the old report, quantity, issues and the number of cover assignments that will be released. Nothing changes before OUI. With NON the box stays NOT OK, its serials stay reserved and it accepts no cover.
- If the previous attempt recorded **excess, wrong-PN or other-box pieces**, they are physically in the box: the dialog lists their serials and OUI stays disabled until the operator ticks « J'ai retiré ces pièces de la boîte ». The server refuses the correction without that confirmation (`REMOVAL_CONFIRMATION_REQUIRED`), and the audit event stores the confirmed list.
- **OUI** atomically archives the previous active generation, voids its accepted assignments without deleting them, releases their serial reservations and opens a new generation of the **same box** at **0 / expected**. Example: an old 18/20 becomes **0/20**; all twenty covers must be scanned in the new control. A released serial can be accepted in this box or another box; once reassigned, it is globally reserved again. Scanning a cover twice in the fresh attempt is still a duplicate. The audit records the operator, timestamp, exact previous report, released count, reason and before/after generation/count. Old reports and labels stay unchanged.
- The confirmation includes the exact offered report ID. A delayed retry cannot restart a newer NOT OK result. Old leases, scan idempotency keys and finalization retries cannot resurrect voided contents. Requests from disabled, expired or revoked sessions cannot release contents. The database's narrowly scoped NOT OK capability is separate from admin permissions: it cannot reset an OK box, an open control or another target. Operators still have no general reset/delete endpoint.
- All rules still apply (exact PN, global serial uniqueness, format, server confirmation, single owner). Box identity can never change; conflicting GALIA metadata is blocked. Operators cannot remove accepted covers. The separate audited admin workflow below can void an assignment and invalidate the current result.
- Ending the correction (GALIA rescan or « Terminer le contrôle ») creates a new **OK** or **NOT OK** report; a NOT OK box can be corrected again later. An **OK** box is final: rescanning opens it read-only, no correction is offered.
- During a correction the page shows **« Recontrôle complet depuis zéro »** and the previous NOT OK report. Production printing, reprinting and reopening old production label URLs are blocked until a new valid result is finalized. Historical snapshots remain in the protected admin audit view. Remove all obsolete physical labels: software cannot recall them. Completed OK boxes remain read-only.

---

## 5. Zebra DS2208 scanner (USB HID keyboard)

The application needs no SDK, camera, WebUSB or WebSerial: the DS2208 types the barcode like a keyboard, followed by **Enter**.

Configure with Zebra's **official** documents for your exact model — the *DS2208 Quick Start Guide* and *DS2208 Product Reference Guide (PRG)* from zebra.com (or Zebra's 123Scan utility). The programming barcodes must be scanned from Zebra's documents; they are not reproduced here. Settings to apply:

1. Host type **USB Keyboard (HID)**.
2. Add an **Enter** suffix after each scan (the PRG's scan-data transmission / "Enter key" suffix option).
3. Keyboard layout: the scanner's **USB keyboard country type must match the Windows layout** of the workstation (e.g. French AZERTY). A US-QWERTY scanner on an AZERTY PC types `&é"'(` instead of digits and `°` instead of `_`. Alternatively use the PRG's keypad-emulation option if offered for your firmware.
4. Make sure Caps Lock cannot invert letters (PRG caps-lock options, or Caps Lock off).

Then **verify with real labels** on « Diagnostic scan »: the received text must be byte-for-byte the expected payload (digits, upper-case letters and `_`).

Behaviour in the app:

- Large scan field with « Prêt à scanner » while focused; when focus is elsewhere an amber overlay « Le curseur n'est pas dans le champ de scan » is shown. Focus is taken back only when it fell to the page itself — never from another input, the history search or an open dialog.
- The field is uncontrolled: on Enter the value is taken and cleared synchronously; an empty Enter is ignored, so a CR+LF suffix never submits twice.
- Every scan enters an **ordered queue** with its own idempotency key, sent one at a time. « En attente de confirmation » lists pending scans separately; **green appears only after the server's answer**. On network loss: amber « Non confirmé — connexion interrompue », automatic retry with the **same** key (never double-counted), nothing is accepted offline.
- « Prêt à scanner » means the field has the focus — it does **not** mean a scanner is connected (USB HID cannot report that).
- **The scanner's beep only means "barcode decoded"**; the application's result is the coloured panel (and the optional sounds, enabled by « Sons » after a click or key press).

---

## 6. Windows ZD421 driver and standard browser printing

The server runs Next.js + PostgreSQL and stores immutable SVG labels. Each operator PC opens the server's LAN URL and prints through its **own browser dialog and Windows driver**. There is no printer discovery, silent selection, raw command dispatch, server USB printing or printing bridge. **No Zebra Browser Print installation is required.**

### Configure each operator PC

1. Install the official Windows **ZDesigner driver for the exact ZD421 model**, then connect and power on that PC's printer. Verify it appears in Windows Printers & scanners.
2. Measure the stock: **width = roll width across the printhead** (plant roll: **110 mm**; the ZD421 prints at most 104 mm, the application keeps all content inside that band), **length = one label along the feed** (plant labels: **210 mm**). In the Windows driver's printing preferences (ZDesigner → Options d'impression → Papier), create/select that paper size **width × height = 110 × 210 mm** (the roll as it sits in the printer), 203 dpi; match the media type (gap / black mark) and direct-thermal/thermal-transfer method; calibrate if labels drift. If the driver refuses a width above 104 mm, use **104** in the driver **and** in the application. Do not enable any other rotation.
3. Open `http://<server-IP>:3006` (or explicit alternative `:3007`). Add that exact origin to `APP_TRUSTED_ORIGINS` on the server and restart. Only the app port needs LAN access; PostgreSQL can remain local to the server. HTTPS is recommended for login/session confidentiality.
4. Log in and open **Étiquette de ce poste**. Enter a workstation name, then click **« Utiliser le rouleau 110 × 210 mm — plein format »** (or enter the actual measured dimensions). Use **« Paysage plein format — page au format du rouleau »** (ROTATE_90, default). The page stays **110 × 210 mm Portrait**, exactly matching the driver stock; the SVG turns the reading content once, so the label is still read horizontally along its 210 mm length. Save; the page shows the TEST preview.
5. Click **Imprimer une étiquette TEST**. In the browser dialog: **the ZD421 of this PC**; « Plus de paramètres » → **Taille du papier 110 × 210 mm** (the driver format); **Portrait**, **1 copy**, **scale 100 % / actual size** (never « Ajuster » or automatic reduction), **margins none**, **headers/footers off**, background graphics on. No driver landscape/90° rotation. If the label looks small in a corner, check these settings before confirming; increasing the application's paper dimensions while keeping the same stock will not fix scaling.
6. Check the TEST label (« TEST — NE PAS UTILISER »): exactly **one** label comes out (no blank label after it); held horizontally, the **« HAUT » arrow is at the top** and the text reads normally (upside down → tick « Rotation 180° » in the driver); the content **fills the label**; the **edge guide** (1 mm inside the printed band) and the **margin guide** are complete; the **50 mm bar** measures 50 mm; text and accents are sharp; its QR reads `TEST_NE_PAS_UTILISER`. A stock too small for the worst-case OK/NOT OK layouts is refused with a layout message instead of clipping.
7. Only after physically checking the label, tick the confirmation checkbox and confirm. This records **the operator's declaration**, not an automatic test of the printer or paper. A size or orientation change clears confirmation.
8. End a sample OK control and scan its QR: it must return the **exact original GALIA**, e.g. `PL002815593B96AG_Q20_S10428865`.

### Orientation: rotate exactly once

- **Paysage plein format — page au format du rouleau (ROTATE_90, default).** Portrait page **width × length = 110 × 210 mm**; horizontal reading content **210 × 110 mm** turned 90° once inside the saved SVG. Keep driver and browser in Portrait, without another 90° rotation. The page dimensions and stock dimensions agree, avoiding the previous landscape-page/portrait-roll mismatch.
- **Paysage — rotation par le pilote (LANDSCAPE, legacy alternative).** Landscape page **length × width = 210 × 110 mm**, no rotation inside the SVG; relies on driver/browser landscape handling. Still available explicitly, and historical jobs retain their original orientation and dimensions.
- **Portrait (NONE).** Portrait page and content.
- Never combine rotations (driver « Paysage »/rotation + application rotation). Keep the measured paper dimensions identical in the application, driver and browser. Browser date, page title, URL or page number on the label means **headers/footers are still enabled**. These browser options cannot be forced or verified by the website.
- Layout: 1 SVG unit = 1 dot at 203 dpi (8 dots/mm); **1.5 mm safe margin**, plus the unprinted strip when stock exceeds the 104 mm head ((110 − 104) / 2 = 3 mm each side). The production layout uses **207 × 101 mm** of a 210 × 110 mm reading frame. Typical OK result font ≈ 26 mm, PN ≈ 10.5 mm, box serial ≈ 13 mm and quantity digits ≈ 17 mm; actual capital ink height is smaller than font size. Longer fields/more issues shrink or wrap safely. TEST has its own large two-line banner. QR data and four-module quiet zones are unchanged; no text, module or history is stretched, truncated or clipped.
- Stock limits now allow **50–112 mm width and 50–991 mm length**, consistently in forms, API and database. These follow the [ZD421 thermal-transfer specifications](https://www.zebra.com/content/dam/zebra_dam/en/tech-specs/zd421-tech-specs-en-us.pdf); confirm your exact model's media support (direct thermal can have a narrower media limit). The 203 dpi head still prints only **104 mm**. Wider software settings cannot make the head print to the edge of a 110 mm roll. Use the actual stock size, not the maximum. Layout tests include 112 × 400 and 112 × 991 mm.

Settings belong to a random workstation ID in this browser's local storage, with a separate profile in PostgreSQL. Another PC/browser/profile has its own settings; clearing browser data requires setup again. No default physical printer is selected by the website. Windows/browser printer preferences belong to each operator PC.

### Longer stock and top/centre/bottom placement

Measure one label, from gap to gap: the current roll may be **110 × 400 mm**, rather than 110 × 210. New browser profiles offer 110 × 400 by default; existing saved dimensions are preserved. Both stock presets remain available and the numeric length stays editable up to the supported hardware limit. Choose **« Utiliser le rouleau 110 × 400 mm — plein format »** only if that matches the measured paper. Set the same **110 × 400 mm** paper in the Windows driver and browser, **Portrait, 100% actual size, no margins, no browser headers/footers**. A 210 mm application page on a 400 mm physical label leaves almost half the paper unused; changing font size alone will not fix that mismatch.

**« Utiliser toute la longueur du papier »** is the default: the layout uses the full measured sheet. To place a shorter block, uncheck it, enter the **length of the print area**, and choose **En haut / Au centre / En bas**. These positions are along the physical paper's feed direction, regardless of the text's reading rotation. For example, a 210 mm area on 400 mm stock starts at 0 / 95 / 190 mm before safe margins. Text and QR modules keep their real size; only their position changes. The preview shows both the reading layout and the **complete physical sheet**, including intentionally blank paper. Save changes before viewing/printing the new preview. Changing the area/position clears that workstation's confirmation; print a new TEST, measure the 50 mm bar and confirm its position. Historical SVG jobs retain their saved coordinates and hash.

On long reading frames (length at least three times the roll width), the result uses a **full-height left column**, with operator/identity/quantities/issues on the right. This uses the longer stock for larger readable text instead of merely widening shallow boxes. A typical 110 × 400 mm OK label has an OK font above 50 mm; NOT OK above 30 mm, with no QR. Smaller print areas keep the existing stacked layout. All content still passes bounds/overlap validation, including long identifiers, all issues, reprints and the unchanged QR quiet zone.

### Loading and browser restrictions

Printing loads an authorized same-origin frame, avoiding new popup windows and their popup blockers. It waits for fonts, the saved SVG image to decode, and a layout frame before requesting `window.print()`. A missing/expired session, blocked report, failed image or load timeout refuses the request and displays an error. Never treat the absence of an error as proof of output.

**Automatic print at the end of a control.** Ending a control (GALIA rescan or « Terminer le contrôle ») commits the report first; the same request then prepares one ORIGINAL print job (idempotency key derived from the report, so retries return the same job) and the page requests the print dialog **once** — the operator still chooses the printer and confirms. The claim « one automatic dialog per report » is kept in memory and in the tab's sessionStorage: refresh, rerender, React Strict Mode, retries, duplicate events and history navigation never open a second automatic dialog. If the dialog cannot be opened (label not prepared, load error) or `print()` returns at once (Chrome/Edge keep it blocked while their dialog is open, so an immediate return usually means the dialog was blocked), the result card shows a prominent **« Imprimer maintenant »** for the same saved label; once a dialog was shown, further labels go through « Réimprimer… » (reason, RÉIMPRESSION). A print problem never cancels, changes or rolls back the finalized report. If the label size of the workstation is not confirmed, the report is saved and the card explains why no label was prepared.

The website cannot detect the selected printer, a canceled dialog, unplugged USB, paper-out or actual physical printing. Check the printer/Windows queue and physical label yourself. There is no automatic resend.

---

## 7. Saved labels (black on white)

The server builds labels from **one immutable finalized report** using `lib/zpl/*` (historical directory name; only SVG is generated). Physical dimensions are in millimetres; geometry is validated for bounds and overlap. Display text is XML-escaped, and saved SVG is displayed as an image rather than executable inline markup.

Full-label landscape template `galia-label-v4-full`, black on white, in this order: header (result + operator), PN + box serial, expected vs scanned, conforming / non-conforming, issue summary, OK QR, finalization time + reprint marker.

| Label | Exact contents |
|---|---|
| **OK** | Large framed **OK**; finalizing operator top-right; PN; N° BOÎTE; cells ATTENDU / SCANNÉ (distinct) / CONFORME / NON CONFORME; « CONFORME — Quantité et références vérifiées »; QR encoding **exactly** the original GALIA payload (no URL, no report reference); « Fin du contrôle : date heure (Tunis) ». |
| **NOT OK** | Large reversed **NOT OK**; operator top-right; PN; N° BOÎTE; the same four quantity cells; one line per issue, all at the same size: « MANQUANT : 1 pièce », « EXCÉDENT : 1 pièce », « RÉFÉRENCE DIFFÉRENTE : 1 pièce », « SÉRIE DÉJÀ UTILISÉE : 1 pièce », « SCAN EN DOUBLE : 1 tentative », « FORMAT INVALIDE : 1 tentative »; finalization time. **No QR and no barcode**, no individual cover serials. |
| **TEST** | Large **TEST**, **— NE PAS UTILISER** beneath it, « HAUT » reading arrow, edge (1 mm inside printhead band) and safe-margin (1.5 mm) guides, workstation, stock dimensions, page orientation, accented sample text, template version, exact 50 mm bar and a non-production TEST QR. |
| **Reprint** | Same saved report content with a reversed **RÉIMPRESSION** marker; the original finalizing operator stays top-right. Reprint operator, time and reason remain in audit history. |

Every number and line comes from the immutable report (never recomputed from current data). Long identifiers and several issues wrap or shrink, never truncate; content that cannot fit raises a layout error. OK is allowed only when the stored result is OK and the stored counts are strictly OK. Only the latest report can produce a label; correction in progress blocks production printing. Loading an older saved job URL also rechecks these restrictions. Existing historical snapshots are preserved unchanged.

The separate A4 report remains available for consultation. Its explicit print action also checks correction/supersession restrictions and is audited; it is not a thermal production label.

---

## 8. Print requests and duplicate protection

New requests use method **PRINT_DIALOG** and final status **DIALOG_REQUESTED**: an **unconfirmed request**, not proof that a dialog appeared, a particular printer was selected or paper printed. Historical direct-print jobs retain their old methods/statuses/payloads for audit only; no dispatch/result endpoints remain.

1. An explicit label click creates an idempotent job and stores the exact server-generated SVG, SHA-256, report, workstation, size, operator and template version. Database guards keep this snapshot immutable.
2. Double clicks/network retries reuse the logical request key. Concurrent original requests are serialized: at most one original label job per report. The browser guards repeated frame load events and concurrent dialog requests.
3. Printing runs only from explicit actions: ending a control (one automatic dialog per report, see §6), « Imprimer maintenant » after a blocked dialog, « Imprimer l'étiquette », « Réimprimer… ». Mount, rerender, Strict Mode, refresh, navigation and repeated API responses never print. The label page itself does not call print.
4. After a production request, use **Réimprimer…** for another label, including a canceled dialog, wrong selected printer or failed label loading. Check physical output first, provide a reason and confirm the reprint; it is audited and marked **RÉIMPRESSION**. A reprint can create a physical duplicate.
5. `window.print()` and `afterprint` never upgrade the job to physical success. Printing issues never alter the verification result.

---

## 9. Data integrity and concurrency strategy

- **Attempts** (migration `correction_attempts`): `ControlAttempt` rows (#1 INITIAL, #2… CORRECTION), `Box.activeAttemptId` = the open attempt, items/scans linked to the attempt that produced them, `Report.attemptId` unique (one immutable report per finalized attempt, several per box). Existing data was backfilled as attempt #1 (reports keep their original counts).
- **Honest counting** (migration `strict_counting`): scan outcome `EXCESS` (matching cover beyond the GALIA quantity, never reserved); report columns `distinctQty`, `conformingQty`, `nonconformingQty`, `wrongPartNumberQty`, `otherBoxQty`, `excessQty`, `extraQty`, `missingQty`, `duplicateAttempts`, `invalidAttempts`, `countingVersion` (1 = legacy, backfilled from the original accepted count; 2 = new) and `endTrigger` (`GALIA_RESCAN` / `MANUAL`). CHECK constraints enforce the arithmetic and that a v2 OK has every count clean; the report insert trigger **recomputes** the counts from the attempt's recorded scans and the box reservations and refuses any mismatch, so even a direct database insert cannot record OK over a mistake. The accepted-item guard still refuses any reservation beyond the GALIA quantity.
- **Row lock per box**: every mutation of a box (scan, end, suspend, takeover, opening a correction) runs in a transaction that first does `SELECT … FOR UPDATE` on the box row — two workstations can never open or run the same correction at the same time. Scans of one box are therefore serialized: two scans at 19/20 cannot both be reserved (the other is recorded as excess), and an end request cannot interleave with a scan: either the scan commits first (the end request sees counts it was not shown and changes nothing) or the end commits first (the scan is recorded as « contrôle déjà terminé », visible to the operator, never silently dropped).
- **Global unique constraint on accepted serials**: two workstations scanning the same item into two boxes hold different locks; both may try to insert, PostgreSQL's unique index lets exactly one commit, the other transaction is retried and classified « Déjà scannée dans une autre boîte ».
- **Idempotency**: each logical scan has a client key (unique index). A retry with the same key returns the stored result (re-checked under the lock for concurrent retries); the same key with a different payload or user is rejected (409). A new physical scan of an accepted serial gets a new key → duplicate. Print jobs use the same mechanism.
- **Database guards** (migrations `integrity_guards` + `correction_attempts`): CHECK constraints (quantity range, digits-only serials, `OK ⇒ accepted = expected and no issue`, …); a trigger re-locks the box on each accepted-item insert and refuses closed boxes, items outside the open attempt, PN mismatch and overfill even outside the application; accepted-item contents, scan attempts, reports and audit events remain immutable; accepted items support only a one-way reasoned void by an administrator or the narrowly scoped confirmed NOT OK restart; a closed OK box is read-only; a closed NOT OK box can only be reopened through a new correction attempt; an attempt can only be closed together with its report; stable box IDs, attempts, users and print jobs cannot be physically deleted; an explicit administrator reset is required before changing current GALIA identity; historical generations retain their identity snapshots; print-job payloads are immutable.
- Timestamps are `timestamptz` (UTC) and displayed in **Africa/Tunis**.
- Audit trail: logins, box creation/conflict/suspend/takeover/finalize, unconfirmed print-dialog requests, A4 requests, user and workstation-label changes.

---

## 10. Tests

```powershell
npm run typecheck           # TypeScript
npm run lint                # ESLint (next/core-web-vitals + typescript)
npm test                    # unit tests (no database)
npm run db:create:test      # once: creates Scann_test (separate database)
npm run db:migrate:test     # applies migrations to Scann_test
npm run test:integration    # PostgreSQL integration tests (empty Scann_test tables; refuse any DB not ending in _test)
npm run build               # production build
```

Coverage includes parsing and CR/LF handling, exact PN, global duplicate prevention, scan idempotency, ownership and quantity races, correction attempts, authentication/CSRF/roles, immutable reports/snapshots, SVG escaping and layout bounds, exact GALIA QR matrix/path, NOT OK without QR/barcode, per-browser label sizes, print idempotency, explicit browser actions, readiness/error handling and superseded-report restrictions.

`tests/integration/acceptance.test.ts` runs the 20 acceptance scenarios of the start/end control through the real route handlers (start, target reached without closing, end by GALIA rescan with one print request and idempotent retry, 6/5 excess, missing, wrong PN, other-box serial, duplicate, invalid, retried request, other GALIA, stale view, end/scan race, audited correction, OK QR = GALIA, NOT OK without QR/barcode, label quantities, landscape page = stock, blocked print keeps the report, two workstations). Browser-side parts are unit-tested: `scan-guards.test.ts` (echo guards, other GALIA, queue order), `auto-print.test.ts` (one automatic dialog per report across refresh/retries), `label-print.test.ts` (blocked-dialog detection, « Imprimer maintenant »), `counting.test.ts`, `label.test.ts` (landscape layout, rotation once, all tested stock sizes).

---

## 11. Physical acceptance checklist (manual, not performed by automated tests)

- [ ] Verify the real DS2208 payload with the actual Windows keyboard layout, Caps Lock settings and CR/LF suffix; scan 20 covers quickly and check ordered counts/focus.
**ZD421 physical validation (203 dpi, landscape, rotate once)** — none of these were performed by the automated tests:

- [ ] Driver: ZDesigner ZD421 (203 dpi), paper **110 × 210 mm** (or 104 × 210 if 110 is refused — then 104 in the app too), correct media type, calibrated, no extra rotation.
- [ ] Application: 110 (or 104) × 210, « Paysage plein format — page au format du rouleau »; driver and dialog: same physical paper size, **Portrait**, no extra 90° rotation, **100 % / actual size**, no margins, no headers/footers, 1 copy; the preview shows the label **full size**, not in a corner.
- [ ] TEST label: exactly one label out and **no blank label after it**; held horizontally the « HAUT » arrow is at the top and the text reads normally (else « Rotation 180° » in the driver); the content fills the label; both guides complete; the bar measures **50 mm**; accents sharp; TEST QR reads `TEST_NE_PAS_UTILISER`. Then confirm on the page.
- [ ] OK label: very large OK, operator top-right, PN, box serial, ATTENDU / SCANNÉ / CONFORME / NON CONFORME, « CONFORME — … », Tunis time; nothing clipped; the QR is square (not stretched) and decodes with the DS2208 to the **exact** GALIA payload.
- [ ] NOT OK labels for 6/5, 4/5, wrong PN, duplicate and invalid scans: each issue line present and readable, quantities correct, **no QR / barcode**, nothing clipped.
- [ ] RÉIMPRESSION marker visible on a reprint; original operator unchanged.
- [ ] End a control by GALIA rescan: the dialog appears **once**; cancel it → the report stays (result card), « Imprimer maintenant » / « Réimprimer… » work; refresh the page → no new dialog.
- [ ] Block printing in the browser (site setting / policy) → the card shows « Imprimer maintenant »; the report is unchanged.
- [ ] Print speed/darkness give a crisp QR and text at the chosen speed (adjust darkness in the driver, not the app).
- [ ] Cancel the print dialog, disconnect USB, turn off the printer and exhaust media: the app retains DIALOG_REQUESTED without claiming physical success. Inspect output/queue before an explicit reasoned RÉIMPRESSION.
- [ ] Verify failed loading/session expiry produces a clear error with no label request to print; browser restrictions are resolved manually.
- [ ] Double-click, refresh, navigate away/back and test a blocked browser: no automatic repeat printing.
- [ ] Two PCs open the LAN URL; each saves its own label settings and selects its own local ZD421. Clearing A's browser data requires setup on A and leaves B unchanged.
- [ ] NOT OK 18/20 on A → rescan on B → NO unchanged; YES starts **0/20** in a new generation under exclusive ownership, preserving and voiding the old assignments. During recontrol, new and previously saved production label views and A4 print actions are blocked.
- [ ] Rescan all twenty covers on B → OK 20/20; duplicates/wrong PN remain rejected. Reassign one released serial to another box: it must be refused in B. Print the new OK label and physically replace the old NOT OK label. Earlier reports/jobs stay unchanged; old leases/retries cannot restore contents. Completed OK stays read-only.
- [ ] Measure the actual roll (110 × 400 if confirmed), select identical paper dimensions in app/driver/browser, and validate full-paper mode plus a shorter area at top/centre/bottom. Each produces one sheet, a 50 mm bar and a readable square QR.
- [ ] Verify an incomplete correction produces another NOT OK report with its new accepted count and remains correctable.

## 12. Assumptions

- The supplied text formats are authoritative; PN charset `A–Z0–9` (3–40), digits-only serials (4–30), quantity 1–999 — adjust `lib/barcode.ts` if real labels differ (verify first on the diagnostic page).
- Any authenticated operator may take over an in-progress box (audited), open a correction of a NOT OK box (audited), view operators of earlier scans, request a reprint (reason + confirmation, audited) and set up the printer of their own workstation (audited, per workstation).
- After a correction, the previous reports are kept for traceability but are no longer printable (to avoid printing an outdated result).
- A reprint label carries the same content as the original plus « RÉIMPRESSION »; reprint operator/time/reason are kept in the database (not printed), per the label-content rules.
- On an OK label, ATTENDU = SCANNÉ = CONFORME (strict OK); NON CONFORME = 0.
- A cover's identity is its serial (serials are globally unique, as the reservation model already assumed): the same serial seen twice in one control is a duplicate scan, whatever PN it carries.
- During a correction, covers already counted stay counted; scanning one again is recorded as a duplicate scan (scan only the added covers).
- Duplicate-input windows: 0.8 s for any identical consecutive payload, 2 s for the GALIA echo after opening/ending (constants in `lib/client/scan-guards.ts`).
- Workstation identification uses a random id in the browser's local storage; clearing browser data means configuring the label size again; select the local printer in every print dialog.
- `cacheComponents` (from the scaffold) is disabled: every page reads the session at request time.

## 13. Project layout

```
app/                 pages (login, controle, historique, imprimante, admin/utilisateurs, diagnostic, rapport/[id], etiquette/[jobId]) + api/ route handlers
components/          UI (control page, scan input, print panel, history drawer, printer settings, shadcn-style ui/)
lib/barcode.ts       GALIA parsing (shared)          lib/zpl/        layout model and SVG renderer (historical directory name)
lib/server/          auth, sessions, services (boxes, printing, administration, dashboard, presence, history, users), HTTP helpers
lib/client/          scan queue, API client, explicit frame print helper, sounds
prisma/              schema + non-destructive migrations (integrity, corrections, printing, administration)
scripts/             db-create, db-migrate-test, create-admin, check-port
tests/unit, tests/integration
```


## 14. Administration, serial release and presence

Open **Administration** (`/admin`) as ADMIN. Server page guards and API authorization protect the entire area; an OPERATOR cannot access the dashboard, unrestricted box/history details, user management, audit snapshots or administrative mutations by calling their URLs directly. An operator accesses a current box by scanning its main GALIA (and sees necessary duplicate/error origins). Authorized label actions remain available in the read-only finalized-box dialog; a NOT OK box still asks OUI/NON before opening a correction.

### Remove one accepted coiffe

In the admin box detail, select **Retirer cette coiffe…**. The dialog shows PN, serial, source box, status and active count. Enter an administrative reason and the exact coiffe serial to confirm. The item is **voided**, never physically deleted; its active serial reservation is released. Any current finalized result becomes invalid and the box is **À recontrôler**. Current quantity is recomputed from active assignments. Reports, previous counts and saved label SVG/hash remain unchanged. After recontrol, only a new server-computed finalization can permit another production label.

For an open control/correction, the operator retains the current lease and sees the updated quantity through polling. Finalization checks the displayed quantity again under the same box lock; it never silently finalizes against a stale count.

### Réinitialiser le contrôle

The confirmation shows the box PN, serial, generation, current state and exact number of active coiffes to release. Enter a reason and type the **box serial**. The server also checks the generation and quantity seen in that dialog; if they changed, refresh and review the confirmation again.

One transaction voids that generation and its accepted assignments, releases only reservations pointing to those items, revokes ownership/leases, invalidates the current result and creates the next generation of the **same stable box ID**. Scanning the same main GALIA then starts at **zero**. Old requests/leases cannot restore voided assignments; a released serial already assigned elsewhere is never released again by resetting its original box.

**Retirer physiquement toutes les anciennes étiquettes de la boîte.** Previous labels may still exist; the website cannot recall them. New print requests/reprints and loading previous production-label URLs are blocked after invalidation/reset. Admins can inspect unchanged report/label snapshots only in the protected audit views, clearly marked as audit copies.

**Corriger la GALIA…** is an explicit identity-edit-and-reset workflow: a complete replacement GALIA is validated, all current assignments are released after confirmation, and the old generation identity/report snapshots remain unchanged. A serial identifying another box is refused. **Modifier la note** edits only a nonverification note. There is no manual OK switch, arbitrary accepted-item editor, report/audit editor or history-erasing delete action.

Users are deactivated instead of deleted. Create, role/active-state changes, display-name changes, password resets, box mutations and central label-setting edits require a reason and store the authenticated admin, timestamp, target and relevant before/after values. Passwords, password hashes and raw session tokens are never included in mutation audit details. The last active administrator is protected by transaction serialization and a database trigger, including concurrent changes.

### Dashboard definitions and pagination

Current-state cards count **distinct stable boxes**, using the current valid report pointer. A correction/reprint is not another box. Completed = current OK + current NOT OK. À recontrôler is a separate current state after administrative invalidation or a zero-based NOT OK restart, until a fresh result is finalized; untouched open initial controls are in progress. Archived generations have their own card/list and do not inflate current totals. Cards open their matching detail lists.

Filters: inclusive plant dates (Africa/Tunis), operator, PN prefix and state. Completed metrics use the **latest valid finalization date**; open/recontrol states use the current generation start date. Archives use the void timestamp and, for the operator filter, the actor who archived the generation (administrator reset or operator-confirmed NOT OK restart). Box, coiffe, attempt/generation, audit/rejection, print-job, workstation and presence lists use bounded PostgreSQL queries and server-side pagination (25 rows).

### Live presence and tab reconciliation

Authenticated browser heartbeats are sent every **20 seconds** with a distinct tab ID. En ligne = a nonexpired, nonrevoked session of an enabled operator with a heartbeat newer than **75 seconds** and user interaction newer than **2 minutes**. Inactif = heartbeats still arrive but interaction is older. Expired heartbeat = offline. Historical presence is shown for at most 24 hours; old login records never establish presence. Tabs are grouped per operator/workstation, so one tab closing does not take another tab offline. Active box names are verified against server ownership. No external service is used.

Admin dashboards refresh every 15 seconds while visible. Operator control and finalized-result views reconcile with server state every **3 seconds**; they refresh counts and warn when a generation/lease/result changes. All writes and label loads still check the authoritative server state even before the next poll or while a browser is disconnected.

### Deploy this migration

Back up the main database and stop the existing application before deployment. Preserve `.env`.

```powershell
Set-Location -LiteralPath "C:\Users\moham\OneDrive - ESPRIT\Bureau\LEAR Corporation\galia-control"
npm.cmd run db:status
npm.cmd run db:migrate        # applies pending migrations; NEVER reset the production DB
npm.cmd run build             # includes prisma generate; stop old Node processes to release its Windows DLL
npm.cmd start                # LAN port 3006
# Explicit alternative: npm.cmd run start:3007
```

`20261113090000_administration` backfills existing controls as generation 1 and creates active reservations from their accepted items without removing history. Existing finalized reports are linked as the current valid result. `20261114090000_strict_counting` adds the honest-counting columns and guard (legacy reports keep their result and are marked counting version 1) and the label orientation. A control left open across that upgrade is ended under the new rules (its legacy « quantité atteinte » refusals count as excess). `20261115090000_landscape_page` introduced the landscape-page orientation and widened stock dimensions to 110 × 300 mm.

**New: `20261116090000_roll_size_labels`** widens stock dimensions to 112 × 991 mm and makes ROTATE_90 the default: roll-size portrait page, horizontal reading content rotated once inside the SVG. It changes existing LANDSCAPE profiles to ROTATE_90, preserves explicitly chosen NONE/ROTATE_90 modes, and **clears all workstation label confirmations** for the larger v5 template. Each operator must print and measure a fresh TEST label before production printing. Reports and saved print jobs (including legacy v4 orientation, dimensions, SVG and hashes) stay unchanged. All earlier migration files remain unchanged. Development verification applies migrations only to the isolated `_test` database; check the actual main database migration status before deploying.

Stop the running GALIA server before `npm.cmd run build`: Windows keeps the Prisma engine DLL locked while the old application uses it, causing EPERM during `prisma generate`. Stop that application gracefully (Ctrl+C in its terminal), keep PostgreSQL running, back up the database, run `npm.cmd run db:migrate`, `npm.cmd run build`, then `npm.cmd start` (or `npm.cmd run start:3007`). Do not delete `node_modules` or reset the database to work around the DLL lock.

**`20261117090000_zero_restart_and_placement`** adds per-workstation print-area length and position, clears TEST confirmations, and adds the narrowly scoped, authenticated database guards for confirmed NOT OK restarts from zero. It never resets existing controls automatically, rewrites reports, releases serials on a mere GALIA rescan or changes saved print snapshots. Old generation records are voided only after the operator confirms the exact current NOT OK report. Apply it with `npm.cmd run db:migrate` after stopping the app/backing up, regenerate Prisma Client and build, then restart. Every workstation measures/confirms its selected paper and print area again.

The test runner requires `TEST_DATABASE_URL` to name a database ending in `_test`. If the configured value is `Scann_testc`, it will deliberately refuse it; use a separate name such as `Scannc_test`. Do not bypass this guard or point integration tests at the main database. No credentials belong in logs or documentation.

Manual acceptance: use an ADMIN and two OPERATOR browser tabs/PCs; void a coiffe and reset each box state, observe quantity/lease reconciliation, reuse released serials, recontrol and replace obsolete physical labels. Verify dashboard filters/pagination and presence through idle, closing one tab, expiry and logout. Check the real local ZD421 dialog/stock/QR as described above; automated tests cannot confirm physical printing.
