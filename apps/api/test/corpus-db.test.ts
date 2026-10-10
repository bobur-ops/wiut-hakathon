import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PgBoss } from "pg-boss";
import { pool, migrate } from "../src/db.js";
import { selectAssessmentCorpus } from "../src/assessments/corpus.js";
import { extractRegulatoryObligations, extractionVersion } from "../src/assessments/extraction.js";
import { buildApp } from "../src/app.js";
import { allocateVersion } from "../src/documents/versions.js";
import { processDocumentImpact } from "../src/assessments/impact.js";

test("corpus selection excludes historical/pending/foreign snapshots and assessment creation pins all selected sources", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  await migrate();
  const orgA = randomUUID(), orgB = randomUUID(), groupA = randomUUID(), groupB = randomUUID(), groupP = randomUUID();
  const current = randomUUID(), historical = randomUUID(), pending = randomUUID(), foreign = randomUUID(), policy = randomUUID();
  const sourceId = randomUUID(), userId = randomUUID(), sectionId = randomUUID();
  const documentIds = [current, historical, pending, foreign, policy];
  const originalKey = process.env.OPENAI_API_KEY;
  const token = (randomUUID() + randomUUID()).replaceAll("-", "");
  const { hashToken } = await import("../src/auth/security.js");
  let createdAssessment: string | undefined;
  const app = buildApp({ send: async () => randomUUID(), cancel: async () => ({ jobs: 1 }) } as unknown as PgBoss);
  try {
    await pool.query("INSERT INTO organizations (id, name, organization_type) VALUES ($1, 'Corpus Test A', 'commercial_bank'), ($2, 'Corpus Test B', 'payment_organization')", [orgA, orgB]);
    await pool.query("INSERT INTO users (id, organization_id, email, password_hash) VALUES ($1, $2, $3, 'test-unused')", [userId, orgA, `${randomUUID()}@example.com`]);
    await pool.query("INSERT INTO auth_sessions (token_hash, user_id) VALUES ($1, $2)", [hashToken(token), userId]);
    await pool.query("INSERT INTO document_groups (id, source_key, title, document_type, organization_id) VALUES ($1, $2, 'Synthetic Corpus A', 'regulation', $3), ($4, $5, 'Synthetic Corpus B', 'regulation', $6)", [groupA, `test:${groupA}`, orgA, groupB, `test:${groupB}`, orgB]);
    await pool.query("INSERT INTO document_groups (id, source_key, title, document_type, organization_id) VALUES ($1, $2, 'Synthetic policy', 'policy', $3)", [groupP, `test:${groupP}`, orgA]);
    for (const [index, id] of documentIds.entries()) {
      const type = id === policy ? "policy" : "regulation";
      await pool.query(`INSERT INTO documents (id, filename, mime_type, file_size_bytes, storage_key, content_hash,
        document_type, processing_status, organization_id, document_group_id, version_number, revision_date, extraction_metadata)
        VALUES ($1, 'synthetic.txt', 'text/plain', 100, $2, 'synthetic-hash', $3, 'COMPLETED', $4, $5, $6, $7, $8::jsonb)`,
      [id, `test-${id}.txt`, type, id === foreign ? orgB : orgA, id === foreign ? groupB : id === policy ? groupP : groupA, index + 1,
        id === historical ? "2020-01-01" : null, JSON.stringify(id === pending ? { monitoringSnapshot: true } : {})]);
    }
    const requirement = "Banks must retain synthetic customer records.";
    for (const id of [current, pending, foreign]) {
      await pool.query("INSERT INTO document_sections (id, document_id, section_index, content, source_reference) VALUES ($1, $2, 0, $3, 'article:1')", [id === pending ? sectionId : randomUUID(), id, requirement]);
    }
    await pool.query(`INSERT INTO regulatory_sources (id, organization_id, name, source_url, last_document_id, next_check_at)
      VALUES ($1, $2, 'Synthetic Corpus A', $3, $4, NOW() + INTERVAL '1 day')`, [sourceId, orgA, `https://lex.uz/docs/${Date.now()}`, current]);
    let selected = await selectAssessmentCorpus(orgA);
    assert.ok(selected.some((document) => document.id === current));
    assert.ok(!selected.some((document) => [historical, pending, foreign].includes(document.id)));
    const selectedB = await selectAssessmentCorpus(orgB);
    assert.ok(selectedB.some((document) => document.id === foreign));
    assert.ok(!selectedB.some((document) => [current, historical, pending].includes(document.id)));
    await pool.query("UPDATE regulatory_sources SET accepted_document_id = $2 WHERE id = $1", [sourceId, pending]);
    selected = await selectAssessmentCorpus(orgA);
    assert.ok(selected.some((document) => document.id === pending && document.source_reviewed));
    assert.ok(!selected.some((document) => document.id === current));

    await pool.query("UPDATE document_sections SET section_type = 'DOCUMENT_TITLE' WHERE id = $1", [sectionId]);
    const textless = await selectAssessmentCorpus(orgA);
    assert.ok(!textless.some((document) => document.document_group_id === groupA), "Do not assess title-only accepted snapshots or silently fall back to older legal text");
    await pool.query("UPDATE document_sections SET section_type = 'PARAGRAPH' WHERE id = $1", [sectionId]);
    const snapshot = selected.find((document) => document.id === pending)!;
    const obligation = { id: "cached-draft", title: "Record retention", citation: "Synthetic Corpus A", requirement, extraction_status: "AI_DRAFT", regulation_evidence: [{ section_id: sectionId, document_id: pending, title: snapshot.title, source_reference: "article:1", excerpt: requirement, source_url: null, version_label: null, content_hash: snapshot.content_hash }] };
    await pool.query("INSERT INTO regulatory_obligation_cache (document_id, extractor_version, obligations, processed_sections) VALUES ($1, $2, $3::jsonb, 1)", [pending, extractionVersion(), JSON.stringify([obligation])]);
    assert.equal((await extractRegulatoryObligations(snapshot, async () => {}))[0]?.id, "cached-draft");
    const aliasKey = `org:${orgA}:lex:99999999:regulation`;
    await pool.query("INSERT INTO document_group_source_aliases (source_key,document_group_id,verified_from_url) VALUES ($1,$2,$3)", [aliasKey, groupA, "https://lex.uz/docs/99999998"]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const aliased = await allocateVersion(client, { organizationId: orgA, sourceUrl: "https://lex.uz/docs/99999999", documentType: "regulation", filename: "original.html" });
      assert.equal(aliased.documentGroupId, groupA);
      await assert.rejects(allocateVersion(client, { organizationId: orgB, documentGroupId: groupA, sourceUrl: "https://lex.uz/docs/99999999", documentType: "regulation", filename: "foreign.html" }), /workspace/);
      await client.query("ROLLBACK");
    } finally { client.release(); }

    process.env.OPENAI_API_KEY = "test-not-used";
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/api/assessments", headers, payload: { policy_document_ids: [policy] } });
    assert.equal(created.statusCode, 202, created.body);
    createdAssessment = created.json().assessment_id;
    const stored = (await pool.query("SELECT corpus_document_ids, input_snapshots, organization_profile, pipeline_version FROM assessments WHERE id = $1", [createdAssessment])).rows[0];
    assert.deepEqual(new Set(stored.corpus_document_ids), new Set(selected.map((document) => document.id)));
    assert.equal(stored.pipeline_version, "incremental-v2");
    assert.equal(stored.organization_profile.organization_type, "commercial_bank");
    assert.ok(stored.input_snapshots.some((snapshot: { id: string; kind: string }) => snapshot.id === policy && snapshot.kind === "policy"));
    const manualPrompt = await app.inject({ method: "POST", url: "/api/assessments", headers, payload: { policy_document_ids: [policy], obligations: [{ id: "prompt", requirement: "user prompt" }] } });
    assert.equal(manualPrompt.statusCode, 400);
    const duplicate = await app.inject({ method: "POST", url: "/api/assessments", headers, payload: { policy_document_ids: [policy] } });
    assert.equal(duplicate.statusCode, 409);
    const cancelled = await app.inject({ method: "POST", url: `/api/assessments/${createdAssessment}/cancel`, headers, payload: {} });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal((await pool.query("SELECT status FROM assessments WHERE id=$1", [createdAssessment])).rows[0].status, "CANCELLED");
    const cancelledAgain = await app.inject({ method: "POST", url: `/api/assessments/${createdAssessment}/cancel`, headers, payload: {} });
    assert.equal(cancelledAgain.statusCode, 409);
    await pool.query("UPDATE assessments SET status='COMPLETED' WHERE id=$1", [createdAssessment]);
    let impactJobs=0;
    const impactBoss={send:async()=>{impactJobs++;return randomUUID();}} as unknown as PgBoss;
    await processDocumentImpact(policy,impactBoss);
    const impacts=await pool.query("SELECT id,baseline_assessment_id,policy_document_ids FROM assessments WHERE organization_id=$1 AND impact_document_id=$2",[orgA,policy]);
    assert.equal(impacts.rows.length,1);
    assert.equal(impacts.rows[0].baseline_assessment_id,createdAssessment);
    assert.deepEqual(impacts.rows[0].policy_document_ids,[policy]);
    await processDocumentImpact(policy,impactBoss);
    assert.equal(impactJobs,1,"Retries must not create duplicate impact assessments");
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    await app.close();
    await pool.query("DELETE FROM assessments WHERE organization_id = ANY($1::uuid[])", [[orgA, orgB]]);
    await pool.query("DELETE FROM regulatory_obligation_cache WHERE document_id = ANY($1::uuid[])", [documentIds]);
    await pool.query("DELETE FROM regulatory_sources WHERE id = $1", [sourceId]);
    await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
    await pool.query("DELETE FROM document_group_source_aliases WHERE document_group_id = ANY($1::uuid[])", [[groupA, groupB, groupP]]);
    await pool.query("DELETE FROM document_groups WHERE id = ANY($1::uuid[])", [[groupA, groupB, groupP]]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [[orgA, orgB]]);
    await pool.end();
  }
});
