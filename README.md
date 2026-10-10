# RegCheck UZ

Starter monorepo for the RegCheck UZ frontend and backend. Document ingestion is
implemented alongside lexical policy evidence retrieval, an MVP async assessment/review API, and an authenticated organization application shell.

## Stack

- Frontend: React, TypeScript, Vite, Ant Design
- Backend: Node.js, TypeScript, Fastify
- Database and job queue: PostgreSQL, `pg` and `pg-boss`
- Document extraction: `@firecrawl/pdf-inspector` (PDF), `mammoth` (DOCX), UTF-8
  text extraction (TXT)
- Local containers: Docker Compose

## Run locally with Docker

```sh
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:5173
- API health check: http://localhost:3000/api/health
- API reference: http://localhost:3000/docs
- OpenAPI JSON: http://localhost:3000/docs/json
- PostgreSQL: localhost:5432
- Document API: `POST /api/documents`, `POST /api/documents/from-url`, `GET /api/documents/:id`,
  `GET /api/documents`, `GET /api/documents/:id`, `GET /api/documents/:id/sections`,
  `POST /api/documents/compare`

Uploaded files and extracted sections are stored in Docker-managed volumes and
PostgreSQL. The API enqueues extraction; a separate worker processes the job.

## Organization workspace

Open the web app and choose **Create a workspace**. Use a fictional organization,
an email identifier, and a unique demo password (at least 6 characters). Each
registration creates one organization and its owner account; there is no email
verification, account recovery, or team invitations yet.

The full-width application has an overview, policy management, regulatory library,
assessment history, review history, and organization settings. The regulatory
updates screen displays monitored sources, successful/failed check times, candidate
updates, old/new legal excerpts, and human source-review controls.
Navigation uses protected React Router URLs: `/dashboard`, `/policies`,
`/regulations`, `/assessments`, `/assessments/:id`, `/findings/:id`, `/updates`,
`/reviews`, and `/settings`. Direct links, reloads, and browser history preserve
the page. Nginx uses an SPA fallback for deployed deep links.

The assessment screen checks selected policy snapshots against the imported
regulatory corpus, with no manual prompt or requirement form. It shows prominent
conflict/missing-evidence counts, filterable findings, and a dedicated side-by-side
regulation/policy evidence page with suggested actions and reviewer history.

All workspace API routes now require `Authorization: Bearer <token>`. Obtain a
token from `POST /api/auth/register` or `POST /api/auth/login`. Registration fields
are `email`, `password`, `name`, and `organization_type` (`commercial_bank`,
`payment_organization`, `electronic_money_provider`, or `other_fintech`). Login
requires `email` and `password`. `GET /api/auth/me` verifies identity;
`POST /api/auth/logout` revokes the current session. Health and authentication
entry routes remain public; Swagger describes the API without exposing data.

Passwords use salted scrypt hashes; session tokens are random, stored hashed on
the server, expire after 24 hours, and are held in browser sessionStorage. HTTPS
is required outside localhost. API rate limiting is disabled by default for development.
Set `RATE_LIMIT_ENABLED=true` before exposing the API publicly to enable global,
login/register, and monitoring route limits; limits are process-local, not distributed.
This does not disable external provider quota/rate limits. Configure browser origins with
`CORS_ORIGINS` (comma-separated, defaults to localhost:5173 and 127.0.0.1:5173).

New policies, assessments, version groups, and import batches are organization-owned.
The server denies cross-organization reads, searches, assessments, reviews, and
version-group writes, including requests using another organization's IDs. Existing
unassigned policy documents/assessments are preserved but hidden: upload the sample
policy into your new workspace instead of automatically claiming historical data.
Existing unassigned regulation/guidance imports remain a shared, read-only reference
library. New imports belong to the signed-in organization.

This is MVP authorization, not production enterprise security: there are no
granular roles, SSO, MFA, malware screening, password recovery, or encrypted-file
controls. Continue using synthetic policies only.
Uploads, remote PDFs, and supported Lex.uz legal pages are queued for background
extraction. Uploads are limited to 5 MB; remote documents default to a separate
20 MB limit. Remote fetching is
restricted to the hosts in `REMOTE_DOCUMENT_HOSTS` (default: Lex.uz and CBU.uz).
Scanned PDF pages are reported as needing OCR; OCR is not enabled yet. The
example Lex.uz PDF at `/pdffile/4575788` downloads successfully but has no
extractable text, so it is currently marked unsupported until OCR is added. The
corresponding Lex.uz HTML document page at `/docs/4575788` is text-extractable
and retains stable Lex element references.

Each fetched regulation snapshot retains its original HTML and verbatim extracted
text alongside normalized text, hashes, and article hierarchy. Compare two
completed fetches of the same Lex.uz regulation with `POST /api/documents/compare`,
providing `previous_document_id` and `current_document_id`. The initial matcher
uses Lex element IDs, then falls back to article-number and text similarity when
IDs change. Heuristic matches should be reviewed, especially for major rewrites
or repeated similar paragraphs.

### Document versions

`document_id` remains the immutable snapshot/version ID used by status, sections,
and comparison endpoints. `document_group_id` identifies the logical document.
Existing records are grouped automatically at startup without changing their IDs
or files. Lex.uz `/docs/{id}` and `/pdffile/{id}` imports group by Lex document ID
and document type; other imports create a new group unless one is supplied.

- `GET /api/document-groups`: list logical documents and version counts.
- `GET /api/document-groups/{id}/versions`: list their stored snapshots.
- `GET /api/documents`: list snapshots with `document_type`, `source_type`,
  `processing_status`, `document_group_id`, and `q` filters; results are paginated
  with `limit` (1–100, default 20) and `offset`.
- The supported `document_type` enum is `policy`, `regulation`, `guidance`,
  `procedure`, or `other`.
- `POST /api/documents/from-url/versions` accepts a Lex.uz `/docs/{id}` URL,
  discovers the current document and listed `ONDATE` revisions from the HTML,
  and downloads them asynchronously. Poll `GET /api/document-imports/{import_id}`
  for per-version status and resulting `document_id`s. Compare any two snapshots
  with the existing comparison endpoint.
- Both ingestion endpoints accept optional `document_group_id`, `version_label`,
  and `revision_date` (`YYYY-MM-DD`). For policy uploads, pass the group ID from
  the previous upload to create another version of the same policy.
- Remote imports infer a revision date from Lex.uz's `ONDATE=DD.MM.YYYY` when an
  explicit date is not supplied. This date is source-selection metadata, **not**
  a verified effective date. With no date, the snapshot is labeled by import order.
- Version numbers reflect import order; historical revisions can be imported
  later. Repeated fetches are retained as separate snapshots, even with identical
  content. No fetch automatically becomes an approved legal baseline.

Example historical revision import:

```json
{
  "url": "https://lex.uz/docs/4575788?ONDATE=22.12.2024",
  "document_type": "regulation",
  "declared_language": "ru",
  "version_label": "Revision dated 22 December 2024"
}
```

Example remote import:

```sh
curl -X POST http://localhost:3000/api/documents/from-url \
  -H 'Authorization: Bearer <your-session-token>' \
  -H 'content-type: application/json' \
  -d '{"url":"https://lex.uz/docs/4575788","document_type":"regulation","declared_language":"ru"}'
