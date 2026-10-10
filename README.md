# RegCheck UZ

Starter monorepo for the RegCheck UZ frontend and backend. Document ingestion is
implemented; regulatory monitoring, compliance assessment, and AI workflows are
not implemented yet.

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
  `GET /api/documents/:id/sections`, `POST /api/documents/compare`

Uploaded files and extracted sections are stored in Docker-managed volumes and
PostgreSQL. The API enqueues extraction; a separate worker processes the job.
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

Example remote import:

```sh
curl -X POST http://localhost:3000/api/documents/from-url \
  -H 'content-type: application/json' \
  -d '{"url":"https://lex.uz/docs/4575788","document_type":"regulation","declared_language":"ru"}'
```

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
