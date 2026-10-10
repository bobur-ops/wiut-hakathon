import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "./security.js";

const credentials = {
  email: { type: "string", format: "email", maxLength: 254 },
  password: { type: "string", minLength: 6, maxLength: 128 },
} as const;

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string; name: string; organization_type: string } }>("/api/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: {
      tags: ["Workspace"], summary: "Create a fictional organization and its owner account",
      security: [],
      body: { type: "object", additionalProperties: false, required: ["email", "password", "name", "organization_type"],
        properties: { ...credentials, name: { type: "string", minLength: 2, maxLength: 200 },
          organization_type: { type: "string", enum: ["commercial_bank", "payment_organization", "electronic_money_provider", "other_fintech"] } } },
    },
  }, async (request, reply) => {
    if (!request.body.name.trim()) return reply.code(400).send({ error: "Organization name is required." });
    const email = request.body.email.trim().toLowerCase();
    const encoded = await hashPassword(request.body.password);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const token = newSessionToken();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO organizations (id, name, organization_type) VALUES ($1, $2, $3)", [organizationId, request.body.name.trim(), request.body.organization_type]);
      await client.query("INSERT INTO users (id, organization_id, email, password_hash) VALUES ($1, $2, $3, $4)", [userId, organizationId, email, encoded]);
      await client.query("INSERT INTO auth_sessions (token_hash, user_id) VALUES ($1, $2)", [hashToken(token), userId]);
      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send({ token, identity: { user_id: userId, organization_id: organizationId, email, name: request.body.name.trim(), organization_type: request.body.organization_type, activities: [] } });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "An account with this email already exists." });
      throw error;
    } finally { client.release(); }
  });

  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: { tags: ["Workspace"], security: [], summary: "Sign in to an organization", body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: credentials } },
  }, async (request, reply) => {
    const result = await pool.query(`SELECT users.id AS user_id, users.organization_id, users.email, users.password_hash,
      organizations.name, organizations.organization_type, organizations.activities
      FROM users JOIN organizations ON organizations.id = users.organization_id WHERE users.email = $1`, [request.body.email.trim().toLowerCase()]);
    const user = result.rows[0];
    // Run scrypt for unknown emails too, rather than immediately revealing existence.
    const valid = await verifyPassword(request.body.password, user?.password_hash ?? `${"0".repeat(32)}:${"0".repeat(128)}`);
    if (!user || !valid) return reply.code(401).send({ error: "Invalid email or password." });
    const token = newSessionToken();
    await pool.query("INSERT INTO auth_sessions (token_hash, user_id) VALUES ($1, $2)", [hashToken(token), user.user_id]);
    const { password_hash: _hash, ...identity } = user;
    reply.header("Cache-Control", "no-store");
    return { token, identity };
  });

  app.get("/api/auth/me", { schema: { tags: ["Workspace"], summary: "Get the current workspace identity" } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { identity: request.identity };
  });
  app.post("/api/auth/logout", { schema: { tags: ["Workspace"], summary: "Revoke the current session" } }, async (request, reply) => {
    const token = request.headers.authorization!.slice(7);
    await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [hashToken(token)]);
    return reply.code(204).send();
  });
  app.patch<{ Body: { name: string; organization_type: string; activities: string[] } }>("/api/organization", {
    schema: { tags: ["Workspace"], summary: "Update your organization profile",
      body: { type: "object", additionalProperties: false, required: ["name", "organization_type", "activities"], properties: {
        name: { type: "string", minLength: 2, maxLength: 200 },
        organization_type: { type: "string", enum: ["commercial_bank", "payment_organization", "electronic_money_provider", "other_fintech"] },
        activities: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
      } } },
  }, async (request, reply) => {
    if (!request.body.name.trim()) return reply.code(400).send({ error: "Organization name is required." });
    await pool.query("UPDATE organizations SET name = $2, organization_type = $3, activities = $4::jsonb WHERE id = $1", [request.identity!.organization_id, request.body.name.trim(), request.body.organization_type, JSON.stringify(request.body.activities)]);
    return { identity: { ...request.identity, ...request.body, name: request.body.name.trim() } };
  });
}
