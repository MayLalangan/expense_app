# Shared Expenses

A small web app for a group (household, club, trip) to track a shared budget
together:

- **Budget entries** – money received into the shared pot
- **Expenses** – money spent, with receipts/invoices attached
- **Suggestions checklist** – a shared list of things to buy, with an optional
  expected price. Tick items off when done; optionally record the actual
  expense (counted once, never double counted)
- **Deletion requests** – nothing is deleted directly; another approver must
  approve, and approved records are archived (never erased)
- **Audit history** – an append-only log of every change, shown on each record
- **Dashboard** – budget received, expenses, available balance, % used,
  pending deletions, and suggestion estimates (kept separate from real totals)

Live setup: **Render** (free web service) + **Supabase** (free Postgres and
private file storage), deployed by **GitHub Actions** after the tests pass.

## Quick start (local)

Requires **Node.js 22.13+**. Nothing else to install: locally the app uses
PGlite, a Postgres that runs inside Node, and stores files on disk.

```bash
npm install
npm start            # http://localhost:3000
```

Open http://localhost:3000, create an account (a unique **name** + password, no
email needed), create a group, and invite others from **Members**.

```bash
npm run dev          # restart automatically on file changes
npm test             # full automated test suite (in-process Postgres)
npm run lint         # ESLint
npm run check        # lint + tests
npm run backup       # copy database + receipts into ./backups
npm run restore -- backups/backup-<timestamp>   # into an EMPTY database
npm run import-sqlite                           # one-time: old SQLite data → current database
```

To run the tests against a real Postgres server as well (CI does this):
`TEST_DATABASE_URL=postgres://user@localhost:5432/postgres npm test` — each
test creates and drops its own database.

npm scripts read a local `.env` file if present (see `.env.example`). With the
Supabase variables set there, `backup`, `restore` and `import-sqlite` work on
the **live** data; without them, on the local data.

## Architecture

| Concern | Choice |
|---|---|
| Server | Node.js 22 + Express 4 (`src/`) |
| Database | Postgres. Production: Supabase via `pg` (`DATABASE_URL`). Local/tests: PGlite in `$DATA_DIR/pgdata` or in memory |
| Auth | Name + password (scrypt), server-side sessions in Postgres, `HttpOnly; SameSite=Lax` cookie (`Secure` in production) |
| CSRF | Per-session token in `X-CSRF-Token` header + JSON-only bodies + Origin check |
| File storage | Production: private Supabase Storage bucket (`receipts`), server-side access with the service-role key. Local: `$DATA_DIR/uploads`. Random 48-hex names |
| File delivery | `GET /files/<token>`: HMAC-signed, 5-minute links bound to the requesting user; membership is rechecked on every download; the bucket is never public |
| Frontend | Plain JavaScript single-page app in `public/` (no build step), hash routing |
| Tests | `node:test` + `supertest` (`test/`), on PGlite and on real Postgres |
| CI/CD | `.github/workflows/ci-deploy.yml` (lint, tests ×2, audit, then Render deploy hook), `keepalive.yml` (daily ping) |

```
src/
  server.js            entry point
  app.js               middleware, security headers, rate limit, file delivery, errors
  config.js            environment variables (+ refuses unsafe production config)
  db.js                Postgres schema + migrations, pg/PGlite drivers, transactions
  auth.js              sign-up/in/out, sessions, CSRF
  permissions.js       roles and permission checks
  audit.js             append-only audit log helpers
  records.js           record-type registry + validation (budget, expense, suggestion)
  attachments.js       upload validation, storage backends (local/Supabase), signed links
  dashboard.js         financial totals
  routes/groups.js     groups, members, invitations, notifications, activity
  routes/records.js    CRUD, search/filter/sort, attachments, checklist, purchase linking
  routes/deletions.js  approve / reject / cancel deletion requests
public/
  index.html, css/app.css, js/app.js
  js/money.js          exact money parsing/formatting, shared with the server
scripts/               backup, restore, import-sqlite (shared logic in transfer.js)
render.yaml            Render Blueprint (free web service)
test/                  automated tests
```

### Data flow

Browser → `fetch('/api/...')` with session cookie + CSRF header → Express
router → `loadMembership()` (404 if not an active member) → permission check →
validation → Postgres transaction (SERIALIZABLE; record change **and** audit
entry together, retried automatically on conflicts) → JSON response. Totals
are always computed on the server from stored rows.

### Data model

- `users` (name unique ignoring case), `sessions`
- `groups` (one currency each; default Philippine peso, PHP), `memberships` (role, active/revoked), `invitations`
- `budget_entries`, `expenses`, `suggested_purchases`: amounts in **integer
  minor units** (centavos/cents, `BIGINT`), `status` active/archived, `version`
  for conflict detection, `created_by/at`, `updated_by/at`, `archived_by/at`,
  `client_request_id` (unique per group, prevents duplicate submissions)
- `attachments` (soft-removed, `replaces_id` keeps replacement history)
- `deletion_requests` (one pending per record; DB check forbids self-approval)
- `audit_log` (UPDATE/DELETE/TRUNCATE blocked by a trigger)
- `notifications` (deletion decisions)
- Row Level Security is enabled on every table with no policies, so Supabase's
  public REST API roles can read nothing; the app connects as the table owner.

Calendar dates (`expense_date` etc.) are stored as `YYYY-MM-DD`; timestamps are
server-generated UTC ISO strings, displayed in the en-PH locale.

### Roles

