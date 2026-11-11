# GALIA Control

Verification of finished-goods boxes of seat covers (« coiffes »):

1. the operator logs in, scans the box's main **GALIA** label, then every seat-cover label;
2. the server accepts each cover only if its PN equals the box PN, its serial was never accepted before, and the box quantity is not exceeded;
3. the operator finalizes (« Terminer le contrôle »); the server computes **OK** or **NON OK** from the stored records;
4. an **OK** or **NOT OK** label is printed on the Zebra ZD421 **of that operator's PC** through the browser print dialog (`window.print()`) and its installed Windows ZD421 driver;
5. a NOT OK box can later be **reopened for correction** (rescan its GALIA → « OUI — Corriger ») to add the missing covers.

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

`db:migrate` only applies pending migrations; never use `migrate reset` on the main database. The `print_dialog` migration preserves legacy jobs and adds SVG/dialog jobs; `print_dialog_guards` strengthens snapshot immutability and clears legacy label confirmations, requiring a new measured TEST label per workstation. Existing migration files are not rewritten; the `correction_attempts` migration backfills existing boxes as attempt #1 and keeps every existing report unchanged. To build a new version for checking while the old server still runs, use a separate folder: `$env:GALIA_DIST_DIR=".next-qa"; npx next build` (then start that copy with the same variable on the other port).

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
- **Item checks**, in one transaction with the box row locked: box in progress → lease → format → exact PN → global serial uniqueness → remaining quantity. Results: « OK — Pièce acceptée », « NON OK — Référence différente », « Déjà scannée dans cette boîte », « Déjà scannée dans une autre boîte » (with that box, time and operator), « Format invalide », « Quantité prévue déjà atteinte ».
- Only active accepted assignments reserve a serial globally, including in a NOT OK box. Operators cannot remove or edit them. An explicitly confirmed, reasoned administrator void/reset releases the targeted assignment while retaining its original scan history; a reused serial can have only one new active assignment.
- **Finalization** (« Terminer le contrôle ») is enabled only when no scan is pending. At full quantity a confirmation is asked; below it, a **reason is required** and the result is NON OK. The server recomputes the result from stored rows; the count the operator saw is only a precondition (if it differs, nothing is finalized). Every finalization creates a new immutable **report**; reports are never modified.

### Correction of a NOT OK box

A box has one stable identity (serial, PN, GALIA quantity, original GALIA payload) and numbered **attempts**: #1 = initial control, #2, #3… = corrections. Each finalized attempt has its own immutable report.

