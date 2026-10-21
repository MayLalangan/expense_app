# Shared Expenses App --- Master TODO

> **Purpose:** This is the master implementation checklist for the
> shared expenses app. Keep it up to date from the beginning of
> development through release.
>
> **Working rules** - Use `- [ ]` for incomplete tasks and `- [x]` only
> after the implementation has been verified. - Do not mark a task
> complete merely because code was written; run the relevant tests and
> inspect the result. - Before changing an existing project, inspect its
> structure and document what already exists. - Prefer small, reviewable
> steps. Keep this file updated as requirements, architecture, and
> implementation change. - Record important architecture/security
> decisions and unresolved questions below. - Never place passwords, API
> keys, tokens, or other secrets in this file.

_Status as of 2026-10-19: Postgres version ready for Render + Supabase.
`npm run check` → ESLint clean, 76/76 tests passing on PGlite and 76/76 on a
real Postgres server (pg driver); `npm audit` 0 vulnerabilities. Scripted DOM
walkthrough of all main screens passes against the Postgres build; production
mode verified locally (secure cookie, HSTS, keep-alive endpoint). Not yet run
against live Supabase/Render — accounts still to be created._

## 1. Project discovery and planning

-   [x] Inspect the existing repository, framework, dependencies,
    scripts, and current application behavior.
    _(2026-10-17: repo contained only this TODO.md, no commits; greenfield.)_
-   [x] Identify existing features, partially implemented features,
    bugs, and missing features. _(None existed.)_
-   [x] Read existing documentation and configuration before making
    changes.
-   [x] Document the current architecture and data flow. _(README.md)_
-   [x] Confirm the target deployment environment and required
    environment variables. _(2026-10-19: Render free web service +
    Supabase free Postgres/Storage, deployed by GitHub Actions; variables in
    `.env.example` and `render.yaml`.)_
-   [x] Identify the authentication provider, database, file-storage
    solution, and testing framework.
-   [x] Record assumptions and unresolved product decisions in the Open
    Questions section.
-   [x] Create or update `README.md` with setup, development, testing,
    and deployment instructions.
-   [x] Keep this `TODO.md` as the master checklist and update it as
    work progresses.

## 2. Authentication, membership, and permissions

-   [x] Implement secure sign-up, sign-in, sign-out, and session
    handling. _(Name + password, scrypt, server-side sessions, absolute
    + idle expiry.)_
-   [x] Provide a way to invite or add members to a shared
    group/workspace. _(Single-use expiring invite links; admins can also
    add existing users by name.)_
-   [x] Associate each record with the correct group/workspace.
-   [x] Enforce group/workspace isolation on the server and in database
    access rules.
-   [x] Ensure users can access only the groups and records they are
    authorized to access.
-   [x] Define roles and permissions for members, editors, and deletion
    approvers. _(viewer < editor < approver < admin; see README.)_
-   [x] Enforce permissions on the server; do not rely only on hiding UI
    controls.
-   [x] Prevent a user from approving their own deletion request.
    _(Server check + database CHECK constraint.)_
-   [x] Handle expired sessions, unauthorized requests, and revoked
    membership.
-   [x] Add tests for authentication, role permissions, and cross-group
    data isolation.
-   [ ] Password reset / change password. _(New: not implemented; no
    email channel exists.)_

## 3. Data model and financial correctness

-   [x] Define and document the database schema and relationships.
-   [x] Store money as integer minor units (for example, öre or cents),
    not floating-point values.
-   [x] Store dates/timestamps consistently and display them in the
    user's appropriate local timezone.
-   [x] Record the group/workspace ID and creator identity for each
    financial record.
-   [x] Use server-generated timestamps for creation, modification, and
    workflow events.
-   [x] Add database constraints and server-side validation to prevent
    invalid or duplicate records. _(CHECK constraints +
    `client_request_id` idempotency.)_
-   [x] Define how pending, approved, rejected, and archived records
    affect financial totals.
