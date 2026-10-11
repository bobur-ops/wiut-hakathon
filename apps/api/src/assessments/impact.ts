import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { selectAssessmentCorpus, excludedCorpusSources, selectIncrementalCorpus, type CorpusDocument } from "./corpus.js";
import { ASSESSMENT_QUEUE, ASSESSMENT_IMPACT_QUEUE } from "../documents/queue.js";

export async function queueDocumentImpact(documentId: string, boss: PgBoss) {
  if (process.env.AUTO_ASSESS_UPDATES === "false") return;
  const job=await boss.send(ASSESSMENT_IMPACT_QUEUE, { documentId }, { retryLimit: 240, retryDelay: 30 });
  if (!job) throw new Error("Impact event queue did not accept the update");
}

export async function processDocumentImpact(documentId: string, boss: PgBoss) {
  const document = (await pool.query("SELECT id,document_group_id,organization_id,document_type FROM documents WHERE id=$1", [documentId])).rows[0];
  if (!document) return;
  const baselines = await pool.query(`SELECT DISTINCT ON (a.organization_id) a.* FROM assessments a
    WHERE a.status='COMPLETED' AND a.organization_id IS NOT NULL
      AND ($2::uuid IS NULL OR a.organization_id=$2)
      AND (EXISTS (SELECT 1 FROM jsonb_array_elements(a.input_snapshots) s WHERE s->>'document_group_id'=$1::text)
        OR EXISTS (SELECT 1 FROM legislation_inbox inbox WHERE inbox.organization_id=a.organization_id
          AND inbox.imported_document_id=$3 AND inbox.status='IMPORTED'))
      ORDER BY a.organization_id,a.created_at DESC`, [document.document_group_id, document.organization_id, documentId]);
  for (const baseline of baselines.rows) {
    if ((await pool.query("SELECT id FROM assessments WHERE organization_id=$1 AND impact_document_id=$2", [baseline.organization_id,documentId])).rowCount) continue;
    const active = await pool.query("SELECT id FROM assessments WHERE organization_id=$1 AND status IN ('QUEUED','PROCESSING')", [baseline.organization_id]);
    if (active.rowCount) throw new Error("Impact assessment deferred until the current run finishes.");
    const profile = (await pool.query("SELECT organization_type,activities FROM organizations WHERE id=$1", [baseline.organization_id])).rows[0];
    if (!profile) continue;
    const policies = (await pool.query(`SELECT DISTINCT ON (d.document_group_id) d.id,d.document_group_id,d.filename,d.content_hash,d.version_label
      FROM documents d WHERE d.organization_id=$2 AND d.document_type IN ('policy','procedure')
        AND d.processing_status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
        AND d.document_group_id IN (SELECT document_group_id FROM documents WHERE id=ANY($1::uuid[]))
      ORDER BY d.document_group_id,d.uploaded_at DESC`, [baseline.policy_document_ids, baseline.organization_id])).rows;
    const discoveredAct = Boolean((await pool.query(`SELECT 1 FROM legislation_inbox WHERE organization_id=$1
      AND imported_document_id=$2 AND status='IMPORTED' AND review_decision IS DISTINCT FROM 'NOT_RELEVANT'`,[baseline.organization_id,documentId])).rowCount);
    const availableCorpus = await selectAssessmentCorpus(baseline.organization_id);
    if (discoveredAct && !availableCorpus.some(item => item.id === documentId)) {
      const discovered = await pool.query<CorpusDocument>(`SELECT d.id,g.title,d.filename,d.content_hash,d.source_url,d.version_label,
        d.revision_date::text,false AS source_reviewed,d.document_group_id
        FROM documents d JOIN document_groups g ON g.id=d.document_group_id
        WHERE d.id=$1 AND d.organization_id=$2 AND d.document_type='legislation' AND d.processing_status='COMPLETED'
          AND EXISTS (SELECT 1 FROM document_sections s WHERE s.document_id=d.id AND s.section_type IN ('CHAPTER','ARTICLE','PARAGRAPH','PAGE') AND length(btrim(s.content))>0)`,
      [documentId,baseline.organization_id]);
      if (discovered.rows[0]) availableCorpus.push(discovered.rows[0]);
    }
    // Preserve a manually focused assessment's scope. A newly discovered act
    // is added as the only new group; ordinary policy/regulation updates do
    // not silently expand the baseline corpus.
    const corpus = selectIncrementalCorpus(availableCorpus,baseline.input_snapshots ?? [],documentId,discoveredAct);
    if (!policies.length || !corpus.length) continue;
    const excluded = await excludedCorpusSources(baseline.organization_id, corpus);
    const id = randomUUID();
    await pool.query(`INSERT INTO assessments (id,status,assessment_date,policy_document_ids,obligations,organization_id,
      corpus_document_ids,organization_profile,input_snapshots,pipeline_version,coverage_warnings,baseline_assessment_id,comparison_model,impact_document_id)
      VALUES ($1,'QUEUED',CURRENT_DATE,$2::uuid[],'[]'::jsonb,$3,$4::uuid[],$5::jsonb,$6::jsonb,'impact-v2',$7::jsonb,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [id, policies.map(p => p.id), baseline.organization_id, corpus.map(d => d.id), JSON.stringify(profile),
       JSON.stringify([...policies.map(p => ({ ...p,kind: "policy" })), ...corpus.map(d => ({ ...d,kind: discoveredAct && d.id===documentId ? "legislation" : "regulation" }))]),
      JSON.stringify(excluded.map(d => `Excluded source: ${d.title}`)), baseline.id, process.env.OPENAI_MODEL ?? "gpt-6-luna", documentId]);
    if (!(await pool.query("SELECT id FROM assessments WHERE id=$1", [id])).rowCount) {
      if ((await pool.query("SELECT id FROM assessments WHERE organization_id=$1 AND impact_document_id=$2", [baseline.organization_id,documentId])).rowCount) continue;
      throw new Error("Impact assessment deferred due to a concurrent workspace run.");
    }
    try {
      const job = await boss.send(ASSESSMENT_QUEUE, { assessmentId: id }, { retryLimit: 0, expireInSeconds: 7200 });
      if (!job) throw new Error("Impact assessment could not be queued");
      await pool.query("UPDATE assessments SET job_id=$2 WHERE id=$1", [id,job]);
    } catch (error) {
      await pool.query("UPDATE assessments SET status='FAILED',error_message=$2 WHERE id=$1", [id,error instanceof Error ? error.message : "Impact queue failed"]);
      throw error;
    }
  }
}
