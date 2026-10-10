import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { pool, migrate } from "../db.js";
import { extractDocument, normalizeExtractedText, UnsupportedDocumentError } from "./extract.js";
import { DOCUMENT_QUEUE, createJobQueue } from "./queue.js";
import { getStoredFilePath } from "./storage.js";

const boss = createJobQueue();

async function run() {
  await migrate();
  boss.on("error", (error) => console.error("pg-boss error", error));
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE);
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
        const status = result.warnings.length ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
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
      if (!unsupported) throw error;
    }
  });

  console.info(`Document worker listening on queue: ${DOCUMENT_QUEUE}`);
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
