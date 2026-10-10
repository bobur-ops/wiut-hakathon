import assert from "node:assert/strict";
import test from "node:test";
import { validateAnalysis, type ObligationInput } from "../src/assessments/analysis.js";
import type { EvidencePassage } from "../src/retrieval/search.js";

const obligation: ObligationInput = { id: "test-1", citation: "Synthetic clause 1", requirement: "Keep customer records for review." };
const passage = {
  section_id: "section-1", document_id: "doc-1", filename: "synthetic-policy.txt",
  version_label: "v1", content_hash: "hash", heading: "Records", content: "We retain customer records for five years.",
  source_reference: "paragraph:3", page_start: 1, page_end: 1, score: 0.2,
} satisfies EvidencePassage;

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    applicability: "APPLICABLE",
    classification: "SUPPORTED_IN_POLICY",
    explanation: "The policy describes a retention process.",
    proposed_action: "Have a reviewer confirm the retention period.",
    limitations: [],
    evidence: [{ section_id: passage.section_id, excerpt: "We retain customer records for five years." }],
    ...overrides,
  };
}

test("validates exact evidence and associates finding with caller obligation", () => {
  const result = validateAnalysis(analysis(), obligation, [passage]);
  assert.equal(result.obligation_id, "test-1");
  assert.equal(result.classification, "SUPPORTED_IN_POLICY");
  assert.equal(result.evidence[0]?.excerpt, passage.content);
});

test("drops fabricated evidence and downgrades to review", () => {
  const result = validateAnalysis(analysis({ evidence: [{ section_id: "invented", excerpt: "made up" }] }), obligation, [passage]);
  assert.equal(result.classification, "REQUIRES_REVIEW");
  assert.deepEqual(result.evidence, []);
  assert.ok(result.limitations.some((item) => item.includes("failed exact source validation")));
});

test("does not allow a substantive finding without verified evidence", () => {
  const result = validateAnalysis(analysis({ evidence: [] }), obligation, [passage]);
  assert.equal(result.classification, "REQUIRES_REVIEW");
});

test("does not treat missing evidence as proof of a violation", () => {
  const result = validateAnalysis(analysis({ classification: "MISSING_EVIDENCE", evidence: [] }), obligation, []);
  assert.equal(result.classification, "MISSING_EVIDENCE");
});

test("rejects malformed structured model output", () => {
  assert.throws(() => validateAnalysis({ ...analysis(), applicability: "maybe" }, obligation, [passage]), /schema validation/);
});
