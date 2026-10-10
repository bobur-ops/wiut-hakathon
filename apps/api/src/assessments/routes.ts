import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { ASSESSMENT_QUEUE } from "../documents/queue.js";
import type { ObligationInput } from "./analysis.js";
import { CORPUS_LIMITATIONS, excludedCorpusSources, selectAssessmentCorpus } from "./corpus.js";

interface StartAssessment {
  assessment_date?: string;
  policy_document_ids: string[];
}

export function registerAssessmentRoutes(app: FastifyInstance, boss: PgBoss) {
  app.post<{ Params: { id: string } }>("/api/assessments/:id/cancel", {
    schema: { tags: ["Assessments"], summary: "Cancel a queued or processing assessment" },
  }, async (request, reply) => {
    const result = await pool.query(`UPDATE assessments SET status='CANCELLED',processing_stage='CANCELLED',cancelled_at=NOW(),completed_at=NOW()
      WHERE id=$1 AND organization_id=$2 AND status IN ('QUEUED','PROCESSING') RETURNING id,job_id`, [request.params.id, request.identity!.organization_id]);
    if (!result.rows[0]) return reply.code(409).send({ error: "Assessment is already finished or cancelled." });
    if (result.rows[0].job_id) await boss.cancel(ASSESSMENT_QUEUE, result.rows[0].job_id);
    return { status: "CANCELLED", assessment_id: request.params.id };
  });
  app.get("/api/assessment-corpus", { schema: { tags: ["Assessments"], summary: "Preview regulation snapshots used for organization-wide assessment" } }, async (request) => {
    const documents = await selectAssessmentCorpus(request.identity!.organization_id);
    const cached = await pool.query(`SELECT COUNT(*)::int AS snapshots,COALESCE(SUM(jsonb_array_length(obligations)),0)::int AS obligations FROM
      (SELECT DISTINCT ON (document_id) document_id,obligations FROM regulatory_obligation_cache
       WHERE document_id=ANY($1::uuid[]) AND extractor_version LIKE 'obligations-v3:%' ORDER BY document_id,extracted_at DESC) c`, [documents.map(d=>d.id)]);
    return { documents, excluded_sources: await excludedCorpusSources(request.identity!.organization_id, documents), limitations: CORPUS_LIMITATIONS,
      cached_snapshots: cached.rows[0].snapshots, cached_obligations: cached.rows[0].obligations,
      comparison_model: process.env.OPENAI_MODEL ?? "gpt-6-luna", batch_size: Number(process.env.ASSESSMENT_BATCH_SIZE ?? 8), budget_usd: Number(process.env.ASSESSMENT_MAX_COST_USD ?? 2) };
  });
  app.get("/api/reviews", { schema: { tags: ["Assessments"], summary: "List reviewer decisions in your workspace" } }, async (request) => {
    const result = await pool.query(`SELECT finding_reviews.id, finding_reviews.decision, finding_reviews.reviewer_identifier,
      finding_reviews.comment, finding_reviews.created_at, findings.obligation_id, findings.assessment_id
      FROM finding_reviews JOIN findings ON findings.id = finding_reviews.finding_id
      JOIN assessments ON assessments.id = findings.assessment_id
      WHERE assessments.organization_id = $1 ORDER BY finding_reviews.created_at DESC LIMIT 100`, [request.identity!.organization_id]);
    return { reviews: result.rows };
  });
  app.get("/api/assessments", { schema: { tags: ["Assessments"], summary: "List assessments in your workspace" } }, async (request) => {
    const result = await pool.query(`SELECT assessments.id, assessments.status, assessments.created_at,
      assessments.completed_at, assessments.error_message, COUNT(findings.id)::integer AS finding_count,
      COUNT(findings.id) FILTER (WHERE findings.review_status = 'PENDING')::integer AS pending_count
      FROM assessments LEFT JOIN findings ON findings.assessment_id = assessments.id
      WHERE assessments.organization_id = $1 GROUP BY assessments.id
      ORDER BY assessments.created_at DESC LIMIT 100`, [request.identity!.organization_id]);
    return { assessments: result.rows };
  });
  app.get<{ Params: { id: string } }>("/api/findings/:id/reviews", {
    schema: { tags: ["Assessments"], summary: "Get saved reviewer decisions for a finding", params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } },
  }, async (request) => {
    const result = await pool.query("SELECT id, decision, reviewer_identifier, comment, created_at FROM finding_reviews WHERE finding_id = $1 ORDER BY created_at DESC", [request.params.id]);
    return { reviews: result.rows };
  });
  app.post<{ Body: StartAssessment }>("/api/assessments", {
    schema: {
      tags: ["Assessments"], summary: "Assess policies against the imported regulatory corpus",
      description: "The server pins current observed or source-reviewed regulation snapshots, extracts draft obligations, and compares policies. No prompt is required. Effective dates remain unverified; findings require human review.",
      body: {
        type: "object", additionalProperties: false,
        required: ["policy_document_ids"],
        properties: {
          assessment_date: { type: "string", format: "date" },
          policy_document_ids: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", format: "uuid" } },
        },
      },
      response: {
        202: { type: "object", properties: { assessment_id: { type: "string", format: "uuid" }, status: { type: "string" }, created_at: { type: "string" } }, required: ["assessment_id", "status", "created_at"] },
        400: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
        503: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      },
    },
  }, async (request, reply) => {
    const active = await pool.query("SELECT id FROM assessments WHERE organization_id=$1 AND status IN ('QUEUED','PROCESSING') LIMIT 1", [request.identity!.organization_id]);
    if (active.rows[0]) return reply.code(409).send({ error: "An assessment is already queued or processing. Cancel it or wait before starting another." });
    if (!process.env.OPENAI_API_KEY) return reply.code(503).send({ error: "AI assessment is unavailable: OPENAI_API_KEY is not configured on the API server." });
    const policies = await pool.query("SELECT id, document_group_id, filename, content_hash, version_label, processing_status FROM documents WHERE id = ANY($1::uuid[]) AND organization_id = $2", [request.body.policy_document_ids, request.identity!.organization_id]);
    if (policies.rows.some((document) => !["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(document.processing_status))) return reply.code(409).send({ error: "Wait for policy extraction to finish before assessing." });
    const corpus = await selectAssessmentCorpus(request.identity!.organization_id);
    if (!corpus.length) return reply.code(409).send({ error: "No current regulatory snapshots are ready. Import and extract official regulation documents first." });
    const excluded = await excludedCorpusSources(request.identity!.organization_id, corpus);
    const baseline = await pool.query(`SELECT id FROM assessments WHERE organization_id=$1 AND status='COMPLETED'
      ORDER BY created_at DESC LIMIT 1`, [request.identity!.organization_id]);
    const id = randomUUID();
    const assessmentDate = request.body.assessment_date ?? new Date().toISOString().slice(0, 10);
    const created = await pool.query(
      `INSERT INTO assessments (id, status, assessment_date, policy_document_ids, obligations, organization_id,
        corpus_document_ids, organization_profile, input_snapshots, pipeline_version, coverage_warnings, baseline_assessment_id, comparison_model)
       VALUES ($1, 'QUEUED', $2, $3::uuid[], '[]'::jsonb, $4, $5::uuid[], $6::jsonb, $7::jsonb, 'incremental-v2', $8::jsonb, $9, $10) RETURNING created_at`,
      [id, assessmentDate, request.body.policy_document_ids, request.identity!.organization_id,
        corpus.map((document) => document.id), JSON.stringify({ organization_type: request.identity!.organization_type, activities: request.identity!.activities, assessment_date: assessmentDate }),
        JSON.stringify([...policies.rows.map((document) => ({ ...document, kind: "policy" })), ...corpus.map((document) => ({ ...document, kind: "regulation" }))]),
        JSON.stringify(excluded.map((group) => `Excluded source (no complete eligible snapshot with legal provisions; language placeholders must be replaced with the original text): ${group.title}`)),
        baseline.rows[0]?.id ?? null, process.env.OPENAI_MODEL ?? "gpt-6-luna"],
    ).catch((error: unknown) => { if ((error as { code?: string }).code === "23505") return null; throw error; });
    if (!created) return reply.code(409).send({ error: "An assessment is already queued or processing." });
    try {
      const job = await boss.send(ASSESSMENT_QUEUE, { assessmentId: id }, { retryLimit: 0, expireInSeconds: 7200 });
      if (!job) throw new Error("Queue did not accept the assessment.");
      await pool.query("UPDATE assessments SET job_id=$2 WHERE id=$1", [id, job]);
    } catch {
      await pool.query("UPDATE assessments SET status = 'FAILED', error_message = 'Could not enqueue assessment.' WHERE id = $1", [id]);
      return reply.code(503).send({ error: "Assessment could not be queued. Please retry." });
    }
    return reply.code(202).send({ assessment_id: id, status: "QUEUED", created_at: created.rows[0].created_at });
  });

  app.get<{ Params: { id: string } }>("/api/assessments/:id", {
    schema: { tags: ["Assessments"], summary: "Get assessment status and findings" },
  }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, status, assessment_date, policy_document_ids, obligations,
               model_identifier, error_message, created_at, started_at, completed_at,
               corpus_document_ids, organization_profile, input_snapshots, processing_stage, progress, pipeline_version, coverage_warnings,
               baseline_assessment_id,comparison_model,cancelled_at,change_summary
       FROM assessments WHERE id = $1`, [request.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: "Assessment not found." });
    const findings = await pool.query(
      `SELECT id, title, obligation_id, classification, applicability, explanation, proposed_action,change_status,reused_from_finding_id,
              limitations, evidence, review_status, created_at
       FROM findings WHERE assessment_id = $1 ORDER BY created_at, obligation_id`, [request.params.id],
    );
    const usage = await pool.query(`SELECT COUNT(*)::int AS requests,COALESCE(SUM(input_tokens),0)::int AS input_tokens,
      COALESCE(SUM(output_tokens),0)::int AS output_tokens,SUM(estimated_cost_usd)::float AS estimated_cost_usd,
      COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced_requests FROM assessment_ai_usage WHERE assessment_id=$1`, [request.params.id]);
    return { assessment: rows[0], findings: findings.rows, usage: usage.rows[0], budget_usd: Number(process.env.ASSESSMENT_MAX_COST_USD ?? 2), limitations: [...CORPUS_LIMITATIONS, ...rows[0].coverage_warnings] };
  });

  app.get<{ Params: { id: string } }>("/api/findings/:id", {
    schema: { tags: ["Assessments"], summary: "Get finding with regulatory and policy evidence", params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    const result = await pool.query(`SELECT findings.*, assessments.obligations, assessments.status AS assessment_status
      FROM findings JOIN assessments ON assessments.id = findings.assessment_id WHERE findings.id = $1 AND assessments.organization_id = $2`, [request.params.id, request.identity!.organization_id]);
    if (!result.rows[0]) return reply.code(404).send({ error: "Finding not found." });
    const { obligations, ...finding } = result.rows[0];
    const reviews = await pool.query("SELECT decision, reviewer_identifier, comment, created_at FROM finding_reviews WHERE finding_id = $1 ORDER BY created_at DESC", [finding.id]);
    return { finding, obligation: (obligations as ObligationInput[]).find((obligation) => obligation.id === finding.obligation_id) ?? null, reviews: reviews.rows };
  });

  app.post<{ Params: { id: string }; Body: { decision: "CONFIRMED" | "REJECTED" | "NEEDS_EVIDENCE"; reviewer_identifier?: string; comment?: string } }>("/api/findings/:id/review", {
    schema: {
      tags: ["Assessments"], summary: "Record a human decision on an AI finding",
      body: {
        type: "object", additionalProperties: false, required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["CONFIRMED", "REJECTED", "NEEDS_EVIDENCE"] },
          reviewer_identifier: { type: "string", minLength: 1, maxLength: 200 },
          comment: { type: "string", maxLength: 4000 },
        },
      },
      response: {
        200: { type: "object", properties: { finding_id: { type: "string" }, review_status: { type: "string" }, reviewed_at: { type: "string" } }, required: ["finding_id", "review_status", "reviewed_at"] },
        404: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      },
    },
  }, async (request, reply) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE findings SET review_status = $2 WHERE id = $1
         RETURNING id, review_status`, [request.params.id, request.body.decision],
      );
      if (!updated.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Finding not found." });
      }
      const reviewed = await client.query(
        `INSERT INTO finding_reviews (id, finding_id, decision, reviewer_identifier, comment)
         VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
        [randomUUID(), request.params.id, request.body.decision, request.identity!.email, request.body.comment ?? null],
      );
      await client.query("COMMIT");
      return { finding_id: request.params.id, review_status: updated.rows[0].review_status, reviewed_at: reviewed.rows[0].created_at };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
