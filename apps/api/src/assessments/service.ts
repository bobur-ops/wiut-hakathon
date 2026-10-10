import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { pool } from "../db.js";
import { compareWithOpenAI, type CompareFunction, type ObligationInput } from "./analysis.js";
import { searchPolicyEvidence, type EvidencePassage } from "../retrieval/search.js";

interface AssessmentJob { assessmentId: string }
interface SearchFunction {
  (input: { query: string; policy_document_ids: string[]; limit: number; organization_id?: string }): Promise<{ passages: EvidencePassage[] }>;
}

export function createAssessmentProcessor(options: {
  db: Pick<Pool, "query">;
  compare: CompareFunction;
  search: SearchFunction;
  model: string;
}) {
  return async function processAssessment({ assessmentId }: AssessmentJob) {
    const { rows } = await options.db.query<{
      id: string; policy_document_ids: string[]; obligations: ObligationInput[]; organization_id: string | null;
    }>(`UPDATE assessments SET status = 'PROCESSING', started_at = NOW(), error_message = NULL
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING id, policy_document_ids, obligations, organization_id`, [assessmentId]);
    const assessment = rows[0];
    if (!assessment) return;
    try {
      for (const obligation of assessment.obligations) {
        const retrieved = await options.search({
          query: obligation.requirement,
          policy_document_ids: assessment.policy_document_ids,
          limit: 5,
          organization_id: assessment.organization_id ?? undefined,
        });
        const analysis = await options.compare(obligation, retrieved.passages);
        const evidence = analysis.evidence.map((citation) => {
          const passage = retrieved.passages.find((item) => item.section_id === citation.section_id)!;
          return {
            ...citation,
            document_id: passage.document_id,
            filename: passage.filename,
            version_label: passage.version_label,
            content_hash: passage.content_hash,
            source_reference: passage.source_reference,
            page_start: passage.page_start,
            page_end: passage.page_end,
          };
        });
        await options.db.query(
          `INSERT INTO findings
            (id, assessment_id, obligation_id, classification, applicability, explanation, proposed_action, limitations, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
          [randomUUID(), assessment.id, obligation.id, analysis.classification, analysis.applicability,
            analysis.explanation, analysis.proposed_action, JSON.stringify(analysis.limitations), JSON.stringify(evidence)],
        );
      }
      await options.db.query(
        "UPDATE assessments SET status = 'COMPLETED', model_identifier = $2, completed_at = NOW() WHERE id = $1",
        [assessment.id, options.model],
      );
    } catch (error) {
      await options.db.query(
        "UPDATE assessments SET status = 'FAILED', error_message = $2, model_identifier = $3, completed_at = NOW() WHERE id = $1",
        [assessment.id, error instanceof Error ? error.message.slice(0, 1000) : "Assessment processing failed.", options.model],
      );
      throw error;
    }
  };
}

export const processAssessment = createAssessmentProcessor({
  db: pool,
  compare: compareWithOpenAI,
  search: searchPolicyEvidence,
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
});
