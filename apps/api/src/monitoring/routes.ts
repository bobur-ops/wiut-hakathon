import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { queueDocumentImpact } from "../assessments/impact.js";
import { MONITOR_CHECK_QUEUE } from "../documents/queue.js";
import { discoverMonitoringSources } from "./service.js";

export function canReviewSharedSource(email: string) {
  return (process.env.REGULATORY_REVIEWER_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}

export function registerMonitoringRoutes(app: FastifyInstance, boss: PgBoss) {
  const params = { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } };
  app.get("/api/regulatory-sources", { schema: { tags: ["Monitoring"], summary: "List monitored sources and last-check status" } }, async (request) => {
    const sources = await pool.query(`SELECT id, name, source_url, enabled, check_interval_minutes,
      next_check_at, last_checked_at, last_successful_check_at, last_status, last_error,
      last_document_id, accepted_document_id, organization_id
      FROM regulatory_sources WHERE organization_id = $1 OR organization_id IS NULL ORDER BY name`, [request.identity!.organization_id]);
    return { monitor_enabled: process.env.REGULATORY_MONITOR_ENABLED !== "false", shared_review_allowed: canReviewSharedSource(request.identity!.email), sources: sources.rows };
  });
  app.post("/api/regulatory-sources/discover", {
    config: { rateLimit: { max: 2, timeWindow: "1 minute" } },
    schema: { tags: ["Monitoring"], summary: "Discover current official URLs from completed regulation imports" },
  }, async () => {
    await discoverMonitoringSources();
    return { discovered: true };
  });
  app.patch<{ Params: { id: string }; Body: { enabled: boolean; check_interval_minutes: number } }>("/api/regulatory-sources/:id", {
    schema: { tags: ["Monitoring"], summary: "Enable/disable a source or change its interval", params,
      body: { type: "object", additionalProperties: false, required: ["enabled", "check_interval_minutes"], properties: {
        enabled: { type: "boolean" }, check_interval_minutes: { type: "integer", minimum: 15, maximum: 10080 },
      } } },
  }, async (request, reply) => {
    const source = await pool.query("SELECT organization_id FROM regulatory_sources WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)", [request.params.id, request.identity!.organization_id]);
    if (!source.rows[0]) return reply.code(404).send({ error: "Source not found." });
    if (source.rows[0].organization_id === null && !canReviewSharedSource(request.identity!.email)) return reply.code(403).send({ error: "Configuring shared sources requires a configured regulatory reviewer." });
    await pool.query("UPDATE regulatory_sources SET enabled = $2, check_interval_minutes = $3 WHERE id = $1", [request.params.id, request.body.enabled, request.body.check_interval_minutes]);
    return { updated: true };
  });
  app.post<{ Params: { id: string } }>("/api/regulatory-sources/:id/check", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: { tags: ["Monitoring"], summary: "Queue an on-demand source check", params },
  }, async (request, reply) => {
    if (process.env.REGULATORY_MONITOR_ENABLED === "false") return reply.code(503).send({ error: "Regulatory monitor is disabled in this deployment." });
    const source = await pool.query(`SELECT id, enabled FROM regulatory_sources WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)`, [request.params.id, request.identity!.organization_id]);
    if (!source.rows[0]) return reply.code(404).send({ error: "Source not found." });
    if (!source.rows[0].enabled) return reply.code(409).send({ error: "This source is disabled." });
    const job = await boss.send(MONITOR_CHECK_QUEUE, { sourceId: request.params.id }, { singletonKey: request.params.id, singletonSeconds: 60, retryLimit: 0, expireInSeconds: 300 });
    return reply.code(202).send({ status: job ? "QUEUED" : "ALREADY_QUEUED", source_id: request.params.id });
  });
  app.get<{ Params: { id: string } }>("/api/regulatory-sources/:id/checks", {
    schema: { tags: ["Monitoring"], summary: "View source check history", params },
  }, async (request, reply) => {
    const allowed = await pool.query("SELECT 1 FROM regulatory_sources WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)", [request.params.id, request.identity!.organization_id]);
    if (!allowed.rowCount) return reply.code(404).send({ error: "Source not found." });
    return { checks: (await pool.query("SELECT * FROM regulatory_source_checks WHERE source_id = $1 ORDER BY started_at DESC LIMIT 50", [request.params.id])).rows };
  });
  app.get("/api/regulatory-updates", { schema: { tags: ["Monitoring"], summary: "List candidate legal-text changes and exact old/new excerpts" } }, async (request) => {
    const candidates = await pool.query(`SELECT candidate.*, source.name, source.source_url, source.organization_id
      FROM regulatory_update_candidates AS candidate JOIN regulatory_sources AS source ON source.id = candidate.source_id
      WHERE source.organization_id = $1 OR source.organization_id IS NULL
      ORDER BY candidate.detected_at DESC LIMIT 100`, [request.identity!.organization_id]);
    return { updates: candidates.rows };
  });
  app.post<{ Params: { id: string }; Body: { decision: "APPROVED" | "REJECTED"; note: string } }>("/api/regulatory-updates/:id/review", {
    schema: { tags: ["Monitoring"], summary: "Review a candidate without modifying previous document snapshots or assessments", params,
      body: { type: "object", additionalProperties: false, required: ["decision", "note"], properties: {
        decision: { type: "string", enum: ["APPROVED", "REJECTED"] }, note: { type: "string", minLength: 10, maxLength: 4000 },
      } } },
  }, async (request, reply) => {
    if (request.body.note.trim().length < 10) return reply.code(400).send({ error: "Provide a substantive source-review note." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`SELECT candidate.*, source.organization_id, source.accepted_document_id
        FROM regulatory_update_candidates AS candidate JOIN regulatory_sources AS source ON source.id = candidate.source_id
        WHERE candidate.id = $1 AND (source.organization_id = $2 OR source.organization_id IS NULL) FOR UPDATE OF source, candidate`, [request.params.id, request.identity!.organization_id]);
      const candidate = result.rows[0];
      if (!candidate) { await client.query("ROLLBACK"); return reply.code(404).send({ error: "Update not found." }); }
      if (candidate.organization_id === null && !canReviewSharedSource(request.identity!.email)) {
        await client.query("ROLLBACK"); return reply.code(403).send({ error: "Shared corpus reviews require an email configured in REGULATORY_REVIEWER_EMAILS." });
      }
      if (candidate.status !== "PENDING_REVIEW") { await client.query("ROLLBACK"); return reply.code(409).send({ error: "This candidate has already been reviewed." }); }
      if (request.body.decision === "APPROVED") {
        if (candidate.accepted_document_id) {
          const dates = await client.query("SELECT id, uploaded_at FROM documents WHERE id = ANY($1::uuid[])", [[candidate.accepted_document_id, candidate.new_document_id]]);
          const accepted = dates.rows.find((row) => row.id === candidate.accepted_document_id);
          const proposed = dates.rows.find((row) => row.id === candidate.new_document_id);
          if (accepted && proposed && new Date(accepted.uploaded_at) > new Date(proposed.uploaded_at)) {
            await client.query("ROLLBACK"); return reply.code(409).send({ error: "A newer snapshot was already accepted. Review the latest candidate instead." });
          }
        }
        await client.query("UPDATE regulatory_sources SET accepted_document_id = $2 WHERE id = $1", [candidate.source_id, candidate.new_document_id]);
      }
      const reviewed = await client.query(`UPDATE regulatory_update_candidates SET status = $2, reviewer_identifier = $3,
        review_note = $4, reviewed_at = NOW() WHERE id = $1 RETURNING id, status, reviewed_at`, [candidate.id, request.body.decision, request.identity!.email, request.body.note]);
      await client.query("COMMIT");
      if (request.body.decision === "APPROVED") {
        await queueDocumentImpact(candidate.new_document_id, boss).catch(error => request.log.error(error, "Could not queue regulatory impact assessment"));
      }
      return reviewed.rows[0];
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  });
}
