import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { extractionBatches, extractBatchWithRetries, outputSchema, validateExtractedObligations } from "../src/assessments/extraction.js";
import { createAssessmentProcessor, processConcurrently } from "../src/assessments/service.js";
import type { CorpusDocument } from "../src/assessments/corpus.js";
import { scopeAssessmentCorpus, selectIncrementalCorpus } from "../src/assessments/corpus.js";
import { validateAnalysis } from "../src/assessments/analysis.js";
import type { EvidencePassage } from "../src/retrieval/search.js";

const document: CorpusDocument = { id: "regulation-1", title: "Synthetic regulation", filename: "synthetic.txt", content_hash: "hash", source_url: null, version_label: "v1", revision_date: null, source_reviewed: false };
const legalText = "Banks must retain customer records for five years, unless another provision applies.";
const section = { id: "section-1", content: legalText, heading: null, source_reference: "article:1" };

test("manual assessment regulation scope defaults to all and validates focused eligible subsets", () => {
  const all = [document,{...document,id:"regulation-2",document_group_id:"group-2"}];
  assert.deepEqual(scopeAssessmentCorpus(all).documents,all);
  assert.equal(scopeAssessmentCorpus(all,["regulation-2"]).omitted,1);
  assert.deepEqual(scopeAssessmentCorpus(all,["regulation-2"]).documents.map(item=>item.id),["regulation-2"]);
  assert.throws(()=>scopeAssessmentCorpus(all,[]),/one or more/);
  assert.throws(()=>scopeAssessmentCorpus(all,["foreign"]),/eligible/);
});

test("incremental impact preserves the baseline regulation scope and appends only a newly discovered act", () => {
  const docs=[{...document,document_group_id:"group-1"},{...document,id:"group-2-doc",document_group_id:"group-2"},{...document,id:"new-act",document_group_id:"new-group"}];
  const baseline=[{kind:"regulation",document_group_id:"group-1"},{kind:"legislation",document_group_id:"old-act-group"}];
  assert.deepEqual(selectIncrementalCorpus(docs,baseline,"group-2-doc",false).map(item=>item.id),["regulation-1"]);
  assert.deepEqual(selectIncrementalCorpus(docs,baseline,"new-act",true).map(item=>item.id),["regulation-1","new-act"]);
});

test("extraction batches cover every source section and long clauses without truncating the corpus", () => {
  const sections = [section, { ...section, id: "long", content: "x".repeat(18000) }, { ...section, id: "last", content: "Last legal provision" }];
  const batches = extractionBatches(sections);
  const chunks = batches.flat();
  assert.ok(chunks.every((chunk) => chunk.content.length <= 6000));
  assert.deepEqual(new Set(chunks.map((chunk) => chunk.id)), new Set(["section-1", "long", "last"]));
  for (const offset of [0, 5800, 11600, 17400]) assert.ok(chunks.some((chunk) => chunk.chunk_id === `long:${offset}`));
});

test("extracted obligations retain exact legal evidence, qualifications and draft status", () => {
  const chunks = extractionBatches([section])[0]!;
  const result = validateExtractedObligations({ obligations: [{ title: "Customer record retention", requirement: legalText, citations: [{ chunk_id: chunks[0]!.chunk_id, excerpt: legalText }] }] }, chunks, document);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.extraction_status, "AI_DRAFT");
  assert.equal(result[0]?.regulation_evidence?.[0]?.excerpt, legalText);
  assert.equal(result[0]?.regulation_evidence?.[0]?.content_hash, "hash");
  assert.throws(() => validateExtractedObligations({ obligations: [{ title: "Fake", requirement: "invented", citations: [{ chunk_id: chunks[0]!.chunk_id, excerpt: "not in law" }] }] }, chunks, document), /exact source validation/);
});

test("uncertain applicability does not produce an actionable conflict classification", () => {
  const result = validateAnalysis({ applicability: "UNCERTAIN", classification: "POTENTIAL_CONFLICT", explanation: "Scope unknown", proposed_action: "Review scope", limitations: [], evidence: [] }, { id: "one", citation: "synthetic", requirement: legalText }, []);
  assert.equal(result.classification, "REQUIRES_REVIEW");
  const excluded = validateAnalysis({ applicability: "NOT_APPLICABLE", classification: "MISSING_EVIDENCE", explanation: "Explicit exclusion", proposed_action: "No policy change proposed", limitations: [], evidence: [] }, { id: "two", citation: "synthetic", requirement: legalText }, []);
  assert.equal(excluded.classification, "NOT_APPLICABLE");
});

