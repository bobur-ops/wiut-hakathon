import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost, structuredOpenAI, withAIContext, AssessmentCancelled } from "../src/assessments/openai.js";
import { comparisonKey } from "../src/assessments/service.js";
import { reuseUnchangedObligations } from "../src/assessments/extraction.js";
import type { CorpusDocument } from "../src/assessments/corpus.js";

test("Luna cost estimate includes cached tokens and reports unknown models as unpriced", () => {
  assert.equal(estimateCost("gpt-6-luna", 1_000_000, 1_000_000), 0.6);
  assert.equal(estimateCost("gpt-4.1-mini", 1_000_000, 1_000_000), 2);
  assert.equal(estimateCost("unknown-model", 10, 10), null);
});

test("comparison fingerprints ignore legal snapshot IDs but invalidate on policy/profile/model changes", () => {
  const obligation = { id: "one", citation: "law", requirement: "Retain five years" };
  const profile = { organization_type: "commercial_bank", activities: ["payments", "banking"] };
  const key = comparisonKey(obligation, [["policy","hash"]], profile, "gpt-6-luna");
  assert.equal(key, comparisonKey({ ...obligation,id: "new-snapshot-duty" }, [["policy","hash"]], { ...profile, activities: ["banking","payments"] }, "gpt-6-luna"));
  assert.notEqual(key, comparisonKey(obligation, [["policy","changed"]], profile, "gpt-6-luna"));
  assert.notEqual(key, comparisonKey(obligation, [["policy","hash"]], profile, "gpt-4.1-mini"));
});

test("incremental legal extraction carries only exact unchanged legal evidence to new snapshots", () => {
  const doc: CorpusDocument = { id:"new",title:"Law",filename:"new.html",content_hash:"newhash",source_url:null,version_label:"v2",revision_date:null,source_reviewed:false };
  const duties = [{ id:"old-duty",citation:"law",requirement:"Retain five years",regulation_evidence:[{section_id:"old-section",document_id:"old",title:"Law",source_reference:"article:1",excerpt:"Retain five years",source_url:null,version_label:"v1",content_hash:"oldhash"}] }];
  const carried = reuseUnchangedObligations(duties,[{id:"new-section",content:"Retain five years",heading:null,source_reference:"article:1"}],doc);
  assert.equal(carried[0]?.regulation_evidence?.[0]?.document_id,"new");
  assert.equal(carried[0]?.regulation_evidence?.[0]?.section_id,"new-section");
  assert.equal(reuseUnchangedObligations(duties,[{id:"new-section",content:"Retain six years",heading:null,source_reference:"article:1"}],doc).length,0);
});

test("HTTP 520 is retried, Luna request omits temperature, and usage is recorded", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-unused";
  let attempts=0;
  const recorded: unknown[]=[];
  globalThis.fetch = async (_url, options) => {
    attempts++;
    const body=JSON.parse(String(options?.body));
    assert.equal(body.model,"gpt-6-luna");
    assert.equal(body.temperature,undefined);
    if (attempts===1) return new Response("Temporary failure",{status:520});
    return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:"{}"}}],usage:{prompt_tokens:100,completion_tokens:20}}),{status:200});
  };
  try {
    await withAIContext({check:async()=>{},record:async usage=>{recorded.push(usage);}},()=>structuredOpenAI("test",{},"test",{}, {model:"gpt-6-luna"}));
    assert.equal(attempts,2);
    assert.equal(recorded.length,2);
  } finally { globalThis.fetch=originalFetch; if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey; }
});

test("cancelled assessments never start another provider request", async () => {
  const originalKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY="test-unused";
  try {
    await assert.rejects(withAIContext({check:async()=>{throw new AssessmentCancelled();},record:async()=>{}},()=>structuredOpenAI("test",{},"test",{})),AssessmentCancelled);
  } finally {if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;}
});

test("cancellation aborts an in-flight provider request", async () => {
  const originalFetch=globalThis.fetch;
  const originalKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY="test-unused";
  let checks=0;
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{
    const signal=options!.signal!;
    signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
  });
  try {
    await assert.rejects(withAIContext({check:async()=>{if(++checks>1)throw new AssessmentCancelled();},record:async()=>{}},()=>structuredOpenAI("test",{},"test",{})),AssessmentCancelled);
    assert.ok(checks>=2);
  } finally {globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;}
});