```

## Policy evidence search

`POST /api/policy-evidence/search` searches extracted sections of up to five selected
policy/procedure snapshots. Select IDs from `GET /api/documents`; extraction must
be `COMPLETED` or `COMPLETED_WITH_WARNINGS`.

```json
{
  "query": "customer identification records",
  "policy_document_ids": ["<completed-policy-document-uuid>"],
  "limit": 5
}
```

Returns ranked passages with original text, section/document IDs, snapshot hash,
version label, and page/section references. Missing references remain null. This
is PostgreSQL lexical full-text search, not an AI assessment: Russian and Uzbek
tokens are supported, but translations, synonyms, and inflections are not matched
automatically. The first 64 distinct query tokens are used. Empty results do not
prove a violation, and relevance scores are not legal confidence scores.

Workspace authentication and ownership checks are enforced by the API. Use
synthetic data only; enterprise security controls are still out of scope.

## MVP AI assessment

### Small development corpus

The demo database can be pruned to one current snapshot each of Lex.uz documents
4575788, 284542, 4396428, and 4590456. Stop API/worker first, then preview with:

```sh
node --env-file-if-exists=.env --import tsx apps/api/scripts/prune-demo-corpus.ts
```

Add `--apply` to perform the **destructive development reset**. It preserves
accounts, organization settings, internal policies, and retained extraction caches;
it removes other regulatory/historical snapshots and clears assessment/review,
monitoring, and old import history. Raw storage files are not deleted. This is not
a production migration and does not limit what can be imported afterward.

The current reduced demo corpus has 279 cached draft requirements rather than 835.

Configure `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the API **and worker**
environment (`gpt-6-luna` is the default). `OPENAI_REASONING_EFFORT=none` avoids
default reasoning overhead; GPT-4.1 Mini remains supported. Keep the key server-side. Users select
policies; the backend chooses the corpus and derives requirements. Use synthetic
organization policies only. Regulatory interpretations are labelled **AI drafts**,
not verified legal requirements.