- Rescanning the GALIA of a **NOT OK** box shows: « Cette boîte a déjà été contrôlée NOT OK. Quantité attendue : 20. Quantité acceptée : 18. Voulez-vous reprendre le contrôle pour corriger cette boîte ? » — **OUI — Corriger** / **NON — Annuler**. Nothing changes before OUI. With NON the box stays NOT OK and accepts no cover.
- **OUI** opens correction #n (audited: operator, time, previous result/report, attempt number), takes exclusive ownership and **resumes at the existing count** (e.g. 18/20). Previously accepted covers are kept, never rescanned, never counted twice.
- All rules still apply (exact PN, global serial uniqueness, format, no overflow, server confirmation, single owner). An already-accepted cover → « Déjà scannée dans cette boîte »; a cover of another box → « Déjà scannée dans une autre boîte »; wrong PN → expected vs scanned. Rejected scans reserve nothing and do not end the correction. Box identity can never change; conflicting GALIA metadata is blocked. Operators cannot remove accepted covers. The separate audited admin workflow below can void an assignment and invalidate the current result.
- Finishing the correction: complete → new **OK** report (box status OK); incomplete → reason required → new **NOT OK** report with the updated count, and the box can be corrected again later. An **OK** box is final: rescanning opens it read-only, no correction is offered.
- During a correction the control page shows « Correction en cours (n°X) » with the previous NOT OK result beside it. Production printing for that box is blocked until the correction is finalized. Only the **latest** report of a box can be printed; older reports stay in history (consultation, A4 marked « RAPPORT REMPLACÉ »). When a corrected result is printed, the app tells the operator to **remove/replace the previous NOT OK label** — software cannot invalidate a label already on the box.

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
2. Measure the loaded label stock (width × height, excluding the backing). In the Windows driver's printing preferences, create/select that exact paper size; match the media type and thermal/direct-transfer method to the physical printer and stock. Calibrate media with the printer/driver if needed. Application dimensions do not configure the driver.
3. Open `http://<server-IP>:3006` (or explicit alternative `:3007`). Add that exact origin to `APP_TRUSTED_ORIGINS` on the server and restart. Only the app port needs LAN access; PostgreSQL can remain local to the server. HTTPS is recommended for login/session confidentiality.
4. Log in and open **Étiquette de ce poste**. Enter a workstation name and the measured width/height in millimetres. **100 × 100 mm is an initial example, not an assumed stock size.** Save.
5. Click **Imprimer une étiquette TEST**. In the normal browser dialog, select **the locally installed ZD421 on this operator PC**, the matching paper format, **one copy**, **100% / actual size** (no Fit), **no margins**, **headers/footers disabled**, and background graphics enabled. Verify these settings on every print.
6. Measure the TEST label's **50 mm scale bar** with a ruler. Check the full frame, sharp text and accents; scan its QR and confirm it reads `TEST_NE_PAS_UTILISER` (the application must reject this as a production GALIA). A stock too small for the required layouts is refused. On narrower TEST formats the caption states the shorter ruler length; production confirmation still validates all worst-case layouts.
7. Only after physically checking the label, tick the confirmation checkbox and confirm the label size. This records **the operator's declaration**, not an automatic test of the printer or paper. A size change clears confirmation.
8. Print a finalized OK sample and scan its QR: it must return the **exact original GALIA**, e.g. `PL002815593B96AG_Q20_S10428865`.

Settings belong to a random workstation ID in this browser's local storage, with a separate profile in PostgreSQL. Another PC/browser/profile has its own settings; clearing browser data requires setup again. No default physical printer is selected by the website. Windows/browser printer preferences belong to each operator PC.

### Loading and browser restrictions

Printing loads an authorized same-origin frame, avoiding new popup windows and their popup blockers. It waits for fonts, the saved SVG image to decode, and a layout frame before requesting `window.print()`. A missing/expired session, blocked report, failed image or load timeout refuses the request and displays an error. If the browser blocks printing, allow it in browser/site settings and use an explicit reprint when necessary. Never treat the absence of an error as proof of output.

The website cannot detect the selected printer, a canceled dialog, unplugged USB, paper-out or actual physical printing. Check the printer/Windows queue and physical label yourself. There is no automatic resend.

---

## 7. Saved labels (black on white)

The server builds labels from **one immutable finalized report** using `lib/zpl/*` (historical directory name; only SVG is generated). Physical dimensions are in millimetres; geometry is validated for bounds and overlap. Display text is XML-escaped, and saved SVG is displayed as an image rather than executable inline markup.

| Label | Exact contents |
|---|---|
| **OK** | Large bold **OK**, QR encoding the exact original GALIA payload excluding transport CR/LF only, box PN, quantity, box serial, finalizing operator ID top-right. No URL/report ID in the QR. |
| **NOT OK** | Very large bold **NOT OK**, box PN, **QTY FOUND: accepted distinct count**, finalizing operator ID top-right. No QR, barcode, box serial, expected quantity, reference, timestamp or additional report fields. |
| **TEST** | Clearly marked **TEST — NE PAS UTILISER**, workstation, dimensions, accents, frame, scale bar and a nonproduction TEST QR. |
| **Reprint** | Same saved report content with **RÉIMPRESSION**; the original finalizing operator stays top-right. Reprint operator, time and reason remain in audit history. |

