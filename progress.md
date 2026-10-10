# RegCheck UZ — Development Progress

This file tracks completed work, current scope, decisions, and the next planned steps.

## Product direction

- AI-assisted regulatory compliance platform for regulated financial institutions and fintech businesses in Uzbekistan.
- Cover multiple fintech and financial-services domains, including payments, banking, e-money, licensing, consumer protection, security, and AML/KYC. Keep the MVP corpus curated and disclose coverage rather than claiming completeness.
- Findings must be evidence-backed and reviewed by a human; the product must not claim to certify legal compliance.
- Regulatory monitoring now checks supported official URLs from the imported corpus on a schedule, preserves changed snapshots, and requires source review. It does not certify legal currency or yet trigger policy-impact assessments.

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

### Routing and corpus-driven assessment — current checkpoint

#### Cancellation, Luna, and incremental-cost checkpoint

- Demo corpus cleanup (user-approved): retained only one current snapshot each for Lex.uz IDs 4575788, 284542, 4396428, and 4590456. Deleted 69 other regulatory/historical snapshots, removed other monitoring sources, and cleared import/check/candidate/extraction-attempt history and assessment/finding/review history. Preserved both internal policy documents, the organization/account, and the four retained extraction caches.
- Verified the assessment selector returns exactly the four requested URLs with no excluded sources. Cached duties reduced from 835 to 279 (~67% fewer). No AI extraction was needed for cleanup. Added `apps/api/scripts/prune-demo-corpus.ts` with default dry-run, explicit `--apply`, transactional cleanup, and preservation checks. Storage files were not deleted; this cleanup targeted database data. Development services were already stopped and were not restarted.

- At user request, stopped the development worker and deleted all five Demo Bank UZ assessments (including cascading findings/reviews), cancelling its remaining active queue job. Policies, accounts, regulatory snapshots, and extraction caches were preserved; other workspaces were not cleared.
- Added organization-scoped cancellation with CANCELLED terminal state, persisted job IDs, queue cancellation, cancellation polling/abort during provider calls, and UI controls for queued/processing runs. Duplicate active-run requests are rejected. Already submitted provider requests may still be billed.
- Default adapter now uses GPT-6 Luna with reasoning disabled, no unsupported temperature field, and structured output. The user's existing `.env` already selected Luna and was not overwritten. Live two-duty batch test returned a validated conflict and a supported finding; reported 526 input/216 output tokens, estimated $0.0001606. This is a synthetic smoke test, not a legal-accuracy benchmark.
- Batched comparisons (default eight duties, two concurrent batches, bounded input target) with shared passages and source-ID-backed policy quotations. Missing evidence may cite relevant partial coverage rather than automatically downgrading it; invalid citations remain downgraded. Applicability uses organization context; unknown scope is not silently filtered out.
- Compatible v3 extraction caches survive comparison-model changes. New snapshots reuse exact unchanged citation-backed obligations and re-extract changed/neighbour/dependent clauses; detected scope/definition changes conservatively rescan that source. Cross-law and uncited semantic dependencies remain a review limitation.
- Comparison fingerprints reuse unchanged validated findings/reviewer history, including valid partial findings from failed/cancelled runs. Policy-version reuse is evidence-sensitive for supported/conflicting/excluded findings; missing/uncertain results conservatively invalidate on any selected policy hash change. New/changed/resolved documentary findings and removed-from-scope counts are separated.
- Added durable impact jobs for updated policies and approved monitored regulation snapshots after a completed baseline exists. Impact jobs pin current source/policy versions, defer while processing is active, and avoid duplicate event assessments. AUTO_ASSESS_UPDATES can disable them. Unreviewed candidates/first uploads do not automatically incur baseline AI calls.
- HTTP 520/other 5xx, 429, timeouts, and network failures now have bounded backoff retries. Per-assessment reported usage, attempts, cost estimates, rough prepared-comparison estimate, reuse counts, and a configurable budget guard are persisted/displayed. The guard is not an absolute provider billing cap.
- Validation: 48 API tests passed with PostgreSQL enabled (serial), including cancellation ownership/idempotence, in-flight request abort, batched comparison, cache reuse, HTTP 520 recovery, and impact-event deduplication. Typecheck, build, frontend session regression, and Compose validation passed. Development API/worker/web restarted; API health and `/assessments` SPA route returned 200. Demo Bank UZ remains empty (0 assessments), with all 13 extraction caches / 835 draft duties preserved. No new full-cost assessment was launched automatically.

- Citation/source recovery checkpoint: imported the five verified original Uzbek texts as new immutable snapshots in the existing regulatory groups; preserved legacy snapshots and titles. Corrected monitoring URLs and baselines without marking them legally approved. Verified source aliases keep future imports/monitoring in the same groups and retain organization isolation.
- Regulatory extraction v2 selects chunk IDs and materializes verbatim legal evidence server-side instead of asking the model to reproduce quotes. Invalid IDs/legacy quotations receive at most three validation-repair attempts, with batch responses/errors persisted for diagnosis. Source failures no longer stop extraction/comparison for other sources; exact source/URL/batch failures appear in coverage warnings, while the run remains incomplete.
- Live extraction exposed hallucinated abbreviated UUIDs in v2 despite retries; v3 uses short batch-local IDs constrained to an exact dynamic schema enum. Original section UUIDs and verbatim text are still persisted and validated, not weakened to fuzzy matching.
- Live v3 extraction succeeded across both batches of regulation 3434's original Uzbek snapshot: 32 draft obligations and 80 validated source citations, cached for subsequent runs. All 40 API tests passed with PostgreSQL enabled (serial), typecheck/build passed, and the frontend session regression passed. A complete multi-source policy assessment still needs a new run with the updated worker.
- Added tests for bounded repair, server-materialized quotations, mixed source success/failure, and source alias ownership/group reuse. All 39 API tests passed with PostgreSQL enabled and test concurrency 1; frontend session test, typecheck, and production build passed. The parallel DB run initially hit a migration/fixture deadlock; the serial run completed cleanly.