-   [x] Make balance calculations from persisted, authorized records
    rather than client-supplied totals.
-   [x] Handle concurrent edits safely and detect stale updates where
    appropriate. _(`version` column, 409 on mismatch.)_
-   [x] Add tests for calculations, rounding, invalid values, and
    concurrent updates.

## 4. Budget entries / incoming money

-   [x] Create budget-entry records for money received or allocated to
    the shared budget.
-   [x] Require an amount and source/name; allow an optional
    description. _(Also a received date, defaulting to today.)_
-   [x] Support optional attachments for relevant budget entries.
-   [x] Automatically record the creator identity and server creation
    timestamp.
-   [x] Automatically record the last editor and server modification
    timestamp.
-   [x] Build a budget-entry list with search, filtering, and sorting.
-   [x] Support viewing a budget entry and its metadata.
-   [x] Allow authorized users to edit budget entries.
-   [x] Record every edit in the audit history, including changed fields
    and old/new values.
-   [x] Route budget-entry deletion through the same
    request-and-approval workflow as expenses.
-   [x] Ensure pending deletion requests do not silently remove entries
    from view.
-   [x] Add tests for creation, editing, listing, permissions, and
    deletion workflow.

## 5. Expenses

-   [x] Create expense records with a name/title, amount, and expense
    date.
-   [x] Support an optional description and category.
-   [x] Support one or more receipt/invoice attachments.
-   [x] Automatically record the creator identity and server creation
    timestamp.
-   [x] Automatically record the last editor and server modification
    timestamp.
-   [x] Build an expense list with search, filtering, and sorting.
-   [x] Support viewing expense details, attachments, and history.
-   [x] Allow authorized users to edit expenses.
-   [x] Record every edit in the audit history, including changed fields
    and old/new values.
-   [x] Route expense deletion through the request-and-approval
    workflow.
-   [x] Define and test whether pending-deletion expenses continue to
    count in the balance until approval. _(They do count.)_
-   [x] Add tests for creation, editing, listing, permissions,
    calculations, and deletion workflow.

## 6. Attachments and receipt storage

-   [x] Choose and configure private file storage. _(Production: private
    Supabase Storage bucket, server-side only. Local/tests: private dir under
    `DATA_DIR`. Supabase backend tested against a fake API; not yet against a
    live project.)_
-   [x] Initially allow PDF, JPG, JPEG, and PNG files.
-   [x] Validate file type, file size, and file content on the server.
    _(Magic bytes + extension match + 10 MB limit.)_
-   [x] Generate safe storage names rather than trusting user-provided
    filenames.
-   [x] Restrict upload, preview, and download access to authorized
    group members.
-   [x] Use short-lived authorized download links or an equivalent
    secure delivery method. _(5-min HMAC links bound to the user.)_
-   [x] Support multiple attachments on a budget entry, expense, or
    suggested purchase where appropriate.
-   [x] Show supported image previews and provide PDF viewing or
    download. _(Implemented; inline rendering verified by HTTP headers,
    not visually in a real browser.)_
-   [x] Record uploader identity and upload timestamp.
-   [x] Preserve attachment history when a file is replaced or removed.
-   [x] Keep attachments available while a record's deletion request is
    pending.
-   [x] Preserve attachments when a record is archived, subject to the
    documented retention policy.
-   [x] Define backup, recovery, and retention procedures for uploaded
    files.
-   [x] Add tests for valid/invalid uploads, unauthorized access,
    replacement, and archival.

## 7. Audit history

-   [x] Implement an append-only audit log for important record and
    workflow actions.
-   [x] Record the actor, server timestamp, action type, record type,
    and record ID.
-   [x] Record changed fields and old/new values for edits where
    appropriate.
-   [x] Record creation, editing, deletion requests, approvals,
    rejections, archival, and attachment changes.
-   [x] Prevent normal application operations from editing or deleting
    audit entries. _(SQLite triggers abort UPDATE/DELETE.)_