Long business identifiers shrink/wrap, never truncate. Printing is refused if required content cannot fit. OK is allowed only when the stored result is OK, accepted quantity equals expected quantity and there are no integrity issues. Only the latest report can produce a label; correction in progress blocks production printing. Loading an older saved job URL also rechecks these restrictions. Existing historical snapshots are preserved unchanged.

The separate A4 report remains available for consultation. Its explicit print action also checks correction/supersession restrictions and is audited; it is not a thermal production label.

---

## 8. Print requests and duplicate protection

New requests use method **PRINT_DIALOG** and final status **DIALOG_REQUESTED**: an **unconfirmed request**, not proof that a dialog appeared, a particular printer was selected or paper printed. Historical direct-print jobs retain their old methods/statuses/payloads for audit only; no dispatch/result endpoints remain.

1. An explicit label click creates an idempotent job and stores the exact server-generated SVG, SHA-256, report, workstation, size, operator and template version. Database guards keep this snapshot immutable.
2. Double clicks/network retries reuse the logical request key. Concurrent original requests are serialized: at most one original label job per report. The browser guards repeated frame load events and concurrent dialog requests.
3. Printing runs only from explicit actions. Mount, rerender, Strict Mode, refresh, navigation and repeated API responses never automatically print. The label page itself does not call print.
4. After a production request, use **Réimprimer…** for another label, including a canceled dialog, wrong selected printer or failed label loading. Check physical output first, provide a reason and confirm the reprint; it is audited and marked **RÉIMPRESSION**. A reprint can create a physical duplicate.
5. `window.print()` and `afterprint` never upgrade the job to physical success. Printing issues never alter the verification result.

---

## 9. Data integrity and concurrency strategy

