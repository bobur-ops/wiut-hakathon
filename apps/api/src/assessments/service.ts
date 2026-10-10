import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { pool } from "../db.js";
import { compareWithOpenAI, compareBatchWithOpenAI, validateAnalysis, type AnalysisResult, type ComparisonInput, type CompareFunction, type ObligationInput } from "./analysis.js";
import { AssessmentCancelled, estimateCost, withAIContext } from "./openai.js";
import { searchPolicyEvidence, type EvidencePassage } from "../retrieval/search.js";
import { extractRegulatoryObligations } from "./extraction.js";
import type { CorpusDocument } from "./corpus.js";

interface AssessmentJob { assessmentId: string }
interface SearchFunction {
  (input: { query: string; policy_document_ids: string[]; limit: number; organization_id?: string }): Promise<{ passages: EvidencePassage[] }>;
}

export function createAssessmentProcessor(options: {
  db: Pick<Pool, "query">;
  compare: CompareFunction;
  search: SearchFunction;
  model: string;
  extract?: typeof extractRegulatoryObligations;
  compareBatch?: (inputs: ComparisonInput[], model: string) => Promise<AnalysisResult[]>;
  check?: (id: string) => Promise<void>;
  trackUsage?: boolean;
}) {
  return async function processAssessment({ assessmentId }: AssessmentJob) {
    const { rows } = await options.db.query<{
      id: string; policy_document_ids: string[]; obligations: ObligationInput[]; organization_id: string | null;
      corpus_document_ids: string[]; input_snapshots: (CorpusDocument & { kind: string })[];
      organization_profile: { organization_type: string; activities: string[] };
      comparison_model: string | null; baseline_assessment_id: string | null;
    }>(`UPDATE assessments SET status = 'PROCESSING', started_at = NOW(), error_message = NULL
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING id, policy_document_ids, obligations, organization_id, corpus_document_ids, input_snapshots, organization_profile, comparison_model, baseline_assessment_id`, [assessmentId]);
    const assessment = rows[0];
    if (!assessment) return;
    const check = async () => { await options.check?.(assessmentId); };
    const model = assessment.comparison_model ?? options.model;
    const run = async () => { try {
      const documents = assessment.input_snapshots.filter((snapshot) => snapshot.kind === "regulation");
      const failedSources: string[] = [];
      let processedSources = 0;
      if (assessment.corpus_document_ids.length) {
        if (documents.length !== assessment.corpus_document_ids.length) throw new Error("Regulatory snapshot manifest is incomplete. Assessment stopped.");
        assessment.obligations = [];
        for (const [index, document] of documents.entries()) {
          await check();
          await options.db.query("UPDATE assessments SET processing_stage = 'EXTRACTING_OBLIGATIONS', progress = $2::jsonb WHERE id = $1", [assessment.id, JSON.stringify({ regulations_completed: processedSources, regulations_failed: failedSources.length, regulations_attempted: index, regulations_total: documents.length, current_regulation: document.title })]);
          try {
            const extracted = await (options.extract ?? extractRegulatoryObligations)(document, async (done, total) => {
              await options.db.query("UPDATE assessments SET progress = $2::jsonb WHERE id = $1", [assessment.id, JSON.stringify({ regulations_completed: processedSources, regulations_failed: failedSources.length, regulations_attempted: index, regulations_total: documents.length, current_regulation: document.title, batches_completed: done, batches_total: total })]);
            });
            assessment.obligations.push(...extracted);
            await options.db.query("UPDATE assessments SET obligations = $2::jsonb WHERE id = $1", [assessment.id, JSON.stringify(assessment.obligations)]);
            processedSources++;
          } catch (error) {
            if (error instanceof AssessmentCancelled) throw error;
            const message = `Unassessed source: ${document.title} (${document.source_url ?? document.id}). ${error instanceof Error ? error.message : "Extraction failed"}`;
            failedSources.push(message);
            await options.db.query("UPDATE assessments SET coverage_warnings = coverage_warnings || $2::jsonb WHERE id = $1", [assessment.id, JSON.stringify([message])]);
          }
        }
        if (!assessment.obligations.length) throw new Error(failedSources.length ? failedSources.join("\n") : "No substantive obligations could be extracted from the selected corpus. No compliance conclusion can be generated.");
      }
      let completed = 0;
      let reused = 0;
      let batchesCompleted = 0;
      const pending: { input: ComparisonInput; key: string; evidenceKey: string }[] = [];
      const policyManifest = assessment.input_snapshots.filter(s => s.kind === "policy").map(s => [s.id, s.content_hash]).sort();
      const baseline = assessment.baseline_assessment_id ? await options.db.query("SELECT * FROM findings WHERE assessment_id=$1", [assessment.baseline_assessment_id]) : { rows: [] };
      const currentDuties = new Set<string>();
      const changes = { new: 0, changed: 0, resolved: 0, unchanged: 0, removed_from_scope: 0 };
      const publish = async (analysis: AnalysisResult, input: ComparisonInput, key: string, previous?: Record<string, unknown>) => {
        await check();
        const evidence = analysis.evidence.map(citation => ({ ...citation, ...input.passages.find(p => p.section_id === citation.section_id)! }));
        const id = randomUUID();
        const duty = dutyKey(input.obligation);
        currentDuties.add(duty);
        const old = baseline.rows.find(row => row.duty_key === duty);
        const resolved = old && ["POTENTIAL_CONFLICT","MISSING_EVIDENCE","REQUIRES_REVIEW"].includes(old.classification)
          && analysis.classification === "SUPPORTED_IN_POLICY";
        const change = previous ? "UNCHANGED" : resolved ? "RESOLVED" : old ? "CHANGED" : "NEW";
        if (change === "UNCHANGED") changes.unchanged++; else if (change === "RESOLVED") changes.resolved++; else if (change === "CHANGED") changes.changed++; else changes.new++;
        await options.db.query(`INSERT INTO findings
          (id,assessment_id,obligation_id,classification,applicability,explanation,proposed_action,limitations,evidence,title,comparison_key,change_status,reused_from_finding_id,review_status,duty_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (assessment_id,obligation_id) DO NOTHING`,
        [id, assessment.id, input.obligation.id, analysis.classification, analysis.applicability, analysis.explanation,
          analysis.proposed_action, JSON.stringify(analysis.limitations), JSON.stringify(evidence), analysis.title, key, change,
          previous?.id ?? null, previous?.review_status ?? "PENDING", duty]);
        if (previous) await options.db.query(`INSERT INTO finding_reviews (id,finding_id,decision,reviewer_identifier,comment,created_at)
          SELECT gen_random_uuid(),$1,decision,reviewer_identifier,comment,created_at FROM finding_reviews WHERE finding_id=$2`, [id, previous.id]);
        completed++;
        await options.db.query(`UPDATE assessments SET progress = jsonb_set(progress || $2::jsonb,'{obligations_completed}',
          to_jsonb(GREATEST(COALESCE((progress->>'obligations_completed')::integer,0),$3::integer))) WHERE id=$1 AND status='PROCESSING'`,
        [assessment.id, JSON.stringify({ reused_findings: reused }), completed]);
      };
      await options.db.query("UPDATE assessments SET processing_stage = 'COMPARING_POLICIES', progress = $2::jsonb WHERE id = $1", [assessment.id, JSON.stringify({ regulations_completed: processedSources, regulations_failed: failedSources.length, regulations_attempted: documents.length, regulations_total: documents.length, obligations_completed: 0, obligations_total: assessment.obligations.length })]);
      for (const obligation of assessment.obligations) {
        await check();
        const inputObligation = { ...obligation, organization_profile: assessment.organization_profile };
        const retrieved = await options.search({ query: obligation.retrieval_terms ?? obligation.requirement,
          policy_document_ids: assessment.policy_document_ids, limit: 5, organization_id: assessment.organization_id ?? undefined });
        const key = comparisonKey(obligation, policyManifest, assessment.organization_profile, model);
        const evidenceKey = comparisonKey(obligation, [assessment.input_snapshots.filter(s => s.kind === "policy").map(s => (s as CorpusDocument & { document_group_id?: string }).document_group_id ?? s.id).sort(),
          retrieved.passages.map(p => [p.source_reference,p.content]).sort()], assessment.organization_profile, model);
        const previous = await options.db.query(`SELECT f.* FROM findings f JOIN assessments a ON a.id=f.assessment_id
          WHERE a.organization_id=$1 AND a.status IN ('COMPLETED','FAILED','CANCELLED') AND f.comparison_key=ANY($2::text[]) ORDER BY a.created_at DESC LIMIT 1`, [assessment.organization_id, [key,evidenceKey]]);
        const input = { obligation: inputObligation, passages: retrieved.passages };
        if (previous.rows[0]) {
          const candidate = previous.rows[0];
          const remapped = candidate.evidence.map((citation: { section_id: string; excerpt: string }) => {
            const matches = retrieved.passages.filter(p => p.content.includes(citation.excerpt));
            return matches.length === 1 ? { section_id: matches[0]!.section_id, excerpt: citation.excerpt } : citation;
          });
          const validated = validateAnalysis({ ...candidate, evidence: remapped }, inputObligation, retrieved.passages);
          // Evidence must still be present; retrieval/version changes cannot silently reuse stale citations.
          if (validated.classification === candidate.classification && validated.evidence.length === candidate.evidence.length) {
            reused++;
            await publish(validated, input, candidate.comparison_key, candidate);
            continue;
          }
        }
        pending.push({ input, key, evidenceKey });
      }
      const size = boundedInteger(process.env.ASSESSMENT_BATCH_SIZE, 8, 1, 15);
      const batches: typeof pending[] = [];
      let batch: typeof pending = [];
      let length = 0;
      for (const row of pending) {
        const bytes = JSON.stringify(row.input).length;
        if (batch.length && (batch.length >= size || length + bytes > 50000)) { batches.push(batch); batch = []; length = 0; }
        batch.push(row); length += bytes;
      }
      if (batch.length) batches.push(batch);
      const estimate = estimateCost(model, Math.ceil(pending.reduce((total,row)=>total+JSON.stringify(row.input).length,0)/2)+batches.length*500,pending.length*300);
      await options.db.query("UPDATE assessments SET progress=progress || $2::jsonb WHERE id=$1", [assessment.id, JSON.stringify({ reused_findings: reused, comparison_batches_total: batches.length, pending_requirements: pending.length, estimated_comparison_cost_usd: estimate })]);
      const configured = Number(process.env.ASSESSMENT_COMPARISON_CONCURRENCY ?? 2);
      const concurrency = Number.isInteger(configured) && configured >= 1 && configured <= 5 ? configured : 3;
      await processConcurrently(batches, concurrency, async rows => {
        await check();
        const results = options.compareBatch ? await options.compareBatch(rows.map(row => row.input), model)
          : await Promise.all(rows.map(row => options.compare(row.input.obligation, row.input.passages)));
        if (results.length !== rows.length || new Set(results.map(r => r.obligation_id)).size !== rows.length) throw new Error("Comparison returned incomplete coverage");
        for (const row of rows) {
          const result = results.find(r => r.obligation_id === row.input.obligation.id);
          if (!result) throw new Error("Comparison omitted a requirement");
          const validated = validateAnalysis(result, row.input.obligation, row.input.passages);
          const savedKey = ["SUPPORTED_IN_POLICY","POTENTIAL_CONFLICT","NOT_APPLICABLE"].includes(validated.classification)
            ? row.evidenceKey : row.key;
          await publish(validated, row.input, savedKey);
        }
        batchesCompleted++;
        await options.db.query(`UPDATE assessments SET progress=jsonb_set(progress,'{comparison_batches_completed}',
          to_jsonb(GREATEST(COALESCE((progress->>'comparison_batches_completed')::integer,0),$2::integer))) WHERE id=$1 AND status='PROCESSING'`, [assessment.id,batchesCompleted]);
      });
      if (failedSources.length) throw new Error(`${failedSources.length} regulatory sources could not be assessed. Findings for other sources are saved; see coverage warnings for exact sources and errors.`);
      changes.removed_from_scope = baseline.rows.filter(row => row.duty_key && !currentDuties.has(row.duty_key)).length;
      await check();
      await options.db.query("UPDATE assessments SET change_summary=$2::jsonb WHERE id=$1 AND status='PROCESSING'", [assessment.id, JSON.stringify(changes)]);
      await options.db.query(
        "UPDATE assessments SET status = 'COMPLETED', processing_stage = 'COMPLETED', model_identifier = $2, completed_at = NOW(), progress = $3::jsonb WHERE id = $1 AND status='PROCESSING'",
        [assessment.id, model, JSON.stringify({ regulations_completed: documents.length, regulations_total: documents.length, obligations_completed: completed, obligations_total: assessment.obligations.length, reused_findings: reused, comparison_batches_completed: batchesCompleted, comparison_batches_total: batches.length })],
      );
    } catch (error) {
      if (error instanceof AssessmentCancelled) return;
      await options.db.query(
        "UPDATE assessments SET status = 'FAILED', processing_stage = 'FAILED', error_message = $2, model_identifier = $3, completed_at = NOW() WHERE id = $1 AND status='PROCESSING'",
        [assessment.id, error instanceof Error ? error.message.slice(0, 1000) : "Assessment processing failed.", model],
      );
      throw error;
    } };
    if (options.trackUsage) await withAIContext({ check, record: async usage => {
      await options.db.query(`INSERT INTO assessment_ai_usage (assessment_id,model,operation,input_tokens,output_tokens,cached_tokens,estimated_cost_usd,error_message)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS (SELECT 1 FROM assessments WHERE id=$1)`,
      [assessment.id, usage.model, usage.operation, usage.input_tokens, usage.output_tokens, usage.cached_tokens, usage.estimated_cost_usd, usage.error_message]);
    } }, run); else await run();
  };
}

