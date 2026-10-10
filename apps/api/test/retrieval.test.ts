import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { QueryResultRow } from "pg";
import { pool } from "../src/db.js";
import { registerRetrievalRoutes } from "../src/retrieval/routes.js";
import { buildSearchQuery, EvidenceSearchError, searchPolicyEvidence } from "../src/retrieval/search.js";

const documentId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const input = { query: "retain records", policy_document_ids: [documentId] };

function mockDb(documents: QueryResultRow[], passages: QueryResultRow[] = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  return {
    calls,
    async query<T extends QueryResultRow>(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rows: (calls.length === 1 ? documents : passages) as T[] };
    },
  };
}

test("search tokenizes Russian and Uzbek without accepting tsquery operators", () => {
  assert.equal(buildSearchQuery("БАНК банк O‘zbekiston ma'lumot ! & | :*"), "банк | o | zbekiston | ma | lumot");
  assert.equal(buildSearchQuery(" & | ! "), "");
  assert.equal(buildSearchQuery(Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")).split(" | ").length, 64);
});

test("search rejects missing, regulatory, and unfinished documents", async () => {
  for (const [documents, status] of [
    [[], 404],
    [[{ id: documentId, document_type: "regulation", processing_status: "COMPLETED" }], 400],
    [[{ id: documentId, document_type: "policy", processing_status: "PROCESSING" }], 409],
  ] as const) {
    await assert.rejects(searchPolicyEvidence(input, mockDb([...documents])),
      (error: unknown) => error instanceof EvidenceSearchError && error.statusCode === status);
  }
});

test("search preserves original evidence and parameters; no match stays empty", async () => {
  const documents = [{ id: documentId, document_type: "policy", processing_status: "COMPLETED_WITH_WARNINGS" }];
  const passage = { content: "Original policy excerpt.", source_reference: "page:1:paragraph:2" };
  const db = mockDb(documents, [passage]);
  const result = await searchPolicyEvidence({ ...input, limit: 3 }, db);
  assert.deepEqual(result.passages, [passage]);
  assert.deepEqual(db.calls[1]?.values, [[documentId], "retain | records", 3]);
  const empty = await searchPolicyEvidence(input, mockDb(documents));
  assert.deepEqual(empty.passages, []);
  assert.ok(empty.limitations.some((text) => text.includes("not proof of a violation")));
});

test("evidence search route validates inputs and exposes extraction errors", async () => {
  const app = Fastify();
  let calls = 0;
  registerRetrievalRoutes(app, async () => {
    calls++;
    throw new EvidenceSearchError(409, "Extraction is still running.");
  });
  try {
    for (const body of [
      { ...input, policy_document_ids: [] },
      { ...input, policy_document_ids: ["not-a-uuid"] },
      { ...input, policy_document_ids: [documentId, documentId] },
      { ...input, limit: 21 },
      { ...input, query: "" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/policy-evidence/search", payload: body });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls, 0);
    const response = await app.inject({ method: "POST", url: "/api/policy-evidence/search", payload: input });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "Extraction is still running.");
  } finally {
    await app.close();
  }
});

test("evidence search response includes original text and citation metadata", async () => {
  const app = Fastify();
  registerRetrievalRoutes(app, async (request) => ({
    query: request.query,
    retrieval_method: "postgresql_full_text_simple",
    limitations: ["Lexical search only."],
    passages: [{
      section_id: otherId, document_id: documentId, filename: "synthetic.txt",
      version_label: "v1", content_hash: "hash", heading: null,
      content: "Keep original records.", source_reference: "page:1:paragraph:1",
      page_start: 1, page_end: 1, score: 0.1,
    }],
  }));
  try {
    const response = await app.inject({ method: "POST", url: "/api/policy-evidence/search", payload: input });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().passages[0].content, "Keep original records.");
    assert.equal(response.json().passages[0].content_hash, "hash");
    assert.equal(response.json().passages[0].source_reference, "page:1:paragraph:1");
  } finally {
    await app.close();
  }
});

test("PostgreSQL retrieval ranks matches, isolates selected snapshots, and keeps multilingual references", {
  skip: process.env.RUN_DB_TESTS !== "1",
}, async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Temporary tables shadow application tables; no real documents are changed.
    await client.query(`
      CREATE TEMP TABLE documents (
        id UUID, document_type TEXT, processing_status TEXT, filename TEXT,
        version_label TEXT, content_hash TEXT
      ) ON COMMIT DROP;
      CREATE TEMP TABLE document_sections (
        id UUID, document_id UUID, section_index INTEGER, section_type TEXT,
        heading TEXT, content TEXT, source_reference TEXT, page_start INTEGER, page_end INTEGER
      ) ON COMMIT DROP;
    `);
    await client.query(`INSERT INTO documents VALUES
      ($1, 'policy', 'COMPLETED', 'synthetic.txt', 'v1', 'synthetic-hash'),
      ($2, 'policy', 'COMPLETED', 'unselected.txt', 'v1', 'other-hash')`, [documentId, otherId]);
    const texts = ["retain records", "retain", "Банк хранит документы", "Mijoz ma’lumotlarini saqlash"];
    for (const [i, content] of texts.entries()) {
      await client.query(`INSERT INTO document_sections VALUES
        (gen_random_uuid(), $1, $2, 'PARAGRAPH', NULL, $3, $4, 1, 1)`,
      [documentId, i, content, `page:1:paragraph:${i + 1}`]);
    }
    await client.query(`INSERT INTO document_sections VALUES
      (gen_random_uuid(), $1, 0, 'PARAGRAPH', NULL, 'retain records', 'other', 1, 1),
      (gen_random_uuid(), $2, 99, 'DOCUMENT_TITLE', NULL, 'retain records', 'title', 1, 1)`, [otherId, documentId]);
    const result = await searchPolicyEvidence(input, client);
    assert.equal(result.passages.length, 2);
    assert.equal(result.passages[0]?.content, "retain records");
    assert.ok(result.passages[0]!.score > result.passages[1]!.score);
    assert.ok(result.passages.every((passage) => passage.document_id === documentId));
    for (const query of ["документы", "ma’lumotlarini"]) {
      const multilingual = await searchPolicyEvidence({ ...input, query }, client);
      assert.equal(multilingual.passages.length, 1);
      assert.match(multilingual.passages[0]!.source_reference!, /^page:1:paragraph:/);
    }
    assert.deepEqual((await searchPolicyEvidence({ ...input, query: "unmatchedword" }, client)).passages, []);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
