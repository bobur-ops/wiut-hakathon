import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "../src/db.js";
import { compareBatchWithOpenAI, type ComparisonInput, type ObligationInput } from "../src/assessments/analysis.js";
import { withAIContext } from "../src/assessments/openai.js";
import type { EvidencePassage } from "../src/retrieval/search.js";

// Explicit small live-model check, not a full assessment. No findings are stored.
if (!process.argv.includes("--live")) throw new Error("Use --live to run this six-case provider check (incurs API usage).");
try {
  const baseline = (await pool.query(`SELECT obligations,organization_profile FROM assessments
    WHERE status='COMPLETED' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  if (!baseline) throw new Error("A completed assessment is required for source-backed cases.");
  const obligations = baseline.obligations as ObligationInput[];
  const profile = { organization_type: "commercial_bank", activities: ["Retail bank accounts", "Payer-bank and beneficiary-bank payment services", "Customer personal-data processing"] };
  function source(pattern: RegExp) {
    const obligation = obligations.find(o => pattern.test(o.requirement));
    if (!obligation) throw new Error(`Missing corpus case: ${pattern}`);
    return { ...obligation, organization_profile: profile };
  }
  function passage(content: string): EvidencePassage {
    return { section_id: createHash("sha256").update(content).digest("hex"), document_id: "demo-policy", filename: "synthetic-check.txt", version_label: "test",
      content_hash: "synthetic", heading: null, content, source_reference: "paragraph:1", page_start: null, page_end: null, score: 1 };
  }
  const retention = source(/retain information identifying the payer/i);
  const cases: { name: string; expected: string; input: ComparisonInput }[] = [
    { name: "Central Bank rulemaking", expected: "NOT_APPLICABLE", input: { obligation: source(/Central Bank Board must approve rules for conducting financial operations/i), passages: [] } },
    { name: "Regulator sanctioning power", expected: "NOT_APPLICABLE", input: { obligation: source(/Central Bank may apply simultaneously/i), passages: [] } },
    { name: "Explicit short retention", expected: "POTENTIAL_CONFLICT", input: { obligation: { ...retention,id:"retention-short" }, passages:[passage("Payer and beneficiary identification records are deleted three years after the payment service.")] } },
    { name: "Sufficient retention", expected: "SUPPORTED_IN_POLICY", input: { obligation: { ...retention,id:"retention-long" }, passages:[passage("Payer and beneficiary identification records must be retained for at least five years after the payment service; longer legal holds take precedence.")] } },
    { name: "Missing direct-bank control", expected: "MISSING_EVIDENCE", input: { obligation: source(/value date specified in the payment document cannot exceed ten days/i), passages: [] } },
    { name: "Unknown operator role", expected: "REQUIRES_REVIEW", input: { obligation: source(/payment system operator must establish payment system rules/i), passages: [] } },
  ];
  const started = Date.now();
  const results = await withAIContext({ check: async()=>{}, record: async usage=>console.log(JSON.stringify({ usage })) },
    ()=>compareBatchWithOpenAI(cases.map(c=>c.input), process.env.OPENAI_MODEL ?? "gpt-6-luna"));
  for (const item of cases) {
    const result=results.find(r=>r.obligation_id===item.input.obligation.id);
    console.log(JSON.stringify({case:item.name,expected:item.expected,actual:result?.classification,explanation:result?.explanation}));
    assert.equal(result?.classification,item.expected,item.name);
  }
  console.log(JSON.stringify({passed:cases.length,elapsed_ms:Date.now()-started,stored_findings:0}));
} finally { await pool.end(); }
