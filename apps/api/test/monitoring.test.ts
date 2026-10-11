import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import test from "node:test";
import type { PgBoss } from "pg-boss";
import { monitoringUrl, textHash, comparableSections } from "../src/monitoring/content.js";
import { checkRegulatorySource, startRegulatoryMonitor } from "../src/monitoring/service.js";
import { extractDocument } from "../src/documents/extract.js";
import { getStoredFilePath } from "../src/documents/storage.js";
import { migrate, pool } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { canReviewSharedSource } from "../src/monitoring/routes.js";

test("monitoring deduplicates historical Lex URLs into the current official page", () => {
  assert.equal(monitoringUrl("https://www.lex.uz/docs/4575788?ONDATE=22.12.2024&ONDATE2=01.01.2025#old"), "https://lex.uz/docs/4575788");
  assert.equal(monitoringUrl("https://lex.uz/pdffile/4575788"), "https://lex.uz/docs/4575788");
  assert.equal(monitoringUrl("https://lex.uz/docs/-8529453"), "https://lex.uz/docs/-8529453");
  assert.equal(monitoringUrl("https://lex.uz/docs/123?lang=ru&ONDATE=01.01.2020"), "https://lex.uz/docs/123?lang=ru");
  assert.equal(monitoringUrl("http://lex.uz/docs/123"), null);
  assert.equal(monitoringUrl("https://attacker.example/docs/123"), null);
  assert.equal(monitoringUrl("https://lex.uz@attacker.example/docs/123"), null);
});

test("shared corpus review is restricted to explicitly configured account emails", () => {
  const original = process.env.REGULATORY_REVIEWER_EMAILS;
  try {
    process.env.REGULATORY_REVIEWER_EMAILS = "";
    assert.equal(canReviewSharedSource("owner@example.com"), false);
    process.env.REGULATORY_REVIEWER_EMAILS = " Reviewer@Example.com, second@example.com ";
    assert.equal(canReviewSharedSource("reviewer@example.com"), true);
    assert.equal(canReviewSharedSource("owner@example.com"), false);
  } finally {
    if (original === undefined) delete process.env.REGULATORY_REVIEWER_EMAILS;
    else process.env.REGULATORY_REVIEWER_EMAILS = original;
  }
});

function html(text: string, id = "clause-1", navigation = "Home") {
  return Buffer.from(`<html><head><title>Synthetic regulation</title></head><body><nav>${navigation}</nav><div id="divCont"><div class="ACT_TEXT"><span name="${id}">${text}</span></div></div></body></html>`);
}

test("legal text hashes ignore navigation, whitespace and regenerated element IDs", async () => {
  const a = await extractDocument(html("Banks must retain records for five years."), "text/html");
  const b = await extractDocument(html("Banks must   retain records for five years.", "new-id", "Different controls"), "text/html");
  const c = await extractDocument(html("Banks must retain records for seven years."), "text/html");
  assert.equal(textHash(comparableSections(a.sections)), textHash(comparableSections(b.sections)));
  assert.notEqual(textHash(comparableSections(a.sections)), textHash(comparableSections(c.sections)));
});

test("worker installs a durable pg-boss cron schedule and respects global disable", async () => {
  const original = process.env.REGULATORY_MONITOR_ENABLED;
  const calls: string[] = [];
  const boss = {
    createQueue: async (name: string) => { calls.push(`queue:${name}`); },
    schedule: async (_name: string, cron: string) => { calls.push(`schedule:${cron}`); },
    unschedule: async () => { calls.push("unscheduled"); },
    work: async () => {}, send: async () => "job-id",
  } as unknown as PgBoss;
  try {
    process.env.REGULATORY_MONITOR_ENABLED = "true";
    await startRegulatoryMonitor(boss);
    assert.ok(calls.includes("schedule:*/5 * * * *"));
    calls.length = 0;
    process.env.REGULATORY_MONITOR_ENABLED = "false";
    await startRegulatoryMonitor(boss);
    assert.ok(calls.includes("unscheduled"));
    assert.ok(!calls.some((value) => value.startsWith("schedule:")));
  } finally {
    if (original === undefined) delete process.env.REGULATORY_MONITOR_ENABLED;
    else process.env.REGULATORY_MONITOR_ENABLED = original;
  }
});