Start an async assessment with `POST /api/assessments`:

```json
{
  "policy_document_ids": ["<completed-policy-document-uuid>"]
}
```

The API returns `202` and an `assessment_id`. Poll `GET /api/assessments/{id}`
for status and saved findings. `GET /api/assessment-corpus` previews the selected
sources. Each run pins policy/regulation IDs, hashes, and the organization profile.
The selector chooses one completely extracted snapshot per regulation group:
source-reviewed monitoring updates take precedence; otherwise it uses the latest
undated observed import. Historical revisions, incomplete extraction, and pending
or rejected monitor snapshots are not implicitly treated as current legal rules.
This is a technical snapshot choice, not verification of legal effective dates.
Snapshots with no substantive legal sections (for example, Lex.uz language
placeholders containing only a title and signature) are excluded with a coverage
warning, not sent to obligation extraction. New imports of such pages are rejected
with the original-language URL when available. For regulation 3229, use
`https://lex.uz/docs/4790646`; its Russian page `/docs/4790648` is a placeholder.
The development corpus's five known language placeholders can be repaired with
`node --env-file-if-exists=.env --import tsx apps/api/scripts/repair-language-sources.ts`.
This verifies the official page's original-language link, adds immutable Uzbek
snapshots to the existing groups, registers verified URL aliases, and corrects
monitoring URLs/baselines. It preserves old snapshots and does not approve legal
interpretations or effective dates. This is an administrative script that writes
to the configured database/storage, not a public API; reruns reuse repaired snapshots.

The worker scans **all legal sections of every selected snapshot** in bounded,
overlapping batches. It extracts atomic duties with exact original-language legal
citations, retaining qualifications. The model selects supplied source IDs; the
server materializes original quotations, preventing rewritten AI quotations from
causing exact-match failures. Invalid source IDs/legacy excerpts get up to three
validation-repair attempts. Batch-local IDs are short and restricted by a dynamic
schema enum to the sources actually present; persisted evidence retains original
section UUIDs. Responses, batch indexes, and validation errors are
retained server-side in `regulatory_extraction_attempts` for diagnosis. Invalid
citations are never silently accepted. Successful draft obligations are cached per snapshot,
model, and extractor version; cached citations are rechecked before reuse. Compatible
v3 extraction caches are reused across model changes, so switching the comparison
model does not force a full regulatory re-extraction. `OPENAI_EXTRACTION_MODEL`
optionally overrides the extraction model separately.

Each obligation is compared to retrieved policy passages and the captured entity
type/activities. Extraction also produces multilingual search hints; lexical
retrieval can still miss relevant evidence. Policy citations are checked against
stored text, unsupported conclusions are downgraded to `REQUIRES_REVIEW`, and
uncertain applicability cannot be shown as an actionable conflict. Explicitly
excluded requirements receive `NOT_APPLICABLE` findings.