- Follow-up fix: confirmed regulation 3229's Russian Lex.uz page is a language placeholder (title/signature only). Corpus selection now excludes selected snapshots without substantive legal sections, with existing coverage warnings rather than crashing extraction or silently substituting an older revision. New placeholder imports return an actionable original-language URL. Live extraction verified `/docs/4790646` provides 298 legal sections; `/docs/4790648` correctly rejects the placeholder.
- Development rate limits are disabled by default, including route-specific authentication/monitoring limits; `RATE_LIMIT_ENABLED=true` opts back in. External provider quotas are unchanged. Added regressions for placeholders, legal-text extraction, textless corpus baselines, and >120 development requests.

- Replaced page-state navigation with React Router protected URLs for dashboard, policies, regulations, assessment list/details, finding details, updates, review history, and settings. Login preserves the intended destination; the existing Nginx SPA fallback supports deep links.
- Removed the manual prompt/requirement form and caller-supplied obligation API input. New assessments pin selected policy snapshots, all eligible regulation snapshots, content hashes, organization type/activities, and assessment date.
- Selects one completed snapshot per regulation group, prioritizing source-reviewed monitoring updates. Historical revisions, incomplete regulation extraction, and unaccepted monitor snapshots are excluded from automatic baseline selection. Snapshot selection is not legal effective-date verification.
- Added full-section bounded/overlapping obligation extraction with exact legal citation validation, AI-draft labelling, multilingual retrieval hints, and snapshot/model/prompt-version caching with revalidated cached citations.
- Worker compares every extracted obligation against policy evidence with bounded concurrency, persisted processing stages and real counts. Uncertain applicability is downgraded to review, explicit exclusions use NOT_APPLICABLE, and failed runs remain incomplete rather than claiming full success.
- Redesigned results around prominent conflict/missing-evidence/review/support counts and an attention-first findings table. Findings have plain-language titles, suggested actions, routed side-by-side source evidence, authenticated reviewer actions, and recorded decisions. Technical hashes/model details are collapsed.
- Added extraction coverage/citation, draft applicability, processor success/failure/concurrency, and database snapshot-selection/cache/manifest tests. No live full-corpus model benchmark or claim of legal accuracy has been made.
- Remaining limitations: AI drafts are not reviewed legal obligations, effective dates are not verified, full-corpus extraction may miss duties, monitoring impact and automatic assessment on policy upload/update are not connected yet.
- Final validation: all 33 API tests passed with PostgreSQL integration enabled; frontend session test, typecheck, production build, and Compose validation passed. Build retains the bundle-size advisory.
- Live OpenAI comparison smoke test succeeded with one synthetic bank-retention rule and policy excerpt: APPLICABLE / POTENTIAL_CONFLICT, with one exact validated policy citation. This verifies provider access and comparison output, not a full-corpus extraction/assessment benchmark or legal accuracy.

### Scheduled source monitoring — current checkpoint

- Added a durable `pg-boss` dispatcher cron (`*/5 * * * *`, UTC) and separate source-check queue. New sources default to hourly checks; due checks are staggered/deduplicated, with cross-worker advisory locks.
- Auto-discovers current Lex.uz legal-page URLs and supported official PDF URLs from completed regulation imports. Historical Lex dates/compare selectors are not monitored separately; incomplete PDF extraction is a visible failure rather than a purported legal removal.
- Persists each check, last successful/failed status, raw/text hashes, and due times. Text hashing ignores website navigation, whitespace, and regenerated element IDs.
- Changed text creates an immutable snapshot and pending candidate with old/new excerpts. Acceptance records the reviewer and snapshot pointer; rejection records a reason. No previous assessment or document is overwritten, and legal effective dates are not invented.
- Added source/check/candidate APIs and the Regulatory Updates UI with source status, check history, on-demand checks, source enable/disable, side-by-side differences, and reviewer controls. Shared configuration/review is limited to `REGULATORY_REVIEWER_EMAILS`; private organization sources remain isolated.
- Verified the running local database has 13 monitored official sources, each successfully reporting `UNCHANGED`, and the durable dispatcher schedule exists. Real laws were not modified; the changed-source workflow is tested with synthetic responses.
- Configuration is documented in `.env.example` and passed through Docker Compose. The worker must remain running; monitoring is limited to the imported allowlisted corpus, not discovery of all newly issued laws.
- Policy impact assessment after updates is still pending. The UI explicitly discloses this instead of claiming internal policies were automatically assessed or changed.
- Final checks pass: all 26 API tests with PostgreSQL integration enabled, frontend session regression, typecheck, production build, and Docker Compose configuration validation.

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
- Scheduled source checks and candidate-review workflow are implemented. Legal effective-date verification, structured obligation extraction, and automatic policy-impact assessment remain pending.
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
5. Scheduled monitoring is implemented; next connect reviewed regulatory obligations and changes to corpus-wide policy assessments. Finer DOCX extraction, deletion/retention, OCR, and broad evaluation remain deferred.