-   [x] Restrict audit-history viewing to authorized members.
-   [x] Display a chronological history on relevant record detail
    screens.
-   [x] Ensure audit data does not expose secrets or unnecessary
    sensitive information.
-   [x] Add tests that verify audit records are created correctly and
    remain intact.

## 8. Deletion request and approval workflow

-   [x] Implement a deletion-request record linked to the item being
    considered for deletion.
-   [x] Require a reason for the request.
-   [x] Record requester identity and request timestamp.
-   [x] Keep the original record visible while its deletion request is
    pending.
-   [x] Show pending deletion requests on the dashboard and in relevant
    lists.
-   [x] Allow eligible members to approve or reject a request.
-   [x] Prevent the requester from approving their own request.
-   [x] Record approver/rejecter identity, decision timestamp, and
    optional decision reason.
-   [x] Notify or clearly inform the requester of the decision.
    _(In-app notifications + dashboard.)_
-   [x] Archive records after approval instead of immediately
    hard-deleting them.
-   [x] Preserve related audit history and attachments according to the
    retention policy.
-   [x] Apply the same workflow to expenses, budget entries, and
    suggested purchases.
-   [x] Decide and implement the policy for whether one or multiple
    approvals are required. _(One approval.)_
-   [x] Define how rejected requests can be viewed and whether a new
    request may be submitted. _(Visible under Deletion requests →
    Rejected and on the record; a new request is allowed.)_
-   [x] Add tests for requester restrictions, approval, rejection,
    repeated actions, and balance effects.

## 9. Suggested Purchases

-   [x] Create a dedicated Suggested Purchases section separate from
    actual expenses.
-   [x] Require a product/item name and expected price.
    _(Changed 2026-10-19 at user request: only the name is required; price
    is optional.)_
-   [x] Allow an optional target date, description/notes, and product
    URL.
-   [x] Automatically record creator identity and server creation
    timestamp.
-   [x] Automatically record last editor and server modification
    timestamp.
-   [x] Define and implement statuses: Suggested, Approved, Planned,
    Purchased, and Cancelled. _(Approved requires approver role.
    2026-10-19: Suggestions are now a checklist — ticking an item marks it
    Done (= Purchased) without needing an expense; unticking restores the
    previous status. Linking an expense is optional. Migration 3.)_
-   [x] Build a list with search, filtering, sorting, and status
    visibility. _(Checklist view with quick add, search, To get / Done /
    Cancelled sections; table view keeps filters and sorting.)_
-   [x] Display the estimated total for active suggestions.
-   [x] Keep suggested-purchase amounts separate from actual expenses
    and available balance.
-   [x] If reserved funds are supported, display them separately and
    define their effect explicitly. _(Not supported: informational
    only.)_
-   [x] Allow authorized users to edit a suggestion and record edits in
    the audit history.
-   [x] Route suggested-purchase deletion through the
    request-and-approval workflow.
-   [x] Support linking a purchased suggestion to the actual expense
    record.
-   [x] When linking a purchase to an expense, avoid counting the same
    purchase twice.
-   [x] Allow actual receipts to be attached to the linked expense.
-   [x] Add tests for statuses, totals, permissions, deletion workflow,
    and purchase-to-expense linking.

## 10. Dashboard and reporting

-   [x] Show total approved budget money received.
-   [x] Show total active expenses.
-   [x] Show available balance using the agreed financial rules.
-   [x] Show budget utilization as a percentage where meaningful.
-   [x] Show the number of pending deletion requests.
-   [x] Provide quick actions for adding a budget entry, adding an
    expense, and suggesting a purchase.
-   [x] Show recent activity where useful and permitted.
-   [x] Keep estimated suggested-purchase totals separate from actual
    financial totals.
-   [x] Clearly label totals and explain what is included or excluded.
-   [x] Recalculate totals reliably after create, edit, approval,
    rejection, and archival actions.
-   [x] Add tests for dashboard calculations and permission-filtered
    data.

## 11. User experience and accessibility

