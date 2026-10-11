import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { hashPassword, hashToken, newSessionToken, sessionCookie, sessionTokenFromHeaders, verifyPassword } from "./security.js";
import type { PgBoss } from "pg-boss";
import { EMAIL_QUEUE } from "../documents/queue.js";
import { isAllowedNotificationRecipient } from "../notifications/recipients.js";

const credentials = {
  email: { type: "string", format: "email", maxLength: 254 },
  password: { type: "string", minLength: 6, maxLength: 128 },
} as const;

export function registerAuthRoutes(app: FastifyInstance, boss: PgBoss) {
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
      reply.header("Set-Cookie",sessionCookie(token));
      return reply.code(201).send({ identity: { user_id: userId, organization_id: organizationId, email, name: request.body.name.trim(), organization_type: request.body.organization_type, activities: [] } });
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
    reply.header("Set-Cookie",sessionCookie(token));
    return { identity };
  });

  app.get("/api/auth/me", { schema: { tags: ["Workspace"], summary: "Get the current workspace identity" } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { identity: request.identity };
  });
  app.post("/api/auth/logout", { schema: { tags: ["Workspace"], summary: "Revoke the current session" } }, async (request, reply) => {
    const token=sessionTokenFromHeaders(request.headers.authorization,request.headers.cookie);
    if(token) await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [hashToken(token)]);
    reply.header("Set-Cookie",sessionCookie(null));
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

  app.get("/api/organization/notifications", async (request) => {
    const organizationId=request.identity!.organization_id;
    const [recipients,deliveries]=await Promise.all([
      pool.query("SELECT id,email,verified_at,notify_assessments,notify_alerts,created_at FROM notification_recipients WHERE organization_id=$1 ORDER BY created_at",[organizationId]),
      pool.query(`SELECT id,event_type,subject,status,attempts,last_error,created_at,sent_at
        FROM notification_deliveries WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,[organizationId]),
    ]);
    return {recipients:recipients.rows,deliveries:deliveries.rows,email_configured:Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_FROM_EMAIL)};
  });
  app.patch<{Params:{id:string};Body:{notify_assessments:boolean;notify_alerts:boolean}}>("/api/organization/notification-recipients/:id",{
    schema:{body:{type:"object",additionalProperties:false,required:["notify_assessments","notify_alerts"],properties:{notify_assessments:{type:"boolean"},notify_alerts:{type:"boolean"}}}},
  },async(request,reply)=>{
    const result=await pool.query(`UPDATE notification_recipients SET notify_assessments=$3,notify_alerts=$4
      WHERE id=$1 AND organization_id=$2 RETURNING id,email,verified_at,notify_assessments,notify_alerts`,
    [request.params.id,request.identity!.organization_id,request.body.notify_assessments,request.body.notify_alerts]);
    if(!result.rowCount)return reply.code(404).send({error:"Recipient not found."});
    return {recipient:result.rows[0]};
  });
  app.post<{Body:{email:string}}>("/api/organization/notification-recipients",{
    schema:{body:{type:"object",additionalProperties:false,required:["email"],properties:{email:{type:"string",format:"email",maxLength:254}}}},
  },async(request,reply)=>{
    const email=request.body.email.trim().toLowerCase();
    if(!isAllowedNotificationRecipient(email)) return reply.code(400).send({error:"This demo is configured to send notifications only to the permitted Resend test recipient."});
    const id=randomUUID();
    await pool.query(`INSERT INTO notification_recipients(id,organization_id,email,verification_token,verified_at)
      VALUES($1,$2,$3,'',NOW()) ON CONFLICT(organization_id,email) DO UPDATE SET verified_at=COALESCE(notification_recipients.verified_at,NOW()),verification_token=''`,
    [id,request.identity!.organization_id,email]);
    return reply.code(201).send({email,status:"ACTIVE"});
  });
  app.delete<{Params:{id:string}}>("/api/organization/notification-recipients/:id",async(request,reply)=>{
    const result=await pool.query("DELETE FROM notification_recipients WHERE id=$1 AND organization_id=$2",[request.params.id,request.identity!.organization_id]);
    if(!result.rowCount)return reply.code(404).send({error:"Recipient not found."});
    return reply.code(204).send();
  });
  app.post<{Params:{id:string}}>("/api/organization/notifications/:id/resend",async(request,reply)=>{
    const result=await pool.query(`SELECT id FROM notification_deliveries WHERE id=$1 AND organization_id=$2 AND status IN ('FAILED','SENT')`,[request.params.id,request.identity!.organization_id]);
    if(!result.rowCount)return reply.code(404).send({error:"Notification not found or not resendable."});
    const original=result.rows[0].id;
    await pool.query("UPDATE notification_deliveries SET status='QUEUED',last_error=NULL WHERE id=$1",[original]);
    const job=await boss.send(EMAIL_QUEUE,{deliveryId:original},{retryLimit:3,retryDelay:30});
    if(!job)return reply.code(503).send({error:"Could not queue email resend."});
    return {id:original,status:"QUEUED"};
  });
}
