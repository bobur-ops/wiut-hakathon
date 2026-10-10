import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { pool, migrate } from "../db.js";
import { extractDocument, normalizeExtractedText, UnsupportedDocumentError } from "./extract.js";
import { DOCUMENT_QUEUE, VERSION_IMPORT_QUEUE, createJobQueue } from "./queue.js";
import { getStoredFilePath, storeUpload } from "./storage.js";
import { downloadRemoteDocument } from "./remote.js";
import { allocateVersion } from "./versions.js";

const boss = createJobQueue();

async function run() {
  await migrate();
  boss.on("error", (error) => console.error("pg-boss error", error));
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE);
  await boss.createQueue(VERSION_IMPORT_QUEUE);
  await boss.work<{ importItemId: string }>(VERSION_IMPORT_QUEUE, async ([job]) => {
    if (!job) return;
    await importVersionItem(job.data.importItemId);
  });
  await boss.work<{ documentId: string }>(DOCUMENT_QUEUE, async ([job]) => {
    if (!job) return;
    const { documentId } = job.data;
    const { rows } = await pool.query(
      "SELECT storage_key, mime_type, declared_language FROM documents WHERE id = $1",
      [documentId],
    );
    const document = rows[0] as { storage_key: string; mime_type: string; declared_language: string | null } | undefined;
    if (!document) return;

    await pool.query(
      "UPDATE documents SET processing_status = 'PROCESSING', error_message = NULL WHERE id = $1",
      [documentId],
    );

    try {
      const contents = await readFile(getStoredFilePath(document.storage_key));
      const result = await extractDocument(contents, document.mime_type, {
        declaredLanguage: document.declared_language,
      });
      const sectionIds = result.sections.map(() => randomUUID());
      const normalizedSections = result.sections.map((section) => normalizeExtractedText(section.content));
      const normalizedContentHash = createHash("sha256")
        .update(result.sections.map((section, index) => {
          const parentReference = section.parentSectionIndex === null
            ? ""
            : result.sections[section.parentSectionIndex]?.sourceReference ?? "";
          return [section.sectionType, section.sourceReference ?? "", parentReference, normalizedSections[index]].join("\u0000");
        }).join("\n"))
        .digest("hex");
      result.metadata.normalizedSectionCount = result.sections.length;
      result.metadata.normalizedContentHash = normalizedContentHash;
      const status = result.warnings.length ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM document_sections WHERE document_id = $1", [documentId]);
        for (const [sectionIndex, section] of result.sections.entries()) {
          await client.query(
            `INSERT INTO document_sections
              (id, document_id, section_index, parent_section_id, section_type, heading, content,
               normalized_content, normalized_hash, page_start, page_end, source_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              sectionIds[sectionIndex],
              documentId,
              sectionIndex,
              section.parentSectionIndex === null ? null : sectionIds[section.parentSectionIndex],
              section.sectionType,
              section.heading,
              section.content,
              normalizedSections[sectionIndex],
              createHash("sha256").update(normalizedSections[sectionIndex] ?? "").digest("hex"),
              section.pageStart,
              section.pageEnd,
              section.sourceReference,
            ],
          );
        }
        if (typeof result.metadata.title === "string") {
          await client.query(
            `UPDATE document_groups SET title = $2
             WHERE id = (SELECT document_group_id FROM documents WHERE id = $1)`,
            [documentId, result.metadata.title],
          );
        }
        await client.query(
          `UPDATE documents SET processing_status = $2, extraction_metadata = $3,
             error_message = $4, normalized_content_hash = $5, processed_at = NOW() WHERE id = $1`,
          [documentId, status, JSON.stringify(result.metadata), result.warnings.length ? result.warnings.join("; ") : null, normalizedContentHash],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await finishImportItem(documentId, status, null);
    } catch (error) {
      const unsupported = error instanceof UnsupportedDocumentError;
      if (!unsupported) console.error(`Document extraction failed for ${documentId}`, error);
      await pool.query(
        `UPDATE documents SET processing_status = $2, error_message = $3,
           processed_at = NOW() WHERE id = $1`,
        [
          documentId,
          unsupported ? "UNSUPPORTED" : "FAILED",
          unsupported
            ? error.message
            : "Document extraction failed. The file may be malformed or unsupported.",
        ],
      );
      await finishImportItem(documentId, unsupported ? "UNSUPPORTED" : "FAILED", error instanceof Error ? error.message : "Extraction failed.");
      if (!unsupported) throw error;
    }
  });

  console.info(`Document worker listening on queue: ${DOCUMENT_QUEUE}`);
}

async function refreshBatchStatus(batchId: string) {
  await pool.query(
    `UPDATE document_import_batches AS batch
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM document_import_items WHERE batch_id = batch.id AND status IN ('QUEUED', 'DOWNLOADING', 'QUEUED_EXTRACTION')) THEN 'PROCESSING'
       WHEN EXISTS (SELECT 1 FROM document_import_items WHERE batch_id = batch.id AND status IN ('FAILED', 'UNSUPPORTED')) THEN 'COMPLETED_WITH_ERRORS'
       ELSE 'COMPLETED'
     END,
     completed_at = CASE
       WHEN EXISTS (SELECT 1 FROM document_import_items WHERE batch_id = batch.id AND status IN ('QUEUED', 'DOWNLOADING', 'QUEUED_EXTRACTION')) THEN NULL
       ELSE NOW()
     END
     WHERE batch.id = $1`,
    [batchId],
  );
}

async function finishImportItem(documentId: string, status: string, error: string | null) {
  const result = await pool.query(
    `UPDATE document_import_items SET status = $2, error_message = $3,
       completed_at = NOW()
     WHERE document_id = $1 RETURNING batch_id`,
    [documentId, status, error],
  );
  if (result.rows[0]) await refreshBatchStatus(result.rows[0].batch_id);
}

async function importVersionItem(itemId: string) {
  const claimed = await pool.query(
    `UPDATE document_import_items SET status = 'DOWNLOADING', error_message = NULL
     WHERE id = $1 AND status = 'QUEUED'
     RETURNING batch_id, source_url, revision_date::text, version_label, declared_language`,
    [itemId],
  );
  const item = claimed.rows[0];
  if (!item) return;
  await refreshBatchStatus(item.batch_id);

  let storedPath: string | undefined;
  let documentId: string | undefined;
  try {
    const downloaded = await downloadRemoteDocument(item.source_url);
    documentId = randomUUID();
    const storageKey = `${documentId}${downloaded.filename.toLowerCase().endsWith(".html") ? ".html" : ".pdf"}`;
    const contentHash = createHash("sha256").update(downloaded.contents).digest("hex");
    storedPath = await storeUpload(storageKey, downloaded.contents);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const version = await allocateVersion(client, {
        sourceUrl: item.source_url,
        documentType: "regulation",
        filename: downloaded.filename,
        versionLabel: item.version_label,
        revisionDate: item.revision_date,
      });
      await client.query(
        `INSERT INTO documents
          (id, filename, mime_type, file_size_bytes, storage_key, content_hash, document_type,
           declared_language, source_type, source_url, retrieved_at, processing_status,
           document_group_id, version_number, version_label, revision_date)
         VALUES ($1, $2, $3, $4, $5, $6, 'regulation', $7, 'REMOTE', $8, NOW(), 'QUEUED', $9, $10, $11, $12)`,
        [documentId, downloaded.filename, downloaded.mimeType, downloaded.contents.length, storageKey, contentHash,
          item.declared_language, item.source_url, version.documentGroupId, version.versionNumber, version.versionLabel, version.revisionDate],
      );
      await client.query(
        "UPDATE document_import_items SET document_id = $2, status = 'QUEUED_EXTRACTION' WHERE id = $1",
        [itemId, documentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await boss.send(DOCUMENT_QUEUE, { documentId });
  } catch (error) {
    if (storedPath) await unlink(storedPath).catch(() => undefined);
    console.error(`Bulk version import failed for ${item.source_url}`, error);
    await pool.query(
      `UPDATE document_import_items SET status = 'FAILED', error_message = $2,
         document_id = NULL, completed_at = NOW() WHERE id = $1`,
      [itemId, error instanceof Error ? error.message : "Could not import this revision."],
    );
    if (documentId) await pool.query("DELETE FROM documents WHERE id = $1", [documentId]);
    await refreshBatchStatus(item.batch_id);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function shutdown() {
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
