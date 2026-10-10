import assert from "node:assert/strict";
import test from "node:test";
import { compareSections, type ComparableSection } from "../src/documents/compare.js";
import { extractDocument } from "../src/documents/extract.js";

function paragraph(reference: string, text: string, article = "1", parent = `article:${article}`): ComparableSection {
  return {
    section_type: "PARAGRAPH",
    source_reference: reference,
    normalized_content: text,
    parent_source_reference: parent,
    parent_content: `Статья ${article}. Scope`,
  };
}

test("reserves exact matches before matching similar paragraphs", () => {
  const result = compareSections([
    paragraph("p1", "Banks must retain records"),
    paragraph("p2", "Banks must retain records for five years"),
  ], [paragraph("q1", "Banks must retain records for five years")]);
  assert.equal(result.summary.modified, 0);
  assert.equal(result.summary.removed, 1);
  assert.equal(result.summary.added, 0);
  assert.equal(result.changes[0]?.source_reference, "p1");
});

test("recognizes a stable-ID paragraph moved to a different article", () => {
  const result = compareSections([paragraph("p", "Keep records", "1")], [paragraph("p", "Keep records", "2")]);
  assert.equal(result.summary.modified, 1);
});

test("does not mark regenerated parent IDs as moves", () => {
  const result = compareSections([paragraph("p", "Keep records", "1", "old")], [paragraph("p", "Keep records", "1", "new")]);
  assert.deepEqual(result.changes, []);
});

test("matches a text edit with changed IDs and flags the heuristic for review", () => {
  const result = compareSections([paragraph("old", "Banks must retain records for five years")],
    [paragraph("new", "Banks must retain records for seven years")]);
  assert.equal(result.summary.modified, 1);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.removed, 0);
  assert.equal(result.changes[0]?.needs_review, true);
});

test("does not force equally plausible paragraph matches", () => {
  const result = compareSections([
    paragraph("a", "Banks must retain five records"),
    paragraph("b", "Banks must retain seven records"),
  ], [paragraph("c", "Banks must retain ten records")]);
  assert.equal(result.summary.modified, 0);
  assert.equal(result.summary.removed, 2);
  assert.equal(result.summary.added, 1);
  assert.ok(result.changes.every((change) => change.needs_review));
});

test("matches the closest pair regardless of previous paragraph order", () => {
  const result = compareSections([
    paragraph("a", "Banks must keep records"),
    paragraph("b", "Banks must retain records for five years"),
  ], [paragraph("c", "Banks must retain records for seven years")]);
  const modified = result.changes.find((change) => change.change_type === "MODIFIED");
  assert.equal(modified?.previous_text, "Banks must retain records for five years");
});

test("TXT references are unique across pages including empty pages", async () => {
  const result = await extractDocument(Buffer.from("First\f\fSecond\n\nThird"), "text/plain");
  assert.deepEqual(result.sections.map((section) => section.sourceReference), [
    "page:1:paragraph:1", "page:3:paragraph:1", "page:3:paragraph:2",
  ]);
});

test("single-page TXT retains paragraph references", async () => {
  const result = await extractDocument(Buffer.from("First\n\nSecond"), "text/plain");
  assert.deepEqual(result.sections.map((section) => section.sourceReference), ["paragraph:1", "paragraph:2"]);
});
