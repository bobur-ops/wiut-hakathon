# RegCheck UZ — Development Progress

This file tracks completed work, current scope, decisions, and the next planned steps.

## Product direction

- AI-assisted regulatory compliance platform for regulated financial institutions and fintech businesses in Uzbekistan.
- Cover multiple fintech and financial-services domains, including payments, banking, e-money, licensing, consumer protection, security, and AML/KYC. Keep the MVP corpus curated and disclose coverage rather than claiming completeness.
- Findings must be evidence-backed and reviewed by a human; the product must not claim to certify legal compliance.
- Regulatory monitoring is planned as a narrow MVP feature: check an allowlist of official sources, create candidate updates, and require human verification before a new regulation version becomes current.

## Technology decisions

- Frontend: React, TypeScript, Vite, Ant Design (no Next.js).
- Backend: Node.js, TypeScript, Fastify.
- Database: PostgreSQL.
- Background jobs: `pg-boss`, using PostgreSQL rather than adding Redis.
- PDF extraction: `@firecrawl/pdf-inspector`; retain per-page Markdown and report pages needing OCR.
- Lex.uz pages: `cheerio` extracts legal content from supported `/docs/{id}` HTML pages and retains stable element references.
- DOCX extraction: Mammoth.
- TXT extraction: UTF-8 text processing.
- Docker Compose: PostgreSQL and production-preview containers; development servers run on the host in watch mode.
- API documentation: OpenAPI generated from Fastify route schemas and served with Swagger UI.

## Completed

### Application foundation

- Created npm workspaces for `apps/web` and `apps/api`.
- Added React/TypeScript/Vite/Ant Design frontend starter.
- Added Fastify/TypeScript API starter and `/api/health` endpoint.
- Added Dockerfiles and Docker Compose services for frontend, API, worker, and PostgreSQL.
- Added `.env.example` and setup instructions in `README.md`.

### Document ingestion backend

