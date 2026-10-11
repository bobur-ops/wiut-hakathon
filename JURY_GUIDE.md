# RegCheck UZ — jury setup and testing guide

RegCheck UZ compares fictional internal policies with imported Uzbekistan regulation snapshots, shows source-linked draft findings, and supports policy-version updates and preliminary regulatory-change impact review.

**Use synthetic policies only. Findings are AI-assisted review prompts, not legal advice or certification.** No prepared database or login account is shipped with a fresh checkout. Provider responses, source revisions, and finding counts can vary.

## 1. Requirements

- Docker Desktop or Docker Engine with Docker Compose v2 (recommended setup).
- Internet access to download images/dependencies and fetch Lex.uz.
- An OpenAI API key with access to the configured model for real assessments.
- Optional: Resend API key and permitted recipient for email testing.
- Node.js 24 and npm for local development and automated tests.
- Available ports: web `5173`, API `3000`, PostgreSQL `5432`.

Without an AI key, authentication, document imports/extraction, and lexical evidence search can still be exercised; real AI assessment cannot complete. Ordinary automated tests do not require real AI calls.

## 2. Recommended: Docker setup

From the repository root:

```sh
cp .env.example .env
```

Edit `.env`:

- Set a local database password and keep it consistent with `DATABASE_URL` if using host-side scripts/tests.
- Set `OPENAI_API_KEY` and `OPENAI_MODEL` to credentials/model available to you.
- Set `REGULATORY_MONITOR_ENABLED=false` during controlled demo preparation. This prevents startup/scheduled discovery from populating the inbox unexpectedly.
- Leave Resend configuration empty if email is not being demonstrated.

Then start all services:

```sh
docker compose up --build
```

API and worker startup apply database migrations automatically. The API receives requests; the separate worker extracts documents and runs assessments. Both need the same database and shared upload storage.

| Service | Address |
| --- | --- |
| Web application | http://localhost:5173 |
| API health | http://localhost:3000/api/health |
| Swagger/API reference | http://localhost:3000/docs |
| OpenAPI document | http://localhost:3000/docs/json |

Verify the API:

```sh
curl --fail http://localhost:3000/api/health
docker compose ps
```

Docker database and document files persist in named volumes. `docker compose down` stops services without deleting these volumes. Do not use `down -v` unless you intentionally want to erase the entire local installation.

## 3. Alternative: local Node development

Install dependencies and start only PostgreSQL in Docker:

```sh
npm ci
docker compose up -d db
npm run dev
```

The root `npm run dev` loads `.env` and starts API, worker, and Vite together. For separate terminals, run these commands from the repository root:

```sh
node --env-file-if-exists=.env --import tsx apps/api/src/server.ts
```

```sh
node --env-file-if-exists=.env --import tsx apps/api/src/documents/worker.ts
```

```sh
npm run dev -w @regcheck/web
```

Do not run a second API or worker alongside the Docker versions. Vite uses its configured development port; `WEB_PORT` maps the Docker web port, not necessarily a separately launched Vite server. If you change a browser API address, rebuild/restart the frontend as appropriate.

## 4. Environment reference

