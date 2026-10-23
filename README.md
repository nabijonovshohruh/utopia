# Rasch Test Bot

A lightweight Telegram bot that grades tests with a **fixed-anchor Rasch (1PL IRT)** scoring
engine. Students submit answers — by chat or through a Telegram **Mini App** form — and get
back raw score, ability estimate (θ), scaled score, and certificate level.

Supports two test shapes:

- **Custom** — any number of plain multiple-choice items (the original design).
- **NC55** — the fixed 55-item **National Certificate** structure: items 1–32 single-choice
  (A–D), 33–35 expanded choice (A–F), and 36–45 ten written questions each split into two
  independently-graded sub-items (36a/36b … 45a/45b), for 32 + 3 + 20 = 55 scored items.

One runtime dependency (`grammy`). Storage is Node's built-in `node:sqlite`, so there is
nothing to compile and no database server to run.

```
npm install
npm run migrate          # creates data/rasch.sqlite
npm run seed             # optional: a locked 20-item custom demo test
#   -> now edit .env (see below)
npm run doctor           # checks your config without contacting Telegram
npm run start:local      # the bot (long polling), loading .env
npm run webapp:local     # the Mini App server (separate process, optional), loading .env
```

`start:local`/`webapp:local` load `.env` via `node --env-file=.env` for local development.
`start`/`webapp` (used in production — e.g. Railway) run plain `node ...` and expect the
platform to inject `BOT_TOKEN` etc. directly as environment variables. Run `start`/`webapp`
locally without a loader and there's no crash at the Node level — `.env` is simply never read,
so `process.env.BOT_TOKEN` is empty and the app's own preflight check reports
`BOT_TOKEN is not set` and exits, same as a genuinely missing variable on a real deployment.

### Configuring `.env`

`.env` ships ready to go except for two values that cannot have defaults. Open it and replace
both placeholders:

| Variable | How to get it |
| --- | --- |
| `BOT_TOKEN` | Message **@BotFather** in Telegram, send `/newbot`, copy the token he replies with. Paste it bare — no quotes. |
| `ADMIN_IDS` | Message **@userinfobot** in Telegram; it replies with your numeric id. Comma-separate for several teachers. |