- Added `POST /api/documents` for PDF, DOCX, and TXT uploads.
- Enforced one-file upload, 5 MB size limit, allowed extensions/MIME types, empty-file checks, and basic file-signature checks.
- Stored original uploads in a private local/Docker volume and recorded SHA-256 content hashes.
- Added PostgreSQL tables for documents and extracted sections; migrations run at API/worker startup.
- Added persistent asynchronous extraction jobs using `pg-boss`.
- Added a worker process that extracts documents, stores sections, and updates processing status/errors.
- Added `GET /api/documents/:id` for status/metadata and `GET /api/documents/:id/sections` for extracted content.
- Added `POST /api/documents/from-url` for remote PDF retrieval through a strict HTTPS hostname allowlist; responses are size-limited, time-limited, redirect-checked, DNS/IP-checked, content-validated, hashed, stored, and sent through the same background extraction queue as uploads.
- Extended `POST /api/documents/from-url` to fetch supported Lex.uz `/docs/{id}` HTML pages. Extraction targets the `#divCont` legal body, skips navigation and controls, and stores headings, legal text, title/language metadata, and stable Lex element IDs.
- Added normalized text snapshots and hashes while retaining the original fetched file and verbatim extracted text. Lex.uz sections now carry document-metadata/title/chapter/article/paragraph types and parent links; uploaded PDFs retain page-level evidence references.
- Added `POST /api/documents/compare` for completed Lex.uz HTML regulation snapshots of the same document. It first matches stable Lex element IDs, then falls back to article-number and text-similarity matching when IDs change, reporting modified text separately from additions/removals.
- Fixed fallback matching to reserve exact text matches first and accept only reciprocal unique-best similarity matches across remaining candidates. Ambiguous unmatched elements and heuristic modifications carry `needs_review` in the API response.
- Stable-ID comparisons now detect paragraph moves between numbered articles without treating regenerated parent IDs alone as changes.
- Multi-page TXT evidence references include page and paragraph numbers to prevent duplicate citations.
- Added logical `document_groups` above immutable document snapshots. Existing snapshot IDs/files are preserved, and Lex.uz imports group automatically by official document ID and document type.
- Added per-snapshot version numbers (import order), labels, and optional revision dates; Lex.uz `ONDATE` supplies the requested revision date when no explicit date is provided. Revision dates are not verified effective dates or approval status.
- Added `GET /api/document-groups` and `GET /api/document-groups/:id/versions`; both ingestion endpoints accept group ID, version label, and revision date. Internal-policy uploads can explicitly join an existing policy group.
- Added paginated `GET /api/documents` with document type, source type, processing status, logical group, and text filters. Document type accepts the explicit enum `policy`, `regulation`, `guidance`, `procedure`, or `other`; Swagger now exposes enums for document, section, import-item, and batch statuses/types.
- Added `POST /api/documents/from-url/versions`, which parses the Lex.uz revision links (accepting `ONDATE`, not `ONDATE2` compare links), creates an asynchronous import batch, and queues the current version plus every listed historical revision. Poll `GET /api/document-imports/:id` for download/extraction outcomes and snapshot IDs.
- Bulk version discovery for Law 4575788 found six dated `ONDATE` revisions plus the current version; `ONDATE2` links are intentionally skipped because they are comparison UI links, not the version selector.
- Imported all seven discovered snapshots for Law 4575788 into the local database and verified extraction completed for each. The bulk job initially rejected the null revision date on the current snapshot; fixed null handling and linked the separately completed current snapshot back into the batch. Batch status is now `COMPLETED`.
- Imported the user's additional regulatory corpus: 12 Lex.uz documents and 58 current/historical snapshots, all downloaded and extracted with `COMPLETED` status. Lex IDs: 284542, 4396428, 5960609, 5972413, 6213428, 6234906, 4590456, 6461368, 6468758, 4803931, 4912275, 4790648.
- Four requested source URLs returned HTTP 404 and were not imported: https://lex.uz/docs/4878144, https://lex.uz/docs/4973347, https://lex.uz/docs/6489389, https://lex.uz/docs/6408104. Replacement URLs are needed.
- Serialized migration execution and per-group version allocation to avoid concurrent startup/import numbering races. Applied migration to the local database: three existing snapshots now belong to one logical document.
- Added remote source provenance (`source_type`, `source_url`, `retrieved_at`) to document records. Local uploads are limited to 5 MB; trusted remote documents default to a separately configurable 20 MB limit (`REMOTE_DOCUMENT_MAX_BYTES`).
- Added Swagger UI at `/docs` and OpenAPI JSON at `/docs/json`.
- Added page-level source references for PDF sections. DOCX/TXT sections currently retain paragraph or section order; finer-grained structural references can be improved later.
- Scanned/image-only PDFs are not OCR-processed; extraction reports unsupported/no-text status or page warnings.
- Updated the root `npm run dev` command to start frontend, API, and worker in watch mode and load `.env` when present.

### Policy evidence retrieval — MVP checkpoint

- Added `POST /api/policy-evidence/search` for PostgreSQL full-text retrieval over up to five selected policy/procedure snapshots, with a GIN search index.
- Returns ranked original passages, section/document IDs, snapshot hashes/version labels, and page/source references. Retrieval does not generate findings or claim legal confidence.
- Rejects missing documents, non-policy/procedure types, and unfinished extraction. Empty matches remain empty and explicitly do not establish a violation.
- Unicode tokenization handles Russian and Uzbek text; matching is lexical, not semantic or cross-language. Queries use the first 64 distinct tokens.
- Added service/route regression tests and an opt-in PostgreSQL integration test using temporary tables and rollback, leaving real document records unchanged.
- This checkpoint is backend-only; the frontend remains the application starter. Workspace authorization is still absent, so this is for local synthetic data, not an unrestricted public deployment.

### Async AI assessment and review — MVP checkpoint

