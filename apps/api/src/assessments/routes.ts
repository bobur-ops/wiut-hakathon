import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { ASSESSMENT_QUEUE } from "../documents/queue.js";
import type { ObligationInput } from "./analysis.js";

interface StartAssessment {
  assessment_date?: string;
  policy_document_ids: string[];
  obligations: ObligationInput[];
}

export function registerAssessmentRoutes(app: FastifyInstance, boss: PgBoss) {
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
      tags: ["Assessments"], summary: "Start a synthetic-data policy assessment",
      description: "Obligations are supplied by the caller and are not verified legal advice. AI findings require human review. Requires OPENAI_API_KEY on the worker.",
      body: {
        type: "object", additionalProperties: false,
        required: ["policy_document_ids", "obligations"],
        properties: {
          assessment_date: { type: "string", format: "date" },
          policy_document_ids: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", format: "uuid" } },
          obligations: {
            type: "array", minItems: 1, maxItems: 20,
            items: {
              type: "object", additionalProperties: false, required: ["id", "citation", "requirement"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 100 },
                citation: { type: "string", minLength: 1, maxLength: 500 },
                requirement: { type: "string", minLength: 10, maxLength: 4000 },
              },
            },
          },
        },
      },
      response: {
        202: { type: "object", properties: { assessment_id: { type: "string", format: "uuid" }, status: { type: "string" }, created_at: { type: "string" } }, required: ["assessment_id", "status", "created_at"] },
        400: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
        503: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      },
    },
  }, async (request, reply) => {
    const ids = new Set(request.body.obligations.map((item) => item.id));
    if (ids.size !== request.body.obligations.length) return reply.code(400).send({ error: "Obligation IDs must be unique." });
    if (!process.env.OPENAI_API_KEY) return reply.code(503).send({ error: "AI assessment is unavailable: OPENAI_API_KEY is not configured on the API server." });
    const id = randomUUID();
    const assessmentDate = request.body.assessment_date ?? new Date().toISOString().slice(0, 10);
    const created = await pool.query(
      `INSERT INTO assessments (id, status, assessment_date, policy_document_ids, obligations, organization_id)
       VALUES ($1, 'QUEUED', $2, $3::uuid[], $4::jsonb, $5) RETURNING created_at`,
      [id, assessmentDate, request.body.policy_document_ids, JSON.stringify(request.body.obligations), request.identity!.organization_id],
    );
    try {
      await boss.send(ASSESSMENT_QUEUE, { assessmentId: id });
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
              model_identifier, error_message, created_at, started_at, completed_at
       FROM assessments WHERE id = $1`, [request.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: "Assessment not found." });
    const findings = await pool.query(
      `SELECT id, obligation_id, classification, applicability, explanation, proposed_action,
              limitations, evidence, review_status, created_at
       FROM findings WHERE assessment_id = $1 ORDER BY created_at, obligation_id`, [request.params.id],
    );
    return { assessment: rows[0], findings: findings.rows };
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