The first full-corpus run can take several minutes and incur many API calls;
subsequent runs reuse the extraction cache. Comparisons run with bounded
parallelism (`ASSESSMENT_COMPARISON_CONCURRENCY`, default 2, range 1–5). Use 1 if
your provider tier has tight rate limits. Real processing stages/batch counts are
persisted. Extraction failure in one source does not stop checks for other sources;
the exact source, URL, batch, and error are included in coverage warnings. Runs
with unresolved extraction failures retain other findings but remain explicitly
incomplete (`FAILED`), never a successful full-coverage assessment.
Comparisons batch up to eight requirements per request (`ASSESSMENT_BATCH_SIZE`,
1–15), with a 50K-character batching target and deduplicated policy passages.
Applicability is evaluated using the organization profile; unknown scope is kept
for review rather than silently excluded. Partial relevant policy evidence can
support a missing-element finding; unrelated text must not be cited.

Unchanged validated findings are reused within the organization, including valid
partial results from failed/cancelled runs. Fingerprints include model/prompt,
regulatory requirement and evidence, policy inputs, and business profile. Supported,
conflicting, and explicitly inapplicable findings can reuse unchanged retrieved
evidence across policy versions; missing/uncertain findings conservatively invalidate
when any selected policy hash changes. Reused findings preserve reviewer decisions
and source review history. Model changes invalidate comparison results, not compatible
regulatory extraction caches.

For a new regulatory snapshot, citation-backed unchanged obligations are rebased
to exact matching new source sections; only changed sections, local neighbors, and
known citation dependencies are re-extracted. Detected definition/scope changes
trigger a conservative rescan of that regulation. This is not a complete semantic
dependency graph: uncited cross-clause/cross-law effects still need qualified review.

`POST /api/assessments/{id}/cancel` marks queued/processing runs `CANCELLED`, cancels
the queue job, and aborts active provider requests when the worker observes the change.
UI cancellation is available in the history and detail views. Saved findings remain
partial; already issued provider requests may still be billed. The API rejects a
second active run in the workspace. New/changed/resolved/reused documentary findings
are shown relative to the prior completed baseline. Findings removed from scope are
reported separately, never automatically called legally resolved.

Provider HTTP 429/5xx (including 520), network errors, and timeouts get up to three
attempts with backoff. Reported tokens, API attempts, and estimated costs are stored
per assessment and visible in the UI. `ASSESSMENT_MAX_COST_USD=2` is a budget guard
checked before/during requests, not an absolute provider-side spending cap; in-flight
and unpriced calls may add charges. Prepared batches show a rough cost estimate,
explicitly excluding extraction/retries and based on assumed output length.
No prompts, hardcoded final findings, or fabricated progress are used.

Scanning the whole selected corpus does **not** guarantee the model found every
duty or prove the corpus is legally complete/current. Effective dates and draft
interpretations need qualified review. No matching policy passage establishes only
missing documentary evidence, never proof of a violation.

Record a reviewer decision with `POST /api/findings/{id}/review`:

```json
{ "decision": "NEEDS_EVIDENCE", "comment": "Check another procedure." }
```

Assessment states are `QUEUED`, `PROCESSING`, `COMPLETED`, and `FAILED`.
Findings have a separate `PENDING`, `CONFIRMED`, `REJECTED`, or `NEEDS_EVIDENCE`
review state. Reviewer identity is taken from the authenticated account, not from
a caller-supplied name. Do not use real confidential documents or treat model output
as legal advice.

The web app provides policy upload/selection, corpus preview, real processing
status, findings grouped by concern, and human review. Conflicts and missing
evidence are prominent, with an attention-first table and deep-linkable details.
`GET /api/findings/{id}` returns both regulatory and policy evidence; technical
hashes and model details are tucked behind expandable panels. A verified obligation
approval library is not implemented yet. After an organization has a completed
baseline, new policy/procedure versions and approved monitored regulation updates
queue incremental impact assessments. Unreviewed regulatory candidates do not.
Impact jobs defer while a run is active, pin current snapshots, and are idempotent
per organization/document event. `AUTO_ASSESS_UPDATES=false` disables these triggers.
First uploads do not automatically incur a full baseline assessment.

