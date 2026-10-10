import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { pool } from "../db.js";
import { downloadRemoteDocument } from "../documents/remote.js";
import { extractDocument, normalizeExtractedText } from "../documents/extract.js";
import { compareSections, type ComparableSection } from "../documents/compare.js";
import { allocateVersion } from "../documents/versions.js";
import { storeUpload } from "../documents/storage.js";
import { MONITOR_CHECK_QUEUE, MONITOR_DISPATCH_QUEUE } from "../documents/queue.js";
import { comparableSections, monitoringUrl, monitorInterval, textHash } from "./content.js";

const selectSections = `SELECT section.section_type, section.source_reference,
  COALESCE(NULLIF(section.normalized_content, ''), section.content) AS normalized_content,
  parent.source_reference AS parent_source_reference,
  COALESCE(NULLIF(parent.normalized_content, ''), parent.content) AS parent_content
  FROM document_sections AS section LEFT JOIN document_sections AS parent ON parent.id = section.parent_section_id
  WHERE section.document_id = $1 ORDER BY section.section_index`;

export async function discoverMonitoringSources() {
  const documents = await pool.query(`SELECT documents.id, documents.organization_id, documents.source_url,
    documents.revision_date, documents.mime_type, groups.title
    FROM documents JOIN document_groups AS groups ON groups.id = documents.document_group_id
    WHERE documents.source_type = 'REMOTE' AND documents.document_type = 'regulation'
      AND documents.processing_status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
    ORDER BY (documents.revision_date IS NULL) DESC, (documents.mime_type = 'text/html') DESC, documents.uploaded_at DESC`);
  for (const document of documents.rows) {
    const url = monitoringUrl(document.source_url);
    if (!url) continue;
    // Historical content isn't the baseline for a current-page monitor.
    const baseline = document.revision_date === null &&
      !(new URL(url).hostname === "lex.uz" && document.mime_type !== "text/html") ? document.id : null;
    await pool.query(`INSERT INTO regulatory_sources
      (id, organization_id, name, source_url, check_interval_minutes, last_document_id)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [randomUUID(), document.organization_id, document.title, url, monitorInterval(), baseline]);
  }
}

export async function dispatchSourceChecks(boss: PgBoss) {
  await discoverMonitoringSources();
  const due = await pool.query("SELECT id FROM regulatory_sources WHERE enabled AND next_check_at <= NOW() ORDER BY next_check_at LIMIT 100");
  for (const [index, source] of due.rows.entries()) {
    // Stagger checks and deduplicate on-demand/scheduled requests for the source.
    await boss.send(MONITOR_CHECK_QUEUE, { sourceId: source.id }, {
      singletonKey: source.id, singletonSeconds: 60, startAfter: index * 5,
      retryLimit: 0, expireInSeconds: 300,
    });
  }
}

export async function startRegulatoryMonitor(boss: PgBoss) {
  await boss.createQueue(MONITOR_DISPATCH_QUEUE);
  await boss.createQueue(MONITOR_CHECK_QUEUE);
  if (process.env.REGULATORY_MONITOR_ENABLED === "false") {
    await boss.unschedule(MONITOR_DISPATCH_QUEUE);
    return;
  }
  await boss.schedule(MONITOR_DISPATCH_QUEUE, "*/5 * * * *", {}, { tz: "UTC" });
  await boss.work(MONITOR_DISPATCH_QUEUE, async () => { await dispatchSourceChecks(boss); });
  await boss.work<{ sourceId: string }>(MONITOR_CHECK_QUEUE, async ([job]) => {
    if (job) await checkRegulatorySource(job.data.sourceId);
  });
  await boss.send(MONITOR_DISPATCH_QUEUE, {}, { singletonKey: "startup", singletonSeconds: 60, retryLimit: 0 });
}

export async function checkRegulatorySource(sourceId: string, dependencies: {
  download?: typeof downloadRemoteDocument;
  extract?: typeof extractDocument;
} = {}) {
  const client = await pool.connect();
  let locked = false;
  let checkId: string | undefined;
  let storedPath: string | undefined;
  let transaction = false;
  try {
    // Session advisory lock avoids duplicate downloads even with multiple workers.
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 9182)) AS locked", [sourceId]);
    locked = Boolean(lock.rows[0].locked);
    if (!locked) return;
    const result = await client.query("SELECT * FROM regulatory_sources WHERE id = $1 AND enabled", [sourceId]);
    const source = result.rows[0];
    if (!source) return;
    // The source lock proves no other live checker owns this source. A prior
    // CHECKING record therefore belongs to a worker interrupted before completion.
    await client.query(`UPDATE regulatory_source_checks SET status = 'FAILED', completed_at = NOW(),
      error_message = 'Previous worker stopped before this check completed.'
      WHERE source_id = $1 AND status = 'CHECKING'`, [sourceId]);
    checkId = randomUUID();
    await client.query("INSERT INTO regulatory_source_checks (id, source_id, status) VALUES ($1, $2, 'CHECKING')", [checkId, sourceId]);
    await client.query(`UPDATE regulatory_sources SET last_checked_at = NOW(), last_status = 'CHECKING', last_error = NULL,
      next_check_at = NOW() + check_interval_minutes * INTERVAL '1 minute' WHERE id = $1`, [sourceId]);
    const downloaded = await (dependencies.download ?? downloadRemoteDocument)(source.source_url);
    const extracted = await (dependencies.extract ?? extractDocument)(downloaded.contents, downloaded.mimeType);
    // Incomplete extraction must not masquerade as removed legal provisions.
    if (extracted.warnings.length) throw new Error(`Incomplete extraction: ${extracted.warnings.join("; ")}`);
    const currentSections = comparableSections(extracted.sections);
    const newHash = textHash(currentSections);
    const rawHash = createHash("sha256").update(downloaded.contents).digest("hex");
    const previous = source.last_document_id
      ? (await client.query<ComparableSection>(selectSections, [source.last_document_id])).rows : [];
    const oldHash = previous.length ? textHash(previous) : source.last_text_hash;
    const changed = Boolean(oldHash && newHash !== oldHash);
    let documentId: string | null = source.last_document_id;
    await client.query("BEGIN"); transaction = true;
    if (changed || !documentId) {
      documentId = randomUUID();
      const key = `${documentId}${downloaded.mimeType === "text/html" ? ".html" : ".pdf"}`;
      storedPath = await storeUpload(key, downloaded.contents);
      const version = await allocateVersion(client, {
        sourceUrl: source.source_url, documentType: "regulation", filename: downloaded.filename,
        organizationId: source.organization_id, versionLabel: `Detected ${new Date().toISOString()}`,
      });
      const metadata = { ...extracted.metadata, monitorTextHash: newHash, monitorSourceId: source.id,
        legalMetadataVerified: false, monitoringSnapshot: true };
      await client.query(`INSERT INTO documents
        (id, filename, mime_type, file_size_bytes, storage_key, content_hash, normalized_content_hash, document_type,
         source_type, source_url, retrieved_at, processing_status, processed_at, extraction_metadata,
         document_group_id, version_number, version_label, organization_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'regulation', 'REMOTE', $8, NOW(), 'COMPLETED', NOW(), $9::jsonb, $10, $11, $12, $13)`,
      [documentId, downloaded.filename, downloaded.mimeType, downloaded.contents.length, key, rawHash, newHash,
        source.source_url, JSON.stringify(metadata), version.documentGroupId, version.versionNumber, version.versionLabel, source.organization_id]);
      await saveSections(client, documentId, extracted.sections);
      if (changed && source.last_document_id) {
        const comparison = compareSections(previous.filter((section) => section.section_type !== "DOCUMENT_METADATA"), currentSections.filter((section) => section.section_type !== "DOCUMENT_METADATA"));
        await client.query(`INSERT INTO regulatory_update_candidates
          (id, source_id, check_id, previous_document_id, new_document_id, comparison)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [randomUUID(), sourceId, checkId, source.last_document_id, documentId, JSON.stringify(comparison)]);
      }
    }
    const status = changed ? "CHANGED" : oldHash ? "UNCHANGED" : "BASELINE_CREATED";
    await client.query(`UPDATE regulatory_sources SET last_status = $2, last_error = NULL,
      last_successful_check_at = NOW(), last_text_hash = $3, last_document_id = $4 WHERE id = $1`, [sourceId, status, newHash, documentId]);
    await client.query(`UPDATE regulatory_source_checks SET status = $2, completed_at = NOW(),
      content_hash = $3, text_hash = $4, document_id = $5 WHERE id = $1`, [checkId, status, rawHash, newHash, documentId]);
    await client.query("COMMIT"); transaction = false; storedPath = undefined;
  } catch (error) {
    if (transaction) await client.query("ROLLBACK");
    if (storedPath) await unlink(storedPath).catch(() => undefined);
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Source check failed.";
    if (checkId) {
      await client.query("UPDATE regulatory_source_checks SET status = 'FAILED', completed_at = NOW(), error_message = $2 WHERE id = $1", [checkId, message]);
      await client.query("UPDATE regulatory_sources SET last_status = 'FAILED', last_error = $2 WHERE id = $1", [sourceId, message]);
    }
    console.error(`Regulatory source check failed for ${sourceId}: ${message}`);
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 9182))", [sourceId]);
    } finally { client.release(); }
  }
}

async function saveSections(client: PoolClient, documentId: string, sections: Parameters<typeof comparableSections>[0]) {
  const ids = sections.map(() => randomUUID());
  for (const [index, section] of sections.entries()) {
    const normalized = normalizeExtractedText(section.content);
    await client.query(`INSERT INTO document_sections
      (id, document_id, section_index, parent_section_id, section_type, heading, content,
       normalized_content, normalized_hash, page_start, page_end, source_reference)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [ids[index], documentId, index, section.parentSectionIndex === null ? null : ids[section.parentSectionIndex],
      section.sectionType, section.heading, section.content, normalized, createHash("sha256").update(normalized).digest("hex"),
      section.pageStart, section.pageEnd, section.sourceReference]);
  }
}
