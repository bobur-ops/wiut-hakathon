import { pool } from "../src/db.js";

const urls = [
  "https://lex.uz/docs/4575788",
  "https://lex.uz/docs/284542",
  "https://lex.uz/docs/4396428",
  "https://lex.uz/docs/4590456",
];

// Administrative development reset. Stop API/worker before applying.
// Dry-run by default; --apply explicitly deletes regulatory/history data.
const apply = process.argv.includes("--apply");
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '15s'");
  if (apply) await client.query(`LOCK TABLE assessments, documents, document_groups, regulatory_sources,
    document_import_batches, regulatory_obligation_cache IN SHARE ROW EXCLUSIVE MODE`);
  const keep = (await client.query(`SELECT DISTINCT ON (source_url) id,source_url,document_group_id
    FROM documents d WHERE d.source_url=ANY($1::text[]) AND d.document_type='regulation'
      AND d.revision_date IS NULL AND d.processing_status='COMPLETED'
      AND EXISTS (SELECT 1 FROM document_sections s WHERE s.document_id=d.id
        AND s.section_type IN ('CHAPTER','ARTICLE','PARAGRAPH','PAGE') AND length(btrim(s.content))>0)
    ORDER BY source_url,uploaded_at DESC,id`, [urls])).rows;
  if (keep.length !== urls.length) throw new Error("All four requested current legal snapshots must exist before pruning.");
  const ids = keep.map(d => d.id);
  const groups = keep.map(d => d.document_group_id);
  const before = (await client.query(`SELECT
    (SELECT count(*) FROM assessments)::int AS assessments,
    (SELECT count(*) FROM documents WHERE document_type IN ('regulation','guidance') AND NOT(id=ANY($1::uuid[])))::int AS snapshots_to_remove,
    (SELECT count(*) FROM documents WHERE document_type IN ('policy','procedure'))::int AS policies,
    (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM organizations)::int AS organizations`, [ids])).rows[0];
  if (!apply) {
    console.log(JSON.stringify({ dry_run:true,keep, ...before },null,2));
    await client.query("ROLLBACK");
  } else {
    await client.query("DELETE FROM assessments"); // cascades findings, reviews, usage
    await client.query("DELETE FROM regulatory_update_candidates");
    await client.query("DELETE FROM regulatory_source_checks");
    await client.query("DELETE FROM regulatory_sources WHERE NOT(source_url=ANY($1::text[]))", [urls]);
    for (const document of keep) {
      await client.query(`UPDATE regulatory_sources SET last_document_id=$2,
        accepted_document_id=CASE WHEN accepted_document_id=$2 THEN $2 ELSE NULL END,
        last_checked_at=NULL,last_successful_check_at=NULL,last_status='NEVER_CHECKED',last_error=NULL,next_check_at=NOW()
        WHERE source_url=$1`, [document.source_url,document.id]);
    }
    await client.query(`DELETE FROM document_import_batches WHERE id IN
      (SELECT b.id FROM document_import_batches b WHERE b.source_url LIKE 'https://lex.uz/%'
        OR EXISTS (SELECT 1 FROM document_import_items i JOIN documents d ON d.id=i.document_id
          WHERE i.batch_id=b.id AND d.document_type IN ('regulation','guidance')))`);
    await client.query(`DELETE FROM regulatory_obligation_cache WHERE NOT(document_id=ANY($1::uuid[]))`, [ids]);
    await client.query("DELETE FROM regulatory_extraction_attempts");
    await client.query(`DELETE FROM documents WHERE document_type IN ('regulation','guidance') AND NOT(id=ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM document_group_source_aliases WHERE NOT(document_group_id=ANY($1::uuid[]))
      AND document_group_id IN (SELECT id FROM document_groups WHERE document_type IN ('regulation','guidance'))`, [groups]);
    await client.query(`DELETE FROM document_groups g WHERE g.document_type IN ('regulation','guidance')
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.document_group_id=g.id)`);
    await client.query(`DELETE FROM pgboss.job WHERE name IN ('compliance-assessment','assessment-document-impact',
      'document-version-import','regulatory-source-check') OR (name='document-extraction'
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id::text=data->>'documentId'))`);
    const after = (await client.query(`SELECT
      (SELECT count(*) FROM documents WHERE document_type IN ('regulation','guidance'))::int AS regulations,
      (SELECT count(*) FROM regulatory_sources)::int AS monitored_sources,
      (SELECT COALESCE(SUM(jsonb_array_length(obligations)),0) FROM regulatory_obligation_cache)::int AS cached_obligations,
      (SELECT count(*) FROM documents WHERE document_type IN ('policy','procedure'))::int AS policies,
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM organizations)::int AS organizations,
      (SELECT count(*) FROM assessments)::int AS assessments`)).rows[0];
    if (after.regulations !== 4 || after.monitored_sources !== 4 || after.policies !== before.policies
      || after.users !== before.users || after.organizations !== before.organizations) throw new Error("Cleanup preservation checks failed; rolling back.");
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied:true,before,after,retained_urls:urls,storage_files:"not deleted" },null,2));
  }
} catch (error) { await client.query("ROLLBACK"); throw error; }
finally { client.release(); await pool.end(); }