function processorDb(documents = [document]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    return { rows: sql.includes("RETURNING id, policy_document_ids") ? [{
      id: "assessment-1", policy_document_ids: ["policy-1"], obligations: [], organization_id: "org-1",
      corpus_document_ids: documents.map(d => d.id), input_snapshots: documents.map(d => ({ ...d, kind: "regulation" })),
      organization_profile: { organization_type: "commercial_bank", activities: ["retail banking"] },
    }] : [] };
  };
  return { db: { query } as unknown as Pick<Pool, "query">, calls };
}

test("corpus processor extracts source-linked obligations and persists validated findings without a user prompt", async () => {
  const { db, calls } = processorDb();
  const passage: EvidencePassage = { section_id: "policy-section", document_id: "policy-1", filename: "synthetic-policy.txt", version_label: "v1", content_hash: "policy-hash", heading: null, content: "Records are retained for three years.", source_reference: "paragraph:1", page_start: null, page_end: null, score: 0.1 };
  const processor = createAssessmentProcessor({ db, model: "mock-model",
    extract: async (doc, report) => { await report(1, 1); return validateExtractedObligations({ obligations: [{ title: "Record retention", requirement: legalText, citations: [{ chunk_id: "section-1:0", excerpt: legalText }] }] }, extractionBatches([section])[0]!, doc); },
    search: async (input) => { assert.equal(input.organization_id, "org-1"); return { passages: [passage] }; },
    compare: async (obligation, passages) => {
      assert.equal(obligation.organization_profile?.organization_type, "commercial_bank");
      return validateAnalysis({ title: "Retention period may be too short", applicability: "APPLICABLE", classification: "POTENTIAL_CONFLICT", explanation: "Three years differs from five years.", proposed_action: "Review the retention period.", limitations: [], evidence: [{ section_id: passage.section_id, excerpt: passage.content }] }, obligation, passages);
    },
  });
  await processor({ assessmentId: "assessment-1" });
  const insert = calls.find((call) => call.sql.includes("INSERT INTO findings"));
  assert.equal(insert?.values[3], "POTENTIAL_CONFLICT");
  assert.equal(insert?.values[9], "Retention period may be too short");
  assert.match(String(insert?.values[8]), /policy-hash/);
  assert.ok(calls.some((call) => call.sql.includes("status = 'COMPLETED'")));
  assert.ok(calls.some((call) => call.sql.includes("obligations = $2::jsonb") && String(call.values[1]).includes("AI_DRAFT")));
});

test("server materializes exact source quotes and retries invalid source identifiers", async () => {
  const chunks = extractionBatches([section])[0]!;
  const attempts: { attempt: number; error: string | null }[] = [];
  let calls = 0;
  const obligations = await extractBatchWithRetries(document, chunks, async (feedback) => {
    calls++;
    if (calls === 2) assert.match(feedback!, /source validation/);
    return { obligations: [{ title: "Retention", requirement: legalText,
      citations: [{ chunk_id: calls === 1 ? "invented-id" : chunks[0]!.chunk_id }] }] };
  }, async (attempt, _response, error) => { attempts.push({ attempt, error }); });
  assert.equal(calls, 2);
  assert.equal(attempts[0]?.attempt, 1);
  assert.equal(attempts[1]?.error, null);
  assert.equal(obligations[0]?.regulation_evidence?.[0]?.excerpt, legalText);
});

test("structured extraction restricts citations to short batch-local IDs while storing original section IDs", () => {
  const schema = outputSchema(["S1", "S2"]);
  assert.deepEqual(schema.properties.obligations.items.properties.citations.items.properties.chunk_id.enum, ["S1", "S2"]);
  const chunks = [{ ...section, chunk_id: "S1" }];
  const result = validateExtractedObligations({ obligations: [{ title: "Retention", requirement: legalText,
    citations: [{ chunk_id: "S1" }] }] }, chunks, document);
  assert.equal(result[0]?.regulation_evidence?.[0]?.section_id, section.id);
  assert.equal(result[0]?.regulation_evidence?.[0]?.excerpt, legalText);
});