- Added assessment/finding/review tables and the `compliance-assessment` pg-boss queue.
- `POST /api/assessments` accepts up to five completed policy snapshots and twenty caller-supplied obligations; `GET /api/assessments/:id` returns status and stored findings.
- Added OpenAI Chat Completions structured-output adapter, configurable with server-side `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-4.1-mini`). The API reports a visible unavailable response when the key is absent. No real external model request has been verified in this environment.
- Each obligation is lexically retrieved against selected documents; exact source excerpts and section IDs are checked before persistence. Fabricated/invalid citations are omitted and substantive unsupported findings are downgraded to `REQUIRES_REVIEW`.
- Added `POST /api/findings/:id/review`; decisions are persisted in the finding status and append-only `finding_reviews` rows.
- Obligation input is currently caller-supplied and explicitly unverified. No official verified legal corpus, organization profile, auth/workspace isolation, or assessment UI exists yet. Keep this API on synthetic local/demo data only.

### Minimal assessment UI — MVP checkpoint

- Replaced the frontend starter with a responsive assessment screen connected to the existing document, assessment, and review APIs.
- Users can upload a policy, select extracted policy snapshots, provide a clearly-labelled requirement/citation, launch an assessment, poll status, inspect cited excerpts and source references, and confirm/reject/request evidence with reviewer notes.
- Shows synthetic-only and no-auth warnings, plus honest empty/error/processing states. No hardcoded findings are shown.
- Uses local system font stacks; no external font request is needed.
- This is still a single-workspace demo UI, not a complete organization/document management product.

### Upload smoke test

- Added `data/synthetic/demo-bank-policy.txt`, a fictional policy with intentional test gaps (retention period, recurring risk review, external request deadline). It is explicitly marked synthetic and is not legal text.
- Reproduced the UI's multipart upload `400 Bad Request` with curl. Fastify's JSON-schema validation rejected the multipart body before the route's existing file parser ran; enabled `attachValidation` for that route so multipart parsing and existing field/file checks handle it.
- Retested upload against the running local API: returned `202 Accepted`, and the worker extracted the file successfully (`COMPLETED`, 22 sections).

### Organization workspace and full-page shell — current checkpoint

- Added organization owner registration/login/logout/me endpoints, salted scrypt passwords, hashed random 24-hour sessions, authentication rate limits, and configurable CORS origins.
- Added organization ownership to new policies, assessment runs, logical groups, and import batches. Server access checks deny cross-organization document reads/searches, assessment creation/history, reviewer actions/history, and group writes. Workers preserve ownership through bulk imports and retrieval.
- Legacy unassigned policies and assessments remain stored but are not visible to new accounts. Legacy unassigned regulation/guidance snapshots remain shared read-only references; new imports are organization-scoped.
- Reviewer identity now comes from the signed-in account. Added assessment-history and review-history listing APIs, plus organization profile editing.
- Replaced the centered demo screen with sign-in and a full-width application shell: persistent sidebar, overview with data-backed counts, policy upload/version updates/text viewer, regulatory snapshot browser, assessment history, review history, and settings.
- Regulatory updates explicitly says monitoring is not enabled; assessment remains a clearly-labelled single-requirement preview pending corpus integration. No claim of automatic full-regulation coverage is made.
- Added OpenAI key/model passthrough for both API and worker in Docker Compose.
- Verified typecheck/build and all 21 tests including two-organization PostgreSQL integration: unauthenticated access, foreign policy/sections/groups, foreign retrieval/assessment/reviews, authoritative reviewer identity, and revoked sessions. Tests remove only their own synthetic fixtures.
- This remains MVP security: no invitations, granular roles, MFA, password reset, malware screening, or distributed rate limiting. Use synthetic data only.

## Validation completed

- Fixed reload-time session restoration: temporary connection/server failures no longer delete the saved token. The UI shows a retry action; only an actual rejected session (`401`) clears authentication. Cancelled React lifecycle requests cannot erase a newer session.
- Added frontend session regression coverage for repeated identity requests, network/503 errors, stale 401 responses, and real session expiry. Extended PostgreSQL auth tests to verify repeated authenticated `/api/auth/me` calls remain valid.