`ADMIN_IDS` is not optional in practice: without it nobody has teacher rights, so no answer key
can be uploaded and no test can be locked — the bot will treat you as an ordinary student.
`DB_PATH`, `MINIAPP_PORT` and `MINIAPP_PUBLIC_URL` are documented inline in `.env`; the first
two already have working defaults, and the last is optional (see [Mini App setup](#mini-app-setup)).

Then run `npm run doctor`. It validates the token format, parses `ADMIN_IDS`, confirms the
database is writable and the anchor-immutability triggers are installed, and exits non-zero
with a numbered to-do list if anything is missing. `start`/`start:local` run the same checks
and refuse to boot with an actionable message rather than failing later as an opaque Telegram
404.

| Script | Purpose |
| --- | --- |
| `npm start` | Run the bot (long polling), reading env vars already set by the platform — use this on Railway/Render/etc. |
| `npm run start:local` | Same, but loads `.env` first — use this for local development |
| `npm run webapp` | Run the Mini App's HTTP server (static page + submission API), platform env vars |
| `npm run webapp:local` | Same, but loads `.env` first |
| `npm run doctor` | Preflight check of config + database; contacts nothing (loads `.env`) |
| `npm run migrate` | Create/upgrade the SQLite schema (loads `.env`) |
| `npm run seed` | Insert a locked custom demo test, `DEMO-101` (loads `.env`) |
| `npm test` | 167 unit, pipeline, config, HTTP and middleware tests |
| `npm run verify:anchors` | Proof that volume doesn't move the scale (generic engine) |
| `npm run verify:nc55` | Same proof at the full 55-item shape, with scattered grading + batch publish |

`migrate`, `seed` and `doctor` deliberately work before a bot token exists — only `start` and
`webapp` require one (the Mini App server needs it to verify submissions — see below).

---

## Why fixed anchoring matters

The requirement driving this design: **more submissions must never change anyone's score.**

A naive implementation re-estimates item difficulties from all responses collected so far,
or normalises scaled scores to the current cohort's mean and SD. Both make a student's score
a function of who else happened to take the test. Add a weak cohort and every earlier
student's grade silently shifts — score deflation.

This implementation blocks that at four levels.

**1 — The math has no cohort term.** Ability estimation is a pure function:

```
theta = f(response vector, anchor vector)
```

`src/services/rasch.js` never reads the database and never looks at other examinees. Item
difficulties arrive as a function argument. There is no code path by which submission volume
could influence an estimate. This holds identically whether there are 10 items or 55.

**2 — Anchors and the score transform are frozen together.** `/lock` sets `items.anchored = 1`,
records a SHA-256 fingerprint of the `(position, type, key, b)` vector plus the scale constants,
and flips the test to `locked`. The reporting transform `scaled = intercept + slope · θ` is
stored per test and frozen by the same operation — fixing the item difficulties but normalising
the scaled scores to the live cohort would reintroduce drift through the back door.

**3 — The database refuses to let them move.** Immutability is enforced by SQL triggers, not
only application code:

```sql
CREATE TRIGGER trg_items_anchor_frozen
BEFORE UPDATE OF b_logit, answer_key, position, label, item_type, option_count,
                 parent_question, sub_label ON items
WHEN OLD.anchored = 1
BEGIN SELECT RAISE(ABORT, 'anchor_locked: …'); END;
```

A bug, a migration, or a SQL console cannot quietly re-anchor a live test. Issued results are
write-once for the same reason.

**4 — Every result carries its provenance.** Each row stores the `scale_version` and
`anchor_checksum` it was scored under. `loadAnchors()` recomputes the checksum before every
scoring run and **aborts** on a mismatch rather than issuing scores on a silently different
scale. Historical results stay reproducible and auditable.

### The consequence

Because scoring is anchor-pure, the complete raw → θ → scaled → grade table is determined
the moment the test is locked. `/table CODE` will print it before a single student sits the
exam, and it is still exactly correct after a million submissions.

`npm run verify:anchors` demonstrates this end-to-end on the generic engine: 4,550 submissions
across three cohorts of deliberately different size and ability, asserting identical raw scores
produce identical results throughout. `npm run verify:nc55` repeats the proof at the actual
55-item shape this project was built for — 390 submissions, written sub-items graded in
scattered batches by simulated graders, published in one batch:

```
✅ 346 same-raw-score pairs compared across 390 results — all identical.
✅ every published result matches the pre-publish conversion chart.
```

---

## The scoring engine

`src/services/rasch.js` — no dependencies, independently testable, and item-count-agnostic
(the same code scores a 3-item quiz or the 55-item NC structure).

**Model.** `P(x=1 | θ, b) = 1 / (1 + exp(-(θ - b)))`

**Ability estimation.** Default is **Warm's Weighted Likelihood Estimate (WLE)**, solving
`(r - Σp) + J/(2I) = 0`. WLE is bias-corrected and — importantly for certification — finite at
zero and perfect raw scores. Plain MLE diverges there and needs an arbitrary "0.3 logit"
fudge; baking an arbitrary constant into a reported score is the kind of soft judgement call
this pipeline exists to eliminate. Solved by bisection, which cannot diverge or oscillate.

`estimateThetaMLE()` is also provided for parity with existing Winsteps/ConQuest reporting.

**Reporting.** `thetaToScaled()` applies the test's frozen linear transform with clamping;
`gradeFor()` maps the scaled score onto fixed bands. Default: `500 + 50·θ` over 200–800, with
A+ ≥ 700, A ≥ 640, B+ ≥ 580, B ≥ 520, C ≥ 460.

**Binary scoring only.** Every item — multiple choice or written — is worth exactly 1 point,
enforced by a `CHECK (max_score = 1)` on the `items` table. Partial credit would need a
polytomous model (e.g. Masters' Partial Credit Model) with different math and a different
anchor shape; that's out of scope here, and a half-implemented version of it would be worse
than not having it. The column exists so that extension has somewhere to attach later without
another migration.

**Calibration** (`calibrateAnchors`) is the only function that *produces* b-values, and it is
never called during scoring. PROX starting values, then JMLE, re-centring the item mean to 0
each cycle to fix the scale origin. Two details that matter because the output is about to
become permanent:

- Items and persons with extreme margins carry no difficulty information and are excluded.
  Excluded items come back as `null` so an operator must supply those anchors deliberately,
  rather than the system shipping a fabricated value.
- A **JMLE dispersion-bias correction** of `(L-1)/L` is applied. Estimating persons and items
  jointly inflates the spread of item difficulties; left uncorrected it stretches the scale and
  permanently mis-grades examinees near the extremes. (This showed up in testing as a 14%
  overshoot against known difficulties.)

**Monitoring, not auto-correction.** `itemDiagnostics()` reports per-item `displacement` — the
logit shift this cohort's data *would* apply — plus infit/outfit mean-squares. It is
deliberately read-only. Writing `b + displacement` back is precisely the feedback loop that
causes drift; a genuinely stale anchor is a decision for a human plus a new test code, not a
nightly job.

---

## The 55-item National Certificate template

`src/domain/nc55.js` is the single source of truth for the structure — the answer-key parser,
the lock-time structure validator, and the Mini App's rendered form (`GET /api/structure`) all
derive from it, so there's exactly one place that encodes "what an NC test looks like":

| Items | Type | Options | Scoring |
| --- | --- | --- | --- |
| 1–32 | Single choice | A–D | Auto-graded by key match |
| 33–35 | Expanded choice | A–F | Auto-graded by key match |
| 36–45 | Written (×2 sub-items each) | free text | **Manually graded 0/1 per sub-item** |

A `label` ("1", "33", "36a") and `position`/seq (1–55, the index into the anchor vector) are
related by a fixed formula, not by upload order — `labelToSeq`/`seqToLabel` in `nc55.js` — so a
teacher's key is validated against the template rather than trusted to define it.

### Why written items need a separate grading step

Items 36–55 are free text — there's no key to match against. `responses.correct` is nullable;
`NULL` means "submitted, not graded yet," distinct from "graded and wrong." The scoring engine
(`scoreSubmission`) refuses to run while any response on a submission is still `NULL`, so a
Rasch score can never silently treat "nobody has read this answer yet" as "incorrect."

### Certificate grade scale ("ball")

An NC55 key with no `SCALE:`/`RANGE:`/`GRADES:` header defaults to the National Certificate
ball scale (`NC55_DEFAULT_SCALE`/`NC55_GRADE_BANDS` in `src/domain/nc55.js`) rather than the
generic one:

| Ball | Daraja |
| --- | --- |
| < 46 | Sertifikat berilmaydi |
| 46–50 | C |
| 51–55 | C+ |
| 56–60 | B |
| 61–64 | A |
| 65+ | A+ |

This is a *default*, not a hard-coded ceiling — an explicit `SCALE:`/`RANGE:`/`GRADES:` header
in the key still overrides it, the same as for a 'custom' test. `custom`-template tests are
unaffected either way; this default only applies to `TEMPLATE: NC55` keys.

---

## Schema

`src/db/schema.sql`

| Table | Holds |
| --- | --- |
| `students` | Telegram identity, registered Ism-Familiya (`registered` flag), currently open test |
| `tests` | Code, title, status, `template` (`custom`/`nc55`), **frozen scale constants**, `anchor_checksum`, `scale_version` |
| `items` | Position/label, `item_type` (`mcq`/`written`), option count, answer key (mcq only), parent question + sub-label (written only), **`b_logit`**, `anchored` flag |
| `grade_bands` | Per-test certificate levels (`label`, `min_scaled`) |
| `submissions` | One answer sheet; `source` (`chat`/`miniapp`); `submitted → scored → verified` |
| `responses` | Per-item answer and correctness — **`correct` is nullable**: `NULL` = awaiting a teacher's grade, distinct from 0 (wrong) |
| `results` | Raw, θ, SE, scaled, grade + the `scale_version`/`anchor_checksum` used |
| `schema_meta` | Tracks which migration generation has been applied (see below) |

Lifecycle: `draft` → `locked` → `archived`. **A draft cannot score anyone** and **a locked test
cannot be edited** — the only way to change anchors is to publish a new test code.

### Migrations

`openDb()` always applies the schema additively (`CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`) —
safe on every boot, but it cannot alter an *existing* table's columns by itself. Beyond that,
boot behaves differently depending on how big a gap there is:

- **v2 → v3** (`students.registered`, for name registration) is a single additive column, proven
  safe at any data volume (see `test/migrations.test.js`). `openDb()` applies it automatically
  on boot — this matters for a platform that redeploys on `git push` with no separate release
  step: without self-healing, shipping v3 code against a still-v2 database would crash-loop a
  live deployment until someone remembers to run `npm run migrate` by hand.
- **v1 → v2 or newer** changed `CHECK`/`NOT NULL` constraints on *existing* columns, which
  `ALTER TABLE` can't do — that jump needs a destructive rebuild, so it is deliberately **not**
  auto-applied. `openDb()` throws `SchemaOutOfDate` immediately at boot instead, and only
  `npm run migrate`, run explicitly, can perform it — and even then, only when the database has
  **zero real submissions or results** (fresh or demo-only); otherwise it refuses outright and
  tells you to handle it by hand. There's never a silent data-loss path.

---

## Teacher workflow

Set `ADMIN_IDS` in `.env` to grant access.

### 1. Upload an answer key

`/upload`, then paste or attach a `.txt`/`.csv`. Plain (custom) shape:

```
CODE: MATH-2026-A
TITLE: Mathematics Midterm 2026
SCALE: 500 + 50*theta
RANGE: 200..800
GRADES: A+>=700, A>=640, B+>=580, B>=520, C>=460, NC>=0
ITEMS:
1  A  -2.10
2  C  -1.45
3  B   0.00
4  D   1.25
```

NC55 shape — start with `TEMPLATE: NC55`; items 1–35 work the same (33–35 also accept E/F);
written sub-items 36a–45b take a difficulty but **no answer letter**:

```
TEMPLATE: NC55
TITLE: National Certificate 2026 — Mathematics
ITEMS:
1  A  -2.10
...
33 E  -0.50
34 A   0.10
35 F   0.90
36a -1.00
36b -0.80
...
45a  1.50
45b  1.80
```

`CODE:` can be left out entirely — on upload, one is generated for you (e.g. `TEST-5501`) and
shown in the confirmation, ready to post to your class channel. The parser validates every
item against the fixed template (right option count per item, written items carry no key,
no gaps or duplicates) and rejects anything that doesn't conform *before* it's ever stored.

### 2. Get anchors, if you don't have them

Anchors normally come from a previous administration or a published item bank. Without them,
leave the difficulty column off, collect a pilot cohort, and run `/calibrate CODE` once. The
test stays unscorable until every item — including every written sub-item — is anchored.

### 3. Lock it

`/lock CODE` freezes the anchors, the transform, the bands, and (for NC55) the structure, then
opens the test to students. Check the resulting conversion chart with `/table CODE`.

### 4. Grade written answers as they come in (NC55 only)

As submissions arrive, `/writing SUBMISSION_ID` shows the student's free-text answer for each
ungraded sub-item and puts you in grading mode — reply with scores like `36a=1 36b=0 37a=1`
(any order, several messages are fine; `/cancel` to stop). `/pending` and `/ungraded CODE` show
what's still outstanding across everyone.

### 5. Publish results

`/status CODE` shows how many have submitted, how many still need written grading, how many
are ready, and how many are already scored, with an inline **Calculate & Publish Results**
button. Tapping it Rasch-scores every fully-graded submission in one batch and notifies each
student — refusing outright if anything still needs grading, so nobody is left out of a batch
everyone else got.

### Command reference

| | |
| --- | --- |
| `/upload`, `/key CODE` | Create a draft; inspect stored key and anchors |
| `/calibrate CODE` | One-time anchor estimation from a pilot cohort |
| `/lock CODE` | Freeze anchors + scale (+ structure, for NC55); enable scoring |
| `/pending` | Submissions awaiting grading or scoring, with ungraded counts |
| `/ungraded CODE`, `/writing SUB_ID` | Grade NC55 written sub-items |
| `/score ID`, `/scoreall CODE` | Rasch-score submissions directly |
| `/status CODE` | Submission counts + "Calculate & Publish Results" button |
| `/verify ID` | Mark a result teacher-verified (the score itself stays immutable) |
| `/autograde CODE on\|off` | Score mcq-only submissions immediately, or hold for review |
| `/tests`, `/results CODE`, `/export CODE` | Rosters and CSV export |
| `/table CODE` | Raw → scaled conversion chart |
| `/drift CODE` | Anchor health and item fit |

---

## Mini App setup

For NC55 tests, students can answer through a proper mobile form instead of typing in chat:
`src/webapp/public/index.html` (single static file, no build step) served by
`src/webapp/server.js` (plain `node:http`, no new dependencies).

**Why a real server instead of `Telegram.WebApp.sendData()`:** `sendData()` caps the payload
around 4096 bytes, which a handful of genuine written answers can blow through — silent
truncation on a certificate exam is a real correctness bug, not a hypothetical. Hosting the
submission endpoint ourselves removes that ceiling. The tradeoff is that a request to our own
server doesn't arrive through Telegram's authenticated bot-API path, so `POST /api/submissions`
verifies the Mini App's `initData` HMAC signature itself (`src/webapp/initdata.js`, per
Telegram's documented algorithm) before trusting the claimed `user.id` — without that check,
anyone with the page's URL could submit answers as an arbitrary student.

The page and its API are served from the same origin, so there's no CORS configuration needed.

### Deploying it

1. `npm run webapp` starts the server, bound to `0.0.0.0`. Listens on `process.env.PORT` if
   set (Railway and most platforms assign this automatically), else `MINIAPP_PORT`, else 8080.
2. Put it behind HTTPS — Telegram refuses non-HTTPS Mini App URLs. For local testing, a tunnel
   (ngrok, Cloudflare Tunnel) pointed at the local port works; for production, any static+API
   host or a reverse proxy (Caddy/nginx) in front of the Node process.
3. Set `MINIAPP_PUBLIC_URL` in `.env` to that HTTPS URL, then restart the bot. `/test CODE` on
   an NC55 test will now send an **Open Answer Form** button instead of chat instructions.
4. Register the URL with **@BotFather** (`/newapp` or `/setmenubutton`) if you also want it
   reachable from the bot's menu button, not just the per-test link.

Without `MINIAPP_PUBLIC_URL` configured, NC55 tests still work — `/test` falls back to a
chat-based format (compact `1A 2B 3C…` for multiple choice, one `36a: <answer>` line per
written sub-item, all in a single message).

The bot process and the Mini App server are independent — run one, the other, or both,
sharing the same SQLite file (opened in WAL mode for safe concurrent access from both).

---

## Student workflow

### 0. Register a name — required, once

`/start` always shows an **"Ilovani ochish"** button (if a Mini App is configured — see
[below](#mini-app-setup)) — for students and teachers alike, since both go through the same
handler. A student who hasn't registered yet is asked:

```
Iltimos, ism va familiyangizni kiriting:
```

and their reply (validated: at least two words, no bare commands) is saved as their official
Ism-Familiya — *not* whatever Telegram's profile happens to say, and not touched again by
profile changes afterward (see `getOrCreateStudent` in `src/services/submissions.js`). Both
`/test` (chat) and the Mini App's submission endpoint refuse to accept an answer sheet from an
unregistered student; the Mini App additionally checks registration *before* rendering the
55-item form (`GET /api/registration`), so nobody fills the whole thing in only to be turned
away at submit time.

### 1. Take a test

**Custom tests**, or NC55 without a Mini App configured:

```
/test MATH-2026-A      → opens the test, explains the answer format
ABCDABCD…              → submits (also "A B C D" or "1A 2C 3B"; "-" skips an item)
/result                → full report
/mytests                → history
```

**NC55 with a Mini App configured:** `/test CODE` sends an **Open Answer Form** button. The
form shows a progress counter, radio groups sized to each item (4 or 6 options), and grouped
textareas for the ten written questions; submitting posts straight to the bot's database.
Results aren't available until the teacher publishes (written items need grading first).

The report, once scored, always includes the student's registered name:

```
Mathematics Midterm 2026
MATH-2026-A · submission #412
Ism-Familiya: Shohruh Nabijonov

Raw score    14 / 20  (70.0%)
             ███████░░░

Rasch measurement
Ability (θ)  +1.30 logits  ±0.55
Scaled score 565 ± 28
Level        B

16 point(s) to B+.

Scored against fixed item anchors (a3aa925a, scale v1).
This score does not change as more students submit.
```

Admin listings (`/results CODE`, `/pending`, `/ungraded CODE`) and the "result is ready"
notification sent when a teacher scores or publishes also show this same registered name.

---

## Notes before production use

- **Anchor quality is your responsibility.** The engine guarantees your anchors are applied
  consistently; it cannot tell you they were right. Calibrate on a representative sample
  (200+ examinees) or inherit values from a real item bank.
- **Answer keys live in the database in plaintext.** `/key` is admin-only, but treat the
  SQLite file as sensitive and keep `ADMIN_IDS` tight.
- **Long polling** suits a single bot instance. For multiple instances or serverless, switch
  `bot.start()` to a webhook.
- **Binary scoring only** (right/wrong, 1 point each) — see "Binary scoring only" above.
- **Written-item grading is manual by design.** There's no "AI-grade this essay" shortcut here
  on purpose — a Rasch score is a claim about the underlying construct, and that claim is only
  as good as the correctness judgment feeding it.