-   [ ] Create responsive layouts for mobile, tablet, and desktop.
    _(Implemented with CSS breakpoints; not yet visually checked on real
    devices.)_
-   [x] Provide clear loading, empty, success, and error states.
-   [x] Validate forms and display actionable error messages.
-   [x] Confirm destructive or approval actions before submission where
    appropriate.
-   [x] Prevent duplicate submissions and show progress during
    uploads/actions.
-   [ ] Use accessible labels, keyboard navigation, focus states, and
    sufficient contrast. _(Labels, focus styles, skip link, dialogs and
    ARIA implemented; contrast and screen-reader pass not yet audited.)_
-   [x] Format dates and currency consistently.
-   [x] Make pending and completed workflow statuses easy to
    distinguish.
-   [x] Ensure long lists remain usable with pagination or an
    appropriate loading strategy.
-   [ ] Test the main workflows on mobile and desktop screen sizes.

## 12. Security, privacy, backups, and reliability

-   [x] Validate all important input on the server.
-   [x] Use parameterized database access or the framework's safe query
    mechanisms. _(All values bound; sort columns whitelisted.)_
-   [x] Protect against unauthorized record access and insecure direct
    object references.
-   [x] Apply appropriate CSRF, XSS, and other framework-relevant
    protections. _(CSRF token, JSON-only, Origin check, CSP, no
    innerHTML, nosniff.)_
-   [x] Rate-limit sensitive or abuse-prone endpoints where appropriate.
-   [x] Keep secrets in environment variables or a secret manager, never
    in source control.
-   [x] Review database access rules and file-storage permissions.
-   [x] Avoid logging passwords, tokens, or sensitive attachment
    contents.
-   [x] Define data-retention, archival, backup, and recovery policies.
-   [x] Test backup restoration before release. _(Automated round-trip
    test; repeat on the production host before go-live.)_
-   [x] Provide useful server-side error logging without exposing
    internal details to users. _(Error IDs.)_
-   [x] Review dependencies and address relevant security
    vulnerabilities. _(npm audit: 0 on 2026-10-17.)_

## 13. Testing and quality checks

-   [x] Add unit tests for financial calculations and validation.
-   [x] Add integration tests for authentication and authorization.
-   [x] Add tests for group/workspace data isolation.
-   [x] Add tests for budget-entry and expense workflows.
-   [x] Add tests for attachment upload, preview, download, and access
    control.
-   [x] Add tests for audit-history completeness and integrity.
-   [x] Add tests for deletion-request approval and rejection.
-   [x] Add tests for Suggested Purchases and purchase-to-expense
    linking.
-   [x] Add tests for dashboard totals and balance calculations.
-   [ ] Add end-to-end tests for the main user journeys. _(API-level
    journey test exists; automated real-browser E2E not yet.)_
-   [x] Run formatting, linting, type checks, and the complete test
    suite. _(ESLint + tests; plain JS, so no type checker.)_
-   [x] Fix regressions and document any known limitations.

## 14. Deployment and release readiness

-   [x] Document required environment variables without including their
    secret values.
-   [ ] Configure production authentication, database, and private file
    storage. _(Code, `render.yaml` and step-by-step README instructions are
    ready; waiting for the Supabase/Render accounts to be created.)_
-   [x] Apply database migrations safely. _(Versioned, transactional,
    automatic at start-up.)_
-   [ ] Configure production logging, monitoring, and error reporting.
    _(Request/error logs go to Render's log viewer; daily keep-alive
    workflow fails visibly if the app is down. No alerting service yet.)_
-   [ ] Verify HTTPS and secure cookie/session settings where
    applicable.
-   [ ] Confirm backup and recovery procedures work. _(Backup/restore and
    SQLite import tested automatically on PGlite and real Postgres; still to
    run once against the live Supabase project.)_
-   [ ] Verify authorization rules in the production configuration.
-   [ ] Run a release smoke test for sign-in, budget entries, expenses,
    attachments, approvals, and suggested purchases.
