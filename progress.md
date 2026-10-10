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
- Added remote source provenance (`source_type`, `source_url`, `retrieved_at`) to document records. Local uploads are limited to 5 MB; trusted remote documents default to a separately configurable 20 MB limit (`REMOTE_DOCUMENT_MAX_BYTES`).
- Added Swagger UI at `/docs` and OpenAPI JSON at `/docs/json`.
- Added page-level source references for PDF sections. DOCX/TXT sections currently retain paragraph or section order; finer-grained structural references can be improved later.
- Scanned/image-only PDFs are not OCR-processed; extraction reports unsupported/no-text status or page warnings.
- Updated the root `npm run dev` command to start frontend, API, and worker in watch mode and load `.env` when present.

## Validation completed

- `npm run typecheck` passes.
- `npm run test -w @regcheck/api` passes eight regression tests for matching precedence, ambiguous candidates, paragraph moves, changed IDs, and TXT evidence references.
- `npm run build` passes (Vite reports a bundle-size advisory for the Ant Design chunk).
- Smoke-tested snapshot comparison: correctly classifies an edited element and a newly added element by stable reference.
- Smoke-tested a regulation paragraph whose Lex element ID changed and whose text was edited: comparison reports one `MODIFIED` change with no false addition/removal.
- `docker compose config` and Docker image builds passed.
- Verified TXT upload → queued background job → completed status → stored sections.
- Verified PDF page extraction produces Markdown and a page reference using a generated sample PDF.
- Verified the exact Lex.uz example PDF downloads successfully (5,794,587 bytes), queues, and is correctly marked `UNSUPPORTED` because it has no extractable text and OCR is not enabled.
- Verified the matching Lex.uz HTML page downloads and completes extraction with 590 sections, Russian text, and `lex-element:*` source references.
- Verified ingestion of a revision-specific Lex.uz URL with `ONDATE=22.12.2024`; the requested URL and retrieval timestamp are persisted with the extracted sections.
- Verified the generated OpenAPI spec includes upload and remote-document routes; a localhost URL is rejected by the remote-fetch allowlist.
- Stopped API, worker, and frontend containers after integration testing. PostgreSQL is left running for local development.

## Known limitations / follow-ups

- `npm audit` reports three moderate advisories through Mammoth's `argparse` → `sprintf-js` dependency chain. The automated suggested fix downgrades Mammoth incompatibly; review this dependency before production use.
- PostgreSQL schema currently covers only document metadata and extracted sections; no organization, regulation, policy-version, or assessment schema has been implemented yet.
- OCR is not implemented.
- Some official PDFs, including the tested Lex.uz PDF, appear to be scanned/image-only and therefore need OCR; the corresponding HTML page provides a no-OCR route for that document.
- Snapshot fallback matches are heuristic and should be reviewed, particularly for large rewrites or repeated similar paragraphs. Older completed records need re-fetching/reprocessing to populate normalized fields before comparison.
- Authentication, authorization, workspace isolation, malware scanning, and production file-storage controls are not implemented.
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

1. Add automated tests for file validation, extraction outcomes, and job status transitions.
2. Test PDF extraction against representative Russian and Uzbek legal PDFs, including scanned and mixed PDFs.
3. Refine DOCX structure extraction and location references if needed.
4. Add document list/delete endpoints and define retention behavior.
5. Once ingestion is reliable, implement section-aware retrieval/search.
6. Then add regulation/version data across the selected fintech domains and the reviewed regulatory-source monitoring workflow.