- `npm run typecheck` passes.
- Existing eight document regression tests pass, alongside five retrieval service/route tests. An additional opt-in PostgreSQL retrieval integration test verifies ranking, selected-snapshot filtering, multilingual tokens, and evidence references.
- `npm run build` passes (Vite reports a bundle-size advisory for the Ant Design chunk).
- Smoke-tested snapshot comparison: correctly classifies an edited element and a newly added element by stable reference.
- Smoke-tested a regulation paragraph whose Lex element ID changed and whose text was edited: comparison reports one `MODIFIED` change with no false addition/removal.
- `docker compose config` and Docker image builds passed.
- Verified TXT upload → queued background job → completed status → stored sections.
- Verified PDF page extraction produces Markdown and a page reference using a generated sample PDF.
- Verified the exact Lex.uz example PDF downloads successfully (5,794,587 bytes), queues, and is correctly marked `UNSUPPORTED` because it has no extractable text and OCR is not enabled.
- Verified the matching Lex.uz HTML page downloads and completes extraction with 590 sections, Russian text, and `lex-element:*` source references.
- Verified ingestion of a revision-specific Lex.uz URL with `ONDATE=22.12.2024`; the requested URL and retrieval timestamp are persisted with the extracted sections.
- Smoke-checked bulk revision discovery against Lex.uz Law 4575788: found six historical `ONDATE` dates plus the current version, with no `ONDATE2` comparison links included.
- Verified the generated OpenAPI spec includes upload and remote-document routes; a localhost URL is rejected by the remote-fetch allowlist.
- Stopped API, worker, and frontend containers after integration testing. PostgreSQL is left running for local development.

## Known limitations / follow-ups

- `npm audit` reports three moderate advisories through Mammoth's `argparse` → `sprintf-js` dependency chain. The automated suggested fix downgrades Mammoth incompatibly; review this dependency before production use.
- PostgreSQL now includes organization accounts/sessions, profiles, organization-scoped documents, assessments, findings, and review history. Structured regulatory obligations and legal version approval/effective dates are still missing.
- OCR is not implemented.
- Some official PDFs, including the tested Lex.uz PDF, appear to be scanned/image-only and therefore need OCR; the corresponding HTML page provides a no-OCR route for that document.
- Snapshot fallback matches are heuristic and should be reviewed, particularly for large rewrites or repeated similar paragraphs. Older completed records need re-fetching/reprocessing to populate normalized fields before comparison.
- Basic owner authentication and organization isolation are implemented and integration-tested. Team roles/invitations, malware scanning, and production file-storage controls are not implemented.
- Monitoring worker/source checks and regulation version review workflow are planned but not implemented.
- Automated extraction/comparison regression tests are available; API/database integration and job-transition tests still need to be added.

## Current run instructions

Start PostgreSQL in the background if it is not already running:

```sh
docker compose up -d db
```

Start the frontend, API, and document worker in watch mode:

```sh
npm run dev
```

- Frontend: http://localhost:5173
- API health: http://localhost:3000/api/health
- Swagger UI: http://localhost:3000/docs
- OpenAPI JSON: http://localhost:3000/docs/json
- Upload endpoint: `POST http://localhost:3000/api/documents` (multipart field: `file`)
- Remote document endpoint: `POST http://localhost:3000/api/documents/from-url` with `{ "url": "https://lex.uz/docs/4575788" }`
- Regulation snapshot comparison: `POST http://localhost:3000/api/documents/compare` with `{ "previous_document_id": "...", "current_document_id": "..." }`

## Next suggested steps

1. Configure a valid OpenAI key for the API and worker, then run one end-to-end synthetic assessment to verify provider response and measure latency/cost.
2. Seed a small, manually reviewed, properly sourced obligation set and synthetic policy/evaluation cases; keep verified legal text separate from test prompts.
3. Exercise the complete UI workflow with an unseen synthetic policy; improve any upload/poll/review issues found.
4. Organization isolation and basic rate limits are in place. Validate the signed-in browser flow and deployment HTTPS/CORS before public synthetic-data deployment.
5. Defer finer DOCX extraction, deletion/retention, OCR, scheduled monitoring, and broad evaluation until the working assessment demo is established. Document listing already exists.