export function comparisonKey(obligation: ObligationInput, policies: unknown, profile: { organization_type: string; activities: string[] }, model: string) {
  return createHash("sha256").update(JSON.stringify(["comparison-v2", model, obligation.requirement,
    obligation.regulation_evidence?.map(e => [e.source_reference, e.excerpt]), policies,
    profile.organization_type, [...profile.activities].sort()])).digest("hex");
}
function dutyKey(obligation: ObligationInput) {
  return createHash("sha256").update(JSON.stringify([obligation.title ?? obligation.requirement,
    obligation.regulation_evidence?.map(e => [e.title,e.source_reference]) ?? [obligation.citation]])).digest("hex");
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

export async function processConcurrently<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>) {
  let index = 0;
  let stopped = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && index < items.length) {
      const item = items[index++]!;
      try { await run(item); }
      catch (error) { stopped = true; throw error; }
    }
  }));
  // Let in-flight comparisons finish before marking a run FAILED; no background
  // writes can arrive after the terminal status or a caller has returned.
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export const processAssessment = createAssessmentProcessor({
  db: pool,
  compare: compareWithOpenAI,
  search: searchPolicyEvidence,
  model: process.env.OPENAI_MODEL ?? "gpt-6-luna",
  compareBatch: compareBatchWithOpenAI,
  trackUsage: true,
  check: async id => {
    const status = await pool.query("SELECT status FROM assessments WHERE id=$1", [id]);
    if (status.rows[0]?.status !== "PROCESSING") throw new AssessmentCancelled();
    const cost = await pool.query("SELECT COALESCE(SUM(estimated_cost_usd),0)::float AS cost FROM assessment_ai_usage WHERE assessment_id=$1", [id]);
    if (cost.rows[0].cost >= Number(process.env.ASSESSMENT_MAX_COST_USD ?? 2)) throw new Error("Assessment AI budget reached. Partial findings preserved.");
  },
});