test("citation repair is bounded and never accepts fabricated evidence", async () => {
  let calls = 0;
  await assert.rejects(extractBatchWithRetries(document, extractionBatches([section])[0]!, async () => {
    calls++;
    return { obligations: [{ title: "Retention", requirement: legalText, citations: [{ chunk_id: "fake" }] }] };
  }, async () => {}), /failed after 3 attempts/);
  assert.equal(calls, 3);
});

test("one failing regulatory source does not prevent findings for other sources", async () => {
  const { db, calls } = processorDb([document, { ...document, id: "regulation-2", title: "Second regulation" }]);
  const processor = createAssessmentProcessor({ db, model: "mock-model", extract: async (source) => {
    if (source.id === document.id) throw new Error("Invalid citation");
    return [{ id: "second-duty", title: "Retention", citation: "Second regulation", requirement: legalText }];
  }, search: async () => ({ passages: [] }), compare: async obligation => validateAnalysis({ applicability: "APPLICABLE",
    classification: "MISSING_EVIDENCE", explanation: "No match", proposed_action: "Review policy", limitations: [], evidence: [] }, obligation, []) });
  await assert.rejects(processor({ assessmentId: "assessment-1" }), /1 regulatory sources could not be assessed/);
  assert.ok(calls.some(call => call.sql.includes("INSERT INTO findings")));
  assert.ok(calls.some(call => call.sql.includes("coverage_warnings") && String(call.values[1]).includes("Invalid citation")));
  assert.ok(!calls.some(call => call.sql.includes("status = 'COMPLETED'")));
});

test("failed extraction cannot mark corpus assessment complete", async () => {
  const { db, calls } = processorDb();
  const processor = createAssessmentProcessor({ db, model: "mock-model", extract: async () => { throw new Error("Invalid source citation"); }, search: async () => ({ passages: [] }), compare: async () => { throw new Error("Should not compare"); } });
  await assert.rejects(processor({ assessmentId: "assessment-1" }), /Invalid source citation/);
  assert.ok(calls.some((call) => call.sql.includes("status = 'FAILED'")));
  assert.ok(!calls.some((call) => call.sql.includes("status = 'COMPLETED'")));
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO findings")));
});

test("comparison failures stop new work and settle in-flight work before returning", async () => {
  const finished: number[] = [];
  await assert.rejects(processConcurrently([0, 1, 2, 3], 2, async (item) => {
    if (item === 0) throw new Error("Provider failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    finished.push(item);
  }), /Provider failed/);
  assert.deepEqual(finished, [1]);
});

test("multiple requirements are compared in one provider batch rather than individual calls", async () => {
  const {db,calls}=processorDb();
  let batches=0;
  const processor=createAssessmentProcessor({db,model:"mock",extract:async()=>[1,2,3].map(n=>({id:String(n),citation:"synthetic",requirement:"Retain records"})),search:async()=>({passages:[]}),
    compare:async()=>{throw new Error("Individual calls should not run");},
    compareBatch:async inputs=>{batches++;return inputs.map(input=>validateAnalysis({applicability:"APPLICABLE",classification:"MISSING_EVIDENCE",explanation:"Not found",proposed_action:"Review policy",limitations:[],evidence:[]},input.obligation,[]));}});
  await processor({assessmentId:"assessment-1"});
  assert.equal(batches,1);
  assert.equal(calls.filter(call=>call.sql.includes("INSERT INTO findings")).length,3);
});

test("validated unchanged findings are reused without an AI comparison", async () => {
  const {db,calls}=processorDb();
  const query=db.query.bind(db);
  const wrapped={query:async(sql: string,values: unknown[])=>sql.includes("SELECT f.*")?{rows:[{id:"previous",obligation_id:"cached",title:"Retention",classification:"MISSING_EVIDENCE",applicability:"APPLICABLE",explanation:"Not found",proposed_action:"Review policy",limitations:[],evidence:[],review_status:"CONFIRMED",comparison_key:"key"}]}:query(sql,values)} as unknown as Pick<Pool,"query">;
  const processor=createAssessmentProcessor({db:wrapped,model:"mock",extract:async()=>[{id:"cached",citation:"synthetic",requirement:"Retain records"}],search:async()=>({passages:[]}),compare:async()=>{throw new Error("Reuse should avoid AI");}});
  await processor({assessmentId:"assessment-1"});
  const insert=calls.find(call=>call.sql.includes("INSERT INTO findings"));
  assert.equal(insert?.values[11],"UNCHANGED");
  assert.equal(insert?.values[12],"previous");
  assert.equal(insert?.values[13],"CONFIRMED");
});