-   [x] Document deployment and rollback procedures.
-   [x] Update `README.md` with the final architecture, setup, tests,
    and deployment steps.

## 15. Definition of done

A feature is complete only when:

-   [ ] Its behavior matches the documented requirements.
-   [ ] Authorization and validation are enforced on the server.
-   [ ] Relevant audit events are recorded.
-   [ ] Loading, empty, success, and error states are handled.
-   [ ] Relevant automated tests pass.
-   [ ] No existing functionality has regressed.
-   [ ] Documentation and this checklist are updated.

_(Template checklist applied per feature; left unticked intentionally.)_

## Architecture and implementation notes

Add confirmed decisions here. Include the date and rationale when
useful.

-   **Framework:** Node.js 22 + Express 4, plain-JS SPA frontend
    (2026-10-17, approved plan; no build step, minimal dependencies).
-   **Database:** Postgres — Supabase in production (`pg`), PGlite locally
    and in tests (2026-10-19; moved from SQLite because Render's free tier has
    no persistent disk. Existing SQLite data imports with
    `npm run import-sqlite`). Row Level Security enabled on all tables.
-   **Authentication:** Built-in name + password, scrypt, server-side
    sessions (2026-10-17; user asked for name-only sign-in, no email).
-   **Private file storage:** Private Supabase Storage bucket in production,
    local directory in development; always delivered through the app's
    5-minute signed links.
-   **Deployment target:** Render free web service (single instance, sleeps
    after 15 min idle) + Supabase free project; GitHub Actions runs lint/tests
    on PGlite and Postgres 17, then triggers the Render deploy hook for the
    tested commit; daily keep-alive ping prevents Supabase pausing
    (2026-10-19, user wants a free setup for 2–3 users).
-   **Currency and display locale:** One currency per group, default
    Philippine peso (PHP); USD/EUR/SEK/GBP/NOK/DKK also allowed. Amounts
    and dates display in the en-PH locale (e.g. ₱1,234.50). Input accepts
    "1,500" and "1,234.50" (comma = thousands separator when followed by
    groups of three digits). (2026-10-17, user request; migration 2.)
-   **Deletion approval policy:** One approval by an approver/admin other
    than the requester; records locked from editing while pending;
    approved → archived.
-   **Record and attachment retention policy:** Keep indefinitely; no hard
    deletes through the app; removed/replaced files retained.

## Open questions

Resolve these before relying on assumptions in production.

-   [x] Which framework and hosting platform will be used? _(Render +
    Supabase, see notes.)_
-   [x] Which database and authentication provider will be used?
-   [x] Is each workspace limited to one group, or can a user belong to
    multiple groups? _(Multiple groups.)_
-   [x] Which roles can create/edit records, and who can approve
    deletion requests?
-   [x] Should deletion require one approver or multiple approvers?
    _(One.)_
-   [x] Should a requester be allowed to edit a record while its
    deletion request is pending? _(No; nobody can edit while pending.)_
-   [x] Which currency or currencies must be supported?
-   [x] Should pending-deletion expenses continue to count toward the
    available balance until approval? _(Yes.)_
-   [x] Should Suggested Purchases reserve funds, or remain
    informational only? _(Informational only.)_
-   [x] What file-size limits and retention periods should apply?
    _(10 MB/file, 10 files/upload; retain indefinitely.)_
-   [ ] Supabase free has no automatic backups: who runs `npm run backup`
    and how often?
-   [ ] What notifications are needed for invitations, deletion
    decisions, and other events? _(Only in-app deletion-decision
    notifications today; email/push undecided.)_
-   [ ] How should forgotten passwords be handled without email?
-   [ ] When an expense linked to a suggestion is archived, should the
    suggestion revert from Purchased? _(Currently it stays Purchased and
    shows the linked expense as archived.)_

------------------------------------------------------------------------

**Maintenance reminder:** Update this file whenever requirements change.
Mark tasks complete only after verification, and add new checklist items
rather than silently dropping requirements.