Copy values from `.env.example`, not somebody else's credentials. Never commit or publish `.env` or working provider keys. Obtain hackathon credentials privately or use your own account. Rotate any key previously exposed in a chat, screenshot, or repository.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Local PostgreSQL credentials. Changing these does not change credentials inside an already initialized volume. |
| `DATABASE_URL` | PostgreSQL connection for host-side API/worker/scripts/tests; Compose overrides it with the `db` service hostname internally. |
| `API_PORT`, `WEB_PORT` | Host ports for Docker services. Update frontend URL/origins if changed. |
| `VITE_API_URL` | Browser-visible API URL; a frontend build-time setting. Never put secrets in `VITE_*` variables. |
| `DOCUMENT_STORAGE_DIR` | Local upload storage; Compose uses the shared `/data/uploads` volume. |
| `REMOTE_DOCUMENT_HOSTS` | Allowlisted official sources, normally Lex.uz and CBU.uz. |
| `REMOTE_DOCUMENT_MAX_BYTES` | Remote file limit; default 20 MB. Uploaded files have a separate 5 MB limit. |
| `OPENAI_API_KEY` | Server-side AI credential, needed by the worker. |
| `OPENAI_MODEL` | Assessment and default extraction model; choose one supported by your provider account. |
| `OPENAI_REASONING_EFFORT` | Reasoning option used by the AI client; example value `none`. |
| `ASSESSMENT_COMPARISON_CONCURRENCY` | Concurrent policy-comparison requests; example `2`. |
| `ASSESSMENT_BATCH_SIZE` | Requirements per comparison batch; example `8`. |
| `ASSESSMENT_MAX_COST_USD` | Assessment budget guard, not a provider-enforced spending cap; example `2`. |
| `AUTO_ASSESS_UPDATES` | `true` enables policy-update impact jobs when a completed baseline exists. |
| `RATE_LIMIT_ENABLED` | Enable request limits for a public deployment; local example is `false`. |
| `CORS_ORIGINS` | Exact allowed browser origins, comma-separated. |
| `REGULATORY_MONITOR_ENABLED` | Worker scheduling switch; `false` for controlled preparation, `true` for live monitoring. |
| `REGULATORY_CHECK_INTERVAL_MINUTES` | Per-source check interval, typically `60`; new-act discovery has a separate five-minute dispatch cadence. |
| `REGULATORY_REVIEWER_EMAILS` | Accounts permitted to review shared-corpus updates. Organization-owned sources are reviewed in their own workspace. |
| `RESEND_API_KEY` | Optional server-side email credential. |
| `RESEND_FROM_EMAIL` | Allowed Resend sender; development can use `RegCheck UZ <onboarding@resend.dev>`. |
| `RESEND_ALLOWED_RECIPIENTS` | Optional app-side delivery allowlist. This does not bypass Resend's recipient/domain restrictions. |
| `WEB_APP_URL` | Browser application base URL used in notification links. |

Use the same hostname consistently in the browser: `localhost` and `127.0.0.1` are not interchangeable for cookies. Browser authentication uses a shared HttpOnly session cookie; production needs HTTPS. The recommended jury walkthrough is local, not a production deployment recipe.

## 5. Register a fictional workspace

1. Open the web app and choose **Create a workspace**.
2. Use a fictional organization such as **Demo Bank UZ**, organization type **Commercial bank**, your chosen account email, and a unique password of at least six characters.
3. In organization settings, describe its demo activities: payment services and payer/beneficiary-bank roles; owner/operator of customer personal-data databases. Leave unestablished roles explicitly unconfirmed.
4. There is no pre-provisioned universal jury login, email verification, recovery, or team invitation flow.

## 6. Focused, single-policy demo

### Note for jurors: download the demo policies

Download the fictional V1 and corrected V2 policy files from this shared folder:

**[Demo policy files on Google Drive](https://drive.google.com/drive/folders/1MXiV6sY8Je1iPH5_GB7hkz3NQ-Z7EFfa?usp=sharing)**

Upload **V1 first** and complete its initial assessment. Then select **update/new-version mode on that existing policy** before uploading V2; do not upload V2 as a separate new policy. Compare the two assessments to see how the corrected wording affects findings. The files deliberately illustrate policy conflicts and remediation and must not be used as real operational or legal policies. Copies are also available in this repository at the paths listed below.

If Drive requests permission, ask the project team for access or use the repository copies. The project team should verify that the shared folder is readable by jurors before submission.

### Prepare the regulatory corpus

Use only these two laws for a smaller demonstration:

- Payments and Payment Systems: https://lex.uz/docs/4575788
- Personal Data: https://lex.uz/docs/4396428

Import each through the regulatory library's URL import, as `regulation`. Use a **single-version import**, not the all-revisions import. Wait for extraction to complete, then verify both are included in the assessment scope.

For the exact prepared before/after regulatory-update scenario, import the historical payment snapshot instead:

```text
https://lex.uz/docs/4575788?ONDATE=22.12.2024
```

Label it **Historical demo baseline · 2024-12-22**. Historical snapshots are normally excluded. The current demo implementation supports an explicit `assessmentBaseline` metadata marker, but does not expose a general UI control for setting it. On a disposable local Docker database, explicitly mark that imported snapshot with:

```sh
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
UPDATE documents
SET extraction_metadata = COALESCE(extraction_metadata, '{}'::jsonb)
  || '{"assessmentBaseline":true}'::jsonb
WHERE document_type = 'regulation'
  AND source_url = 'https://lex.uz/docs/4575788?ONDATE=22.12.2024';
SQL
```

This modifies matching local snapshots only; use the fresh demo database described above. It does **not** mark the source legally current or source-reviewed. Verify scope before assessing. For an easier setup with no SQL, import the current URLs for both laws; skip the historical-baseline update story.

Fresh installations have no cached requirements. The first assessment extracts requirements and can take several minutes; later runs validate/reuse the cache for unchanged snapshots. The prepared local demo previously had 143 payment and 59 personal-data draft requirements; these counts are observations, not required test outcomes.

### Initial V1 assessment

1. Upload `data/synthetic/demo-single-policy.txt` in **Policies**.
2. Wait until its processing status is complete.
3. Start an assessment selecting this policy and both regulations.
4. Wait for completion, then open a potential-conflict finding.
5. Inspect the original regulatory quote, policy quote, source link, explanation, and proposed action.

V1 deliberately allows payment without a user instruction, correction of Bank-caused errors after ten business days, and indefinite retention after processing purposes end. These should provide meaningful conflict examples; there is no hardcoded expected result count.

### Upload the corrected V2

1. Open the **existing V1 policy** and enter its update/new-version mode.
2. Upload `data/synthetic/v2/demo-single-policy-v2.txt`.
3. Confirm it belongs to the same logical policy group. A normal new upload creates a different policy, not an update.
4. Wait for extraction. With `AUTO_ASSESS_UPDATES=true` and a completed baseline, an impact assessment can run automatically. If it is already queued/processing, do not start a duplicate assessment.
5. Otherwise start a new assessment selecting V2 and the same regulations.
6. Compare results with V1. V2 addresses the major planted conflicts; it is not a comprehensive compliance policy and may retain evidence gaps or review findings.

Keep the original assessment for comparison. A source or policy snapshot is immutable; new versions do not rewrite old assessment evidence.

## 7. Optional regulatory-change demonstration

If the initial assessment used the historical Payments snapshot, later import the current `https://lex.uz/docs/4575788` as a single regulation snapshot. Lex.uz imports group by document ID and type. Verify that the new snapshot is in the same group and that the next assessment's scope selects the intended version.

Use the document-comparison API described in Swagger to compare the old/new IDs, or demonstrate monitored-source candidate review. A manual import is not an automatically detected monitoring event. Do not promise that a particular amendment necessarily changes a finding; inspect the actual changes first.

## 8. Monitoring and email tests

### Monitoring

Set `REGULATORY_MONITOR_ENABLED=true` and restart/recreate the worker. It scans on startup and through the five-minute dispatcher, reading at most 50 listing entries and queuing at most three likely-relevant act imports per scan. Official-source checks have their own configured interval.

The updates page also supports manual discovery/check actions. Keyword relevance is triage, not proof of applicability. Confirming an act's relevance does not promote it into the regulation library. Its preliminary assessment requires an eligible completed baseline and readable source text; scanned/unsupported acts can fail extraction.

### Email

Configure Resend settings for API and worker and restart them. Add a recipient in organization settings and enable the desired notification types. The development sender typically delivers only to the address permitted by the Resend account unless a verified domain is configured. The app allowlist must contain the exact recipient when enabled.

Complete an assessment or exercise the notification retry UI. Verify delivery status in the application and the actual inbox. Opening the email link must require workspace access; adding a notification recipient does not grant an account.

## 9. Automated tests

From the repository root with Node.js 24:

```sh
npm ci
npm run typecheck
npm run build
node --import tsx --test apps/api/test/*.test.ts apps/web/test/*.test.ts
```

The ordinary suite runs unit/route tests and skips PostgreSQL integration cases unless explicitly enabled. Provider behavior is mocked in relevant tests; passing tests are not evidence that real keys or legal interpretations are valid. The frontend build can report a bundle-size warning without failing.

### PostgreSQL integration tests — use a separate database

These tests migrate and write fixture data. Do **not** point them at the prepared demo or production database. With the Compose database running:

```sh
docker compose exec db sh -c 'createdb -U "$POSTGRES_USER" regcheck_test'
```

If the test database already exists, reuse it rather than recreating it. Set `DATABASE_URL` for the command below to that separate database, substituting your actual local credentials:

```sh
DATABASE_URL='postgres://regcheck:change-me@localhost:5432/regcheck_test' \
RUN_DB_TESTS=1 \
node --import tsx --test apps/api/test/*.test.ts apps/web/test/*.test.ts
```

For the focused cache/corpus tests only:

```sh
node --import tsx --test apps/api/test/corpus.test.ts
```

Use the host-side connection string (`localhost:5432`), not Compose's internal `db` hostname. Avoid setting real provider keys for automated tests unless you are deliberately testing a live integration.

## 10. Manual acceptance checklist

- [ ] API health is reachable; API, worker, web, and database are running.
- [ ] Register/sign in; reload a protected page and open it in a new same-host tab without another login.
- [ ] Two organization-owned regulation imports complete and appear in assessment scope.
- [ ] V1 policy extracts and its assessment completes with original evidence.
- [ ] Missing evidence is labelled as a gap, not automatically a violation.
- [ ] V2 upload uses the same policy group; V1 remains available.
- [ ] Updated assessment includes the intended V2 snapshot and all selected sources.
- [ ] Old assessment evidence remains unchanged; findings can be inspected and reviewed.
- [ ] Logout revokes access; another fictional account cannot read the first workspace's protected data.
- [ ] Optional: email arrives and its link opens the correct authorized workspace page.
- [ ] Optional: legislation discovery stays separate from the manually curated regulation corpus.

## 11. Troubleshooting and limitations

| Symptom | Checks |
| --- | --- |
| Jobs stay queued | Worker must be running and connected to the same DB/storage; inspect `docker compose logs worker`. |
| DB authentication fails | Check `.env`, host/port, and existing volume credentials. Root dev command loads `.env`; bare workspace scripts may not. |
| Assessment fails | Inspect its failure and coverage warnings, provider model access, credentials, quota, and budget guard. Partial findings are not complete coverage. |
| Historical source excluded | Apply the explicit demo marker only to the intended snapshot or import a current URL; do not erase revision dates. |
| Separate V2 policy appears | Use update mode or pass the existing `document_group_id` in the upload API. Matching filenames alone do not join versions. |
| New tab requests login | Use the same hostname; confirm credentialed requests and allowed CORS origin. HTTPS/Secure-cookie deployment must be consistent. |
| Lex.uz import unsupported | Prefer the `/docs/{id}` legal HTML. Some translations are placeholders and some PDFs are scanned; OCR is not enabled. |
| Email fails | Check exact recipient, Resend account/domain restrictions, sender, allowlist, worker logs, and delivery history. |
| New acts appear during setup | Disable scheduled monitoring and restart the worker; previous queued/imported data is not automatically erased. |

Useful diagnostics:

```sh
docker compose logs --tail=100 api worker
git diff --check
```

Do not share logs containing secrets or customer information. Do not run destructive corpus-pruning/reset scripts to fix ordinary startup issues. This MVP has lexical evidence retrieval, no OCR, no enterprise roles/SSO/account recovery, unverified legal applicability/effective dates, and model-dependent findings. Present source evidence and human review rather than a guaranteed compliance score.