| Role | Can |
|---|---|
| viewer | view everything (records, files, history) |
| editor | + create/edit records, upload files, request deletion, tick checklist items, link purchases |
| approver | + approve/reject **other people's** deletion requests, mark suggestions *Approved* |
| admin | + add/remove members, change roles, create invite links |

A group always keeps at least one admin.

### Financial rules

- Budget received = sum of active budget entries; Expenses = sum of active expenses.
- Records with a **pending** deletion request still count until approved.
- Available balance = budget received − expenses (may go negative).
- Suggestions (checklist items) never affect the balance. The estimate covers
  open items (Suggested/Approved/Planned) that have a price; items without a
  price add nothing. Checking an item off marks it *Done* (stored as
  `purchased`) without spending money. If an expense is linked (optional), only
  that expense counts. A linked item can't be unchecked until it's unlinked;
  unchecking restores the status it had before.

## Configuration

See [`.env.example`](.env.example). Important variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | secure cookies, HSTS, request logs; requires the three Supabase settings below |
| `DATABASE_URL` | Supabase **Session pooler** connection string |
| `DATABASE_CA_CERT` | optional: Supabase CA certificate (PEM) to verify the database server |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase Storage for receipts (server-only secret) |
| `DOWNLOAD_LINK_SECRET` | **required in production**; signs download links |
| `TRUST_PROXY=true` | behind Render's HTTPS proxy |
| `DATA_DIR` | local PGlite database + uploads (default `./data`) |

In production the app **refuses to start** without `DATABASE_URL`,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, because Render's free disk is
wiped on every restart (override with `ALLOW_LOCAL_DATA=true` only on a host
with a persistent disk).

## Deployment: Render + Supabase + GitHub Actions (all free)

### 1. Supabase (database + receipts)

1. Create a free account at supabase.com → **New project**. Pick a strong
   database password and a region. Render's `region` in `render.yaml` must
   match it (this project: Supabase Central EU `eu-central-1` ↔ Render
   `frankfurt`), because every page makes several database round trips.
2. **Connect** (top bar) → **Session pooler** → copy the URI and put your
   database password into it. This is `DATABASE_URL`. (Use the pooler, not the
   "Direct connection": Render can't reach Supabase's IPv6-only direct address.)
3. **Project Settings → API**: copy the **Project URL** (`SUPABASE_URL`) and the
   **service_role** secret key (`SUPABASE_SERVICE_ROLE_KEY`). Never share or
   commit this key.
4. Optional: **Project Settings → Database → SSL Configuration → Download
   certificate**; its contents become `DATABASE_CA_CERT`.

The app creates its tables and the private `receipts` bucket by itself on
first start.

### 2. Render (web service)

1. Create a free account at render.com and connect your GitHub account.
2. **New → Blueprint** → choose this repository. Render reads `render.yaml`
   and asks for `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   and (optional) `DATABASE_CA_CERT`. `DOWNLOAD_LINK_SECRET` is generated.
3. After the first deploy, open the service URL (e.g.
   `https://expense-app.onrender.com`) and sign up.
4. Service → **Settings → Deploy Hook**: copy the URL (keep it secret).

### 3. GitHub (automatic deploys + keep-alive)

In the repository: **Settings → Secrets and variables → Actions**

- **Secrets** → New: `RENDER_DEPLOY_HOOK_URL` = the deploy hook URL.
- **Variables** → New: `APP_URL` = the Render service URL.

From then on every push to `main` runs lint, the tests (on PGlite and on a real
Postgres 17), and `npm audit`; only if all pass does it ask Render to deploy
exactly that commit. Pull requests run the checks without deploying. The
daily **Keep alive** workflow pings `/healthz?db=1` so Supabase never pauses
the project for inactivity.

### Moving existing local data to Supabase (optional, one time)

Put the Supabase values into a local `.env` file, then run either
`npm run import-sqlite` (from the old SQLite version) or
`npm run restore -- backups/backup-<timestamp>`. Both only load into an
**empty** database and never overwrite anything.

### Free-tier behaviour to expect

- Render's free service **sleeps after 15 minutes** without visitors; the next
  visit takes about a minute to wake it.
- Supabase free: 500 MB database, 1 GB file storage, **no automatic backups** —
  run `npm run backup` (with the Supabase `.env`) regularly and keep the folder
  somewhere safe. Backups are **not** stored on GitHub because the repository
  is public.
- GitHub disables scheduled workflows in repositories with no activity for 60
  days; if that happens, re-enable **Keep alive** in the Actions tab (normal
  use of the app also counts as database activity).

### Rollback

Render → service → **Events** → pick an earlier deploy → **Rollback**. Keep
new migrations backward compatible (add columns/tables; don't drop or rename in
the same release) so a rolled-back version still runs against the database.
If data itself goes wrong, restore a backup into a fresh Supabase project.

Run a **single instance** only: rate limits are per-process.

## Retention and backups

- Records are never hard-deleted by the app; approved deletions are archived.
- Removed/replaced attachments are kept in storage and remain viewable in history.
- `npm run backup` writes `data.json` (all tables except sessions) plus every
  receipt to a local folder. `npm run restore` loads it into an empty database
  and resets id sequences. The round-trip is covered by `test/backup.test.js`.

## Known limitations

- No email: invite links must be shared manually; notifications are in-app only.
- Forgotten passwords cannot be reset yet (an admin can't reset them either).
- Free-tier cold starts (about a minute) after idle periods.
- Browser end-to-end tests are not automated; UI flows were verified with a
  scripted DOM run during development plus manual testing.
- Single currency per group (default PHP, shown as ₱1,234.50 in the en-PH
  locale); all supported currencies use 2 decimals.
