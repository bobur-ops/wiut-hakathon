import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db.js";
import { hashToken } from "./security.js";

export interface Identity {
  user_id: string;
  organization_id: string;
  email: string;
  name: string;
  organization_type: string;
  activities: string[];
}

declare module "fastify" {
  interface FastifyRequest { identity: Identity | null }
}

export const DOCUMENT_ACCESS_SQL = "(organization_id = $2 OR (organization_id IS NULL AND document_type IN ('regulation', 'guidance')))";

export async function accessibleDocuments(ids: string[], organizationId: string, policiesOnly = false) {
  const unique = [...new Set(ids)];
  const result = await pool.query(
    `SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND ${policiesOnly
      ? "organization_id = $2 AND document_type IN ('policy', 'procedure')"
      : DOCUMENT_ACCESS_SQL}`, [unique, organizationId],
  );
  return result.rows.length === unique.length;
}

export function installAccessControl(app: FastifyInstance) {
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const path = request.url.split("?")[0];
    if (path === "/api/health" || ["/api/auth/login", "/api/auth/register"].includes(path!)) return;
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return reply.code(401).send({ error: "Sign in to access your organization workspace." });
    const result = await pool.query<Identity>(
      `SELECT users.id AS user_id, users.organization_id, users.email,
              organizations.name, organizations.organization_type, organizations.activities
       FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
       JOIN organizations ON organizations.id = users.organization_id
       WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > NOW()`, [hashToken(token)],
    );
    request.identity = result.rows[0] ?? null;
    if (!request.identity) return reply.code(401).send({ error: "Session expired. Please sign in again." });
  });
  app.addHook("preHandler", async (request, reply) => {
    if (!request.identity) return;
    if (!await canAccessRequest(request)) return reply.code(404).send({ error: "Resource not found in your workspace." });
  });
}

async function canAccessRequest(request: FastifyRequest) {
  const org = request.identity!.organization_id;
  const path = request.url.split("?")[0]!;
  const params = request.params as { id?: string };
  const body = request.body as Record<string, unknown> | undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (params.id && !uuid.test(params.id)) return false;
  if (/^\/api\/documents\/[^/]+(?:\/sections)?$/.test(path) && params.id) {
    return accessibleDocuments([params.id], org);
  }
  if (path === "/api/documents/compare" && body) {
    return accessibleDocuments([String(body.previous_document_id), String(body.current_document_id)], org);
  }
  if ((path === "/api/policy-evidence/search" || path === "/api/assessments") && request.method === "POST" && body) {
    return accessibleDocuments(body.policy_document_ids as string[], org, true);
  }
  if (/^\/api\/assessments\/[^/]+(?:\/cancel)?$/.test(path) && params.id) {
    return Boolean((await pool.query("SELECT 1 FROM assessments WHERE id = $1 AND organization_id = $2", [params.id, org])).rowCount);
  }
  if (/^\/api\/findings\/[^/]+(?:\/(review|reviews))?$/.test(path) && params.id) {
    return Boolean((await pool.query(`SELECT 1 FROM findings JOIN assessments ON assessments.id = findings.assessment_id
      WHERE findings.id = $1 AND assessments.organization_id = $2`, [params.id, org])).rowCount);
  }
  if (path.startsWith("/api/document-groups/") && params.id) {
    return Boolean((await pool.query(`SELECT 1 FROM document_groups WHERE id = $1
      AND (organization_id = $2 OR (organization_id IS NULL AND document_type IN ('regulation', 'guidance')))`, [params.id, org])).rowCount);
  }
  if (path.startsWith("/api/document-imports/") && params.id) {
    return Boolean((await pool.query("SELECT 1 FROM document_import_batches WHERE id = $1 AND organization_id = $2", [params.id, org])).rowCount);
  }
  return true;
}