- **Attempts** (migration `correction_attempts`): `ControlAttempt` rows (#1 INITIAL, #2… CORRECTION), `Box.activeAttemptId` = the open attempt, items/scans linked to the attempt that produced them, `Report.attemptId` unique (one immutable report per finalized attempt, several per box). Existing data was backfilled as attempt #1 (reports keep their original counts).
- **Row lock per box**: every mutation of a box (scan, finalize, suspend, takeover, opening a correction) runs in a transaction that first does `SELECT … FOR UPDATE` on the box row — two workstations can never open or run the same correction at the same time. Scans of one box are therefore serialized: two scans at 19/20 cannot both pass the quantity check, and finalization cannot interleave with a scan (it recounts the committed items under the same lock).
- **Global unique constraint on accepted serials**: two workstations scanning the same item into two boxes hold different locks; both may try to insert, PostgreSQL's unique index lets exactly one commit, the other transaction is retried and classified « Déjà scannée dans une autre boîte ».
- **Idempotency**: each logical scan has a client key (unique index). A retry with the same key returns the stored result (re-checked under the lock for concurrent retries); the same key with a different payload or user is rejected (409). A new physical scan of an accepted serial gets a new key → duplicate. Print jobs use the same mechanism.
- **Database guards** (migrations `integrity_guards` + `correction_attempts`): CHECK constraints (quantity range, digits-only serials, `OK ⇒ accepted = expected and no issue`, …); a trigger re-locks the box on each accepted-item insert and refuses closed boxes, items outside the open attempt, PN mismatch and overfill even outside the application; accepted-item contents, scan attempts, reports and audit events remain immutable; accepted items support only a one-way administrator void with reason; a closed OK box is read-only; a closed NOT OK box can only be reopened through a new correction attempt; an attempt can only be closed together with its report; stable box IDs, attempts, users and print jobs cannot be physically deleted; an explicit administrator reset is required before changing current GALIA identity; historical generations retain their identity snapshots; print-job payloads are immutable.
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

---

## 11. Physical acceptance checklist (manual, not performed by automated tests)

- [ ] Verify the real DS2208 payload with the actual Windows keyboard layout, Caps Lock settings and CR/LF suffix; scan 20 covers quickly and check ordered counts/focus.
- [ ] Verify the ZD421 model, Windows driver, media/calibration and the same measured stock dimensions in driver, application and print dialog.
- [ ] Select 100% / actual size, no margins, no headers/footers, one copy; measure the TEST bar at **50 mm** and inspect the complete frame, text and accents. Confirm manually.
- [ ] OK label: exact original GALIA QR decodes on the real scanner; operator top-right, PN, quantity and serial readable.
- [ ] NOT OK label: only NOT OK, PN, QTY FOUND and operator; no QR/barcode/extra fields.
- [ ] Cancel the print dialog, disconnect USB, turn off the printer and exhaust media: the app retains DIALOG_REQUESTED without claiming physical success. Inspect output/queue before an explicit reasoned RÉIMPRESSION.
- [ ] Verify failed loading/session expiry produces a clear error with no label request to print; browser restrictions are resolved manually.
- [ ] Double-click, refresh, navigate away/back and test a blocked browser: no automatic repeat printing.
- [ ] Two PCs open the LAN URL; each saves its own label settings and selects its own local ZD421. Clearing A's browser data requires setup on A and leaves B unchanged.
- [ ] NOT OK 18/20 on A → rescan on B → NO unchanged; YES resumes 18/20 under exclusive ownership. During correction, new and previously saved production label views and A4 print actions are blocked.
- [ ] Add two valid new covers on B → OK 20/20; duplicates/wrong PN remain rejected. Print the new OK label, physically replace the old NOT OK label. Earlier reports/jobs remain unchanged; earlier print URLs are refused. Completed OK stays read-only.
- [ ] Verify an incomplete correction produces another NOT OK report with its new accepted count and remains correctable.

## 12. Assumptions

- The supplied text formats are authoritative; PN charset `A–Z0–9` (3–40), digits-only serials (4–30), quantity 1–999 — adjust `lib/barcode.ts` if real labels differ (verify first on the diagnostic page).
- Any authenticated operator may take over an in-progress box (audited), open a correction of a NOT OK box (audited), view operators of earlier scans, request a reprint (reason + confirmation, audited) and set up the printer of their own workstation (audited, per workstation).
- After a correction, the previous reports are kept for traceability but are no longer printable (to avoid printing an outdated result).
- A reprint label carries the same content as the original plus « RÉIMPRESSION »; reprint operator/time/reason are kept in the database (not printed), per the label-content rules.
- QTY on the OK label is the GALIA quantity (equal to the accepted count for OK).
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

Current-state cards count **distinct stable boxes**, using the current valid report pointer. A correction/reprint is not another box. Completed = current OK + current NOT OK; an open correction is in progress. À recontrôler is a separate state after administrative invalidation. Archived generations have their own card/list and do not inflate current totals. Cards open their matching detail lists.

Filters: inclusive plant dates (Africa/Tunis), operator, PN prefix and state. Completed metrics use the **latest valid finalization date**; open/recontrol states use the current generation start date. Archives use the void timestamp and, for the operator filter, the resetting admin. Box, coiffe, attempt/generation, audit/rejection, print-job, workstation and presence lists use bounded PostgreSQL queries and server-side pagination (25 rows).

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

`20261113090000_administration` backfills existing controls as generation 1 and creates active reservations from their accepted items without removing history. Existing finalized reports are linked as the current valid result. Earlier migrations are unchanged. Development verification applies this migration only to the isolated `_test` database; check the actual main database migration status before deploying.

Manual acceptance: use an ADMIN and two OPERATOR browser tabs/PCs; void a coiffe and reset each box state, observe quantity/lease reconciliation, reuse released serials, recontrol and replace obsolete physical labels. Verify dashboard filters/pagination and presence through idle, closing one tab, expiry and logout. Check the real local ZD421 dialog/stock/QR as described above; automated tests cannot confirm physical printing.