Example synthetic policy: `data/synthetic/demo-bank-policy.txt`. It is intentionally
incomplete for testing; do not use it operationally or treat it as legal guidance.

## Scheduled regulatory monitoring

The existing worker installs a durable `pg-boss` cron schedule (`*/5 * * * *`, UTC).
Every dispatch discovers supported official URLs from completed regulation imports
and queues sources whose check time is due. Each source is checked **hourly by
default**, with up to five minutes of dispatch delay plus queue/download time;
checks are staggered and duplicate requests are coalesced. The worker must stay
running. Multiple worker processes use source locks to avoid duplicate downloads.

Configuration (API and worker):

```dotenv
REGULATORY_MONITOR_ENABLED=true
REGULATORY_CHECK_INTERVAL_MINUTES=60
REGULATORY_REVIEWER_EMAILS=your-reviewer-account@example.com
```

The interval applies to newly discovered sources (15-minute minimum); existing
source intervals can be changed through `PATCH /api/regulatory-sources/{id}`.
Set `REGULATORY_MONITOR_ENABLED=false` and restart the worker to remove the schedule.
Disable individual sources in the UI if their access/reuse rules do not permit
automated retrieval. Verify terms for your intended use; do not bypass access
controls. The existing HTTPS/host/DNS/redirect/size/time safeguards also apply.

Lex.uz `/docs/{id}` and `/pdffile/{id}` imports resolve to one current legal HTML
page; `ONDATE`/`ONDATE2` revision selectors are removed. Other supported sources
are allowlisted PDF URLs. Historical snapshots are retained but are not themselves
monitored. This checks the configured corpus, not all regulatory news or new laws.

Checks compare normalized legal-text hashes, ignoring navigation, whitespace, and
regenerated clause IDs. A changed page creates an immutable extracted snapshot and
`PENDING_REVIEW` candidate with old/new passages. No-change checks do not create
duplicate snapshots. Extraction/fetch failures and unsupported scanned PDFs remain
visible; partial extraction is not treated as a legal removal.

On the first successful check, a source without a current stored snapshot gets an
observed baseline; this is **not** legal verification. Candidate acceptance records
the authenticated reviewer's note and accepted snapshot pointer without modifying
old documents or assessment evidence. Legal effective dates are not inferred or
automatically certified. Approved updates queue incremental policy-impact assessments
only for organizations with an existing completed baseline covering the source group.

Organization sources are private to their owner. Shared corpus sources are readable
by signed-in organizations; configuration/review requires an account email explicitly
listed in `REGULATORY_REVIEWER_EMAILS` on the API. Set this to your actual sign-in
email if you want to review the existing shared corpus. No reviewer is granted this
permission automatically.

APIs: `GET /api/regulatory-sources`, `POST /api/regulatory-sources/discover`,
`POST /api/regulatory-sources/{id}/check`, `GET /api/regulatory-sources/{id}/checks`,
`GET /api/regulatory-updates`, and `POST /api/regulatory-updates/{id}/review`.

## Run the apps without Docker

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

The frontend runs on port 5173 and the API on port 3000. Start PostgreSQL in the
background first with `docker compose up -d db`, then run `npm run dev` to start
the frontend, API, and extraction worker in watch mode.

## Checks

```sh
npm run typecheck
npm run build
```

API regression tests: `npm run test -w @regcheck/api`.
Frontend session regression tests: `npm run test -w @regcheck/web`.
To also test retrieval and organization isolation against running local PostgreSQL:

```sh
RUN_DB_TESTS=1 node --env-file-if-exists=.env --import tsx --test apps/api/test/*.test.ts
```

The retrieval test uses temporary tables and rollback. The auth integration test
creates two synthetic organizations and uploads a test policy, checks ID-based
access attacks, and removes its own accounts/files/records afterwards. Existing
application documents are not reassigned or removed.
The monitoring integration test uses synthetic legal-page responses to verify
baseline/unchanged/changed/failed states, immutable excerpts, candidate approval,
and cross-organization access. It deletes only its own synthetic fixtures.
