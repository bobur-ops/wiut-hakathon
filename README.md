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
updates screen explicitly reports that scheduled monitoring is **not enabled**.
The assessment screen remains a single-requirement comparison preview; automatic
corpus-wide assessment is the next implementation milestone.

All workspace API routes now require `Authorization: Bearer <token>`. Obtain a
token from `POST /api/auth/register` or `POST /api/auth/login`. Registration fields
are `email`, `password`, `name`, and `organization_type` (`commercial_bank`,
`payment_organization`, `electronic_money_provider`, or `other_fintech`). Login
requires `email` and `password`. `GET /api/auth/me` verifies identity;
`POST /api/auth/logout` revokes the current session. Health and authentication
entry routes remain public; Swagger describes the API without exposing data.

Passwords use salted scrypt hashes; session tokens are random, stored hashed on
the server, expire after 24 hours, and are held in browser sessionStorage. HTTPS
is required outside localhost. Rate limits apply globally and to login/register;
limits are process-local, not distributed. Configure browser origins with
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

Configure `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the API **and worker**
environment (`gpt-4.1-mini` is the default). Keep the key server-side. The first
assessment slice accepts caller-supplied obligations so the team can demonstrate
the workflow before building a verified regulatory corpus. These inputs are not
verified legal requirements. Use synthetic documents only.

Start an async assessment with `POST /api/assessments`:

```json
{
  "policy_document_ids": ["<completed-policy-document-uuid>"],
  "obligations": [{
    "id": "demo-record-retention",
    "citation": "Synthetic demo obligation — not legal text",
    "requirement": "Describe how customer records are retained and made available for review."
  }]
}
```

The API returns `202` and an `assessment_id`. Poll `GET /api/assessments/{id}`
for status and saved findings. The worker retrieves passages, calls OpenAI with
structured output, and verifies cited section IDs and exact excerpts against
retrieved text. Invalid citations are dropped and substantive findings are
downgraded to `REQUIRES_REVIEW`. Each finding includes snapshot hashes and source
references. No matching passage is labelled only as missing evidence, never as
proof of a violation.

Record a reviewer decision with `POST /api/findings/{id}/review`:

```json
{ "decision": "NEEDS_EVIDENCE", "comment": "Check another procedure." }
```

Assessment states are `QUEUED`, `PROCESSING`, `COMPLETED`, and `FAILED`.
Findings have a separate `PENDING`, `CONFIRMED`, `REJECTED`, or `NEEDS_EVIDENCE`
review state. Reviewer identity is taken from the authenticated account, not from
a caller-supplied name. Do not use real confidential documents or treat model output
as legal advice.

The web app provides policy upload/selection, extraction readiness, a synthetic
requirement form, queued assessment polling, citation display, and human review
controls. Use the sample obligation as a workflow smoke test only, not as a real
regulatory requirement. The UI does not yet provide a verified obligation library.

Example synthetic policy: `data/synthetic/demo-bank-policy.txt`. It is intentionally
incomplete for testing; do not use it operationally or treat it as legal guidance.

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