test("monitor stores immutable changes, records failures, and isolates candidate review", {
  skip: process.env.RUN_DB_TESTS !== "1",
}, async () => {
  await migrate();
  const app = buildApp({ send: async () => randomUUID() } as unknown as PgBoss);
  const sourceId = randomUUID();
  const orgIds: string[] = [];
  const tokens: string[] = [];
  let contents = html("Banks must retain records for five years.");
  const download = async () => ({ contents, filename: "synthetic-regulation.html", mimeType: "text/html" as const });
  try {
    for (const suffix of ["a", "b"]) {
      const registered = await app.inject({ method: "POST", url: "/api/auth/register", payload: {
        email: `${randomUUID()}@example.com`, password: "test-monitor-123", name: `Monitor Test ${suffix}`, organization_type: "commercial_bank",
      } });
      assert.equal(registered.statusCode, 201);
      orgIds.push(registered.json().identity.organization_id); tokens.push(registered.json().token);
    }
    await pool.query(`INSERT INTO regulatory_sources (id, organization_id, name, source_url, next_check_at)
      VALUES ($1, $2, 'Synthetic monitored regulation', $3, NOW() + INTERVAL '1 day')`, [sourceId, orgIds[0], `https://lex.uz/docs/${Date.now()}`]);
    await checkRegulatorySource(sourceId, { download });
    let source = (await pool.query("SELECT * FROM regulatory_sources WHERE id = $1", [sourceId])).rows[0];
    assert.equal(source.last_status, "BASELINE_CREATED");
    const baseline = source.last_document_id;
    assert.equal(source.accepted_document_id, null);
    contents = html("Banks must retain records for five years.", "another-id", "Updated navigation");
    await checkRegulatorySource(sourceId, { download });
    source = (await pool.query("SELECT * FROM regulatory_sources WHERE id = $1", [sourceId])).rows[0];
    assert.equal(source.last_status, "UNCHANGED");
    assert.equal(source.last_document_id, baseline);
    contents = html("Banks must retain records for seven years.");
    await checkRegulatorySource(sourceId, { download });
    const candidate = (await pool.query("SELECT * FROM regulatory_update_candidates WHERE source_id = $1", [sourceId])).rows[0];
    assert.equal(candidate.status, "PENDING_REVIEW");
    assert.equal(candidate.previous_document_id, baseline);
    assert.notEqual(candidate.new_document_id, baseline);
    assert.equal(candidate.comparison.summary.modified, 1);
    assert.match(candidate.comparison.changes[0].previous_text, /five years/);
    assert.match(candidate.comparison.changes[0].new_text, /seven years/);
    await checkRegulatorySource(sourceId, { download });
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM regulatory_update_candidates WHERE source_id = $1", [sourceId])).rows[0].count, 1);
    const headersA = { authorization: `Bearer ${tokens[0]}` };
    const headersB = { authorization: `Bearer ${tokens[1]}` };
    const updatesB = await app.inject({ method: "GET", url: "/api/regulatory-updates", headers: headersB });
    assert.ok(!updatesB.json().updates.some((item: { id: string }) => item.id === candidate.id));
    assert.equal((await app.inject({ method: "GET", url: `/api/regulatory-sources/${sourceId}/checks`, headers: headersB })).statusCode, 404);
    const payload = { decision: "APPROVED", note: "Synthetic source checked in integration test." };
    assert.equal((await app.inject({ method: "POST", url: `/api/regulatory-updates/${candidate.id}/review`, headers: headersB, payload })).statusCode, 404);
    const accepted = await app.inject({ method: "POST", url: `/api/regulatory-updates/${candidate.id}/review`, headers: headersA, payload });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await pool.query("SELECT accepted_document_id FROM regulatory_sources WHERE id = $1", [sourceId])).rows[0].accepted_document_id, candidate.new_document_id);
    assert.equal((await app.inject({ method: "POST", url: `/api/regulatory-updates/${candidate.id}/review`, headers: headersA, payload })).statusCode, 409);
    const previousText = await pool.query("SELECT content FROM document_sections WHERE document_id = $1", [baseline]);
    assert.ok(previousText.rows.some((row) => row.content.includes("five years")));
    await checkRegulatorySource(sourceId, { download: async () => { throw new Error("Synthetic fetch failure"); } });
    source = (await pool.query("SELECT * FROM regulatory_sources WHERE id = $1", [sourceId])).rows[0];
    assert.equal(source.last_status, "FAILED");
    assert.equal(source.last_error, "Synthetic fetch failure");
    assert.ok(source.last_successful_check_at);
    assert.equal(source.last_document_id, candidate.new_document_id);
  } finally {
    await app.close();
    const files = await pool.query("SELECT storage_key FROM documents WHERE organization_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM regulatory_update_candidates WHERE source_id = $1", [sourceId]);
    await pool.query("DELETE FROM regulatory_source_checks WHERE source_id = $1", [sourceId]);
    await pool.query("DELETE FROM regulatory_sources WHERE id = $1", [sourceId]);
    await pool.query("DELETE FROM documents WHERE organization_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM document_groups WHERE organization_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM users WHERE organization_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
    for (const file of files.rows) await unlink(getStoredFilePath(file.storage_key)).catch(() => undefined);
    await pool.end();
  }
});
