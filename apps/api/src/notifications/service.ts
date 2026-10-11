import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { EMAIL_QUEUE } from "../documents/queue.js";
import { renderNotificationEmail } from "./templates.js";
import { configuredRecipientAllowlist, isAllowedNotificationRecipient } from "./recipients.js";

export interface NotificationEvent { organizationId: string; eventKey: string; type: string; subject: string; body: string }

export async function queueNotification(event: NotificationEvent, boss: PgBoss) {
  const assessmentEvent=event.type.startsWith("ASSESSMENT_");
  const allowlist=configuredRecipientAllowlist();
  const recipients = await pool.query<{id:string}>(`SELECT id FROM notification_recipients
    WHERE organization_id=$1 AND verified_at IS NOT NULL AND ${assessmentEvent?"notify_assessments":"notify_alerts"}=TRUE
      AND ($2::text[] IS NULL OR lower(email)=ANY($2::text[]))`,[event.organizationId,allowlist]);
  for (const recipient of recipients.rows) {
    const id = randomUUID();
    const result = await pool.query(`INSERT INTO notification_deliveries
      (id,organization_id,recipient_id,event_key,event_type,subject,body_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (recipient_id,event_key) DO NOTHING RETURNING id`,
    [id,event.organizationId,recipient.id,event.eventKey,event.type,event.subject,event.body]);
    if (result.rowCount) await boss.send(EMAIL_QUEUE,{deliveryId:id},{retryLimit:5,retryDelay:30,expireInSeconds:600});
  }
}

export async function sendDelivery(deliveryId: string) {
  const row = (await pool.query(`SELECT d.*,r.email FROM notification_deliveries d
    JOIN notification_recipients r ON r.id=d.recipient_id
    WHERE d.id=$1 AND d.status IN ('QUEUED','FAILED') AND r.verified_at IS NOT NULL`,[deliveryId])).rows[0];
  if (!row) return;
  if (!isAllowedNotificationRecipient(row.email)) throw new Error("Recipient is not included in RESEND_ALLOWED_RECIPIENTS.");
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!key || !from) throw new Error("Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.");
  await pool.query("UPDATE notification_deliveries SET attempts=attempts+1,status='QUEUED',last_error=NULL WHERE id=$1",[deliveryId]);
  try {
    const message = renderNotificationEmail({ type: row.event_type, subject: row.subject, body: row.body_text });
    const response = await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
      body:JSON.stringify({from,to:[row.email],subject:row.subject,text:message.text,html:message.html})});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error((result as {message?:string}).message ?? `Resend returned ${response.status}`);
    await pool.query("UPDATE notification_deliveries SET status='SENT',sent_at=NOW(),provider_id=$2 WHERE id=$1",[deliveryId,(result as {id?:string}).id ?? null]);
  } catch(error) {
    const detail = error instanceof Error ? error.message.slice(0,1000) : "Email delivery failed.";
    await pool.query("UPDATE notification_deliveries SET status='FAILED',last_error=$2 WHERE id=$1",[deliveryId,detail]);
    throw error;
  }
}
