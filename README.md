# Shared Expenses

A small, self-hosted web app for a group (household, club, trip) to track a
shared budget together:

- **Budget entries** – money received into the shared pot
- **Expenses** – money spent, with receipts/invoices attached
- **Suggested purchases** – ideas with an expected price, which can later be
  turned into a real expense without double counting
- **Deletion requests** – nothing is deleted directly; another approver must
  approve, and approved records are archived (never erased)
- **Audit history** – an append-only log of every change, shown on each record
- **Dashboard** – budget received, expenses, available balance, % used,
  pending deletions, and suggestion estimates (kept separate from real totals)

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`). No other
services are needed.

```bash
npm install
npm start            # http://localhost:3000
```

Open http://localhost:3000, create an account (a unique **name** + password, no
email needed), create a group, and invite others from **Members**.

```bash
npm run dev          # restart automatically on file changes
npm test             # full automated test suite
npm run lint         # ESLint
npm run check        # lint + tests
npm run backup       # snapshot database + uploads into ./backups
npm run restore -- backups/backup-<timestamp>   # stop the app first
```

## Architecture

| Concern | Choice |
|---|---|
| Server | Node.js + Express 4 (`src/`) |
| Database | SQLite via built-in `node:sqlite`, WAL mode, file at `$DATA_DIR/app.db` |
| Auth | Name + password (scrypt hash), server-side sessions in SQLite, `HttpOnly; SameSite=Lax` cookie (`Secure` in production) |
| CSRF | Per-session token in `X-CSRF-Token` header + JSON-only bodies + Origin check |
| File storage | Private directory `$DATA_DIR/uploads`, random 48-hex names, never served statically |
| File delivery | `GET /files/<token>`: HMAC-signed, 5-minute links bound to the requesting user; membership is rechecked on every download |
| Frontend | Plain JavaScript single-page app in `public/` (no build step), hash routing |
| Tests | `node:test` + `supertest` (`test/`) |

```
src/
  server.js            entry point
  app.js               middleware, security headers, rate limit, file delivery, errors
  config.js            environment variables
  db.js                schema + migrations, transaction helper
  auth.js              sign-up/in/out, sessions, CSRF
  permissions.js       roles and permission checks
  audit.js             append-only audit log helpers
  records.js           record-type registry + validation (budget, expense, suggestion)
  attachments.js       upload validation, storage, signed links
  dashboard.js         financial totals
  routes/groups.js     groups, members, invitations, notifications, activity
  routes/records.js    CRUD, search/filter/sort, attachments, purchase linking
  routes/deletions.js  approve / reject / cancel deletion requests
public/
  index.html, css/app.css, js/app.js
  js/money.js          exact money parsing/formatting, shared with the server
scripts/backup.js, scripts/restore.js
test/                  automated tests
```

### Data flow

Browser → `fetch('/api/...')` with session cookie + CSRF header → Express
router → `loadMembership()` (404 if not an active member) → permission check →
validation → SQLite transaction (record change **and** audit entry together) →
JSON response. Totals are always computed on the server from stored rows.

### Data model

- `users` (unique case-insensitive `name`), `sessions`
- `groups` (one currency each; default Philippine peso, PHP), `memberships` (role, active/revoked), `invitations`
- `budget_entries`, `expenses`, `suggested_purchases`: amounts in **integer
  minor units** (öre/cents), `status` active/archived, `version` for conflict
  detection, `created_by/at`, `updated_by/at`, `archived_by/at`,
  `client_request_id` (unique per group, prevents duplicate submissions)
- `attachments` (soft-removed, `replaces_id` keeps replacement history)
- `deletion_requests` (one pending per record; DB check forbids self-approval)
- `audit_log` (UPDATE/DELETE blocked by triggers)
- `notifications` (deletion decisions)

Calendar dates (`expense_date` etc.) are stored as `YYYY-MM-DD`; timestamps are
server-generated UTC ISO strings, displayed in the viewer's local time zone.

### Roles

| Role | Can |
|---|---|
| viewer | view everything (records, files, history) |
| editor | + create/edit records, upload files, request deletion, link purchases |
| approver | + approve/reject **other people's** deletion requests, mark suggestions *Approved* |
| admin | + add/remove members, change roles, create invite links |

A group always keeps at least one admin.

### Financial rules

- Budget received = sum of active budget entries; Expenses = sum of active expenses.
- Records with a **pending** deletion request still count until approved.
- Available balance = budget received − expenses (may go negative).
- Suggested purchases never affect the balance. The estimate includes
  Suggested/Approved/Planned only. Once *Purchased*, the suggestion is linked to
  exactly one expense and only that expense counts.

## Configuration

See [`.env.example`](.env.example). Important variables:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | secure cookies, HSTS, request logs |
| `DATA_DIR` | database + uploads location (default `./data`) |
| `DOWNLOAD_LINK_SECRET` | **required in production**; signs download links |
| `TRUST_PROXY=true` | when behind a reverse proxy terminating HTTPS |
| `PORT` | default 3000 |

## Deployment

The app is a single Node process with local disk state, so it fits a small VM
or a container/PaaS **with a persistent volume** mounted at `DATA_DIR`.

1. Provision Node 22.13+ and a persistent, private disk for `DATA_DIR`.
2. Put HTTPS in front (Caddy, nginx, or the platform's TLS) and set `TRUST_PROXY=true`.
3. Set `NODE_ENV=production` and `DOWNLOAD_LINK_SECRET` in the platform's secret store.
4. `npm ci --omit=dev && npm start`. Migrations run automatically at start-up
   inside a transaction (`schema_migrations` table).
5. Smoke test: sign up, create a group, add a budget entry and expense, upload a
   receipt, request + approve a deletion (with a second account), convert a suggestion.
6. Schedule `npm run backup` (e.g. nightly cron) and copy `backups/` off the machine.

**Rollback:** stop the app, check out the previous release, and if a migration
was involved restore the pre-deploy backup with `npm run restore`. Always take a
backup before deploying.

Run a **single instance** only: sessions/rate limits are per-process and SQLite
is a local file.

## Retention and backups

- Records are never hard-deleted by the app; approved deletions are archived.
- Removed/replaced attachments are kept on disk and remain viewable in history.
- `npm run backup` uses `VACUUM INTO` (safe while running) and copies uploads.
  `npm run restore` checks integrity and moves the current data aside rather
  than deleting it. This round-trip is covered by `test/backup.test.js`.

## Known limitations

- No email: invite links must be shared manually; notifications are in-app only.
- Forgotten passwords cannot be reset yet (an admin can't reset them either).
- `node:sqlite` is marked experimental in Node 22 (the warning is suppressed in npm scripts).
- Browser end-to-end tests are not automated; UI flows were verified with a
  scripted DOM run during development plus manual testing.
- Single currency per group (default PHP, shown as ₱1,234.50 in the en-PH
  locale); all supported currencies use 2 decimals.
