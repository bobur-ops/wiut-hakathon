import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { pool, migrate } from "../db.js";
import { extractDocument, normalizeExtractedText, UnsupportedDocumentError } from "./extract.js";
import { ASSESSMENT_QUEUE, ASSESSMENT_IMPACT_QUEUE, DOCUMENT_QUEUE, VERSION_IMPORT_QUEUE, LEGISLATION_IMPORT_QUEUE, EMAIL_QUEUE, createJobQueue } from "./queue.js";
import { processDocumentImpact, queueDocumentImpact } from "../assessments/impact.js";
import { processAssessment } from "../assessments/service.js";
import { getStoredFilePath, storeUpload } from "./storage.js";
import { downloadRemoteDocument } from "./remote.js";
import { allocateVersion } from "./versions.js";
import { startRegulatoryMonitor } from "../monitoring/service.js";
import { sendDelivery, queueNotification } from "../notifications/service.js";

const boss = createJobQueue();

async function run() {
  await migrate();
  boss.on("error", (error) => console.error("pg-boss error", error));
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE);
  await boss.createQueue(VERSION_IMPORT_QUEUE);
  await boss.createQueue(ASSESSMENT_QUEUE);
  await boss.createQueue(ASSESSMENT_IMPACT_QUEUE);
  await boss.createQueue(LEGISLATION_IMPORT_QUEUE);
  await boss.createQueue(EMAIL_QUEUE);
  await boss.work<{deliveryId:string}>(EMAIL_QUEUE, async ([job]) => { if (job) await sendDelivery(job.data.deliveryId); });
  await boss.work<{organizationId:string;itemId:string}>(LEGISLATION_IMPORT_QUEUE, async ([job]) => {
    if (job) await importLikelyLegislation(job.data.organizationId,job.data.itemId);
  });
  await boss.work<{ documentId: string }>(ASSESSMENT_IMPACT_QUEUE, async ([job]) => {
    if (job) await processDocumentImpact(job.data.documentId, boss);
  });
  await startRegulatoryMonitor(boss);
  await boss.work<{ importItemId: string }>(VERSION_IMPORT_QUEUE, async ([job]) => {
    if (!job) return;
    await importVersionItem(job.data.importItemId);
  });
  await boss.work<{ assessmentId: string }>(ASSESSMENT_QUEUE, async ([job]) => {
    if (!job) return;
    try { await processAssessment(job.data); }
    finally {
      const assessment=(await pool.query("SELECT id,status,organization_id,processing_stage FROM assessments WHERE id=$1",[job.data.assessmentId])).rows[0];
      if (assessment?.organization_id && ["COMPLETED","FAILED"].includes(assessment.status)) {
        const counts=await pool.query("SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE classification IN ('POTENTIAL_CONFLICT','MISSING_EVIDENCE','REQUIRES_REVIEW'))::int AS attention FROM findings WHERE assessment_id=$1",[assessment.id]);
        const url=`${(process.env.WEB_APP_URL??"http://localhost:5173").replace(/\/$/,"")}/assessments/${assessment.id}`;
        try { await queueNotification({organizationId:assessment.organization_id,eventKey:`assessment:${assessment.id}:${assessment.status}`,type:assessment.status==="COMPLETED"?"ASSESSMENT_COMPLETED":"ASSESSMENT_FAILED",
          subject:assessment.status==="COMPLETED"?"RegCheck assessment results are ready":"RegCheck assessment could not be completed",
          body:assessment.status==="COMPLETED"?`An AI-assisted assessment is complete. ${counts.rows[0].total} findings; ${counts.rows[0].attention} need attention. Human review is required; this is not legal certification.\n\nOpen results: ${url}`:`An assessment failed or stopped before completion. Please open the workspace to review its status and coverage warnings.\n\nOpen assessment: ${url}`},boss); }
        catch(error) { console.error("Could not queue assessment email notification",error); }
      }
    }
  });
  await boss.work<{ documentId: string }>(DOCUMENT_QUEUE, async ([job]) => {
    if (!job) return;
    const { documentId } = job.data;
    const { rows } = await pool.query(
      "SELECT storage_key, mime_type, declared_language, extraction_metadata FROM documents WHERE id = $1",
      [documentId],
    );
    const document = rows[0] as { storage_key: string; mime_type: string; declared_language: string | null; extraction_metadata: Record<string,unknown> | null } | undefined;
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
      result.metadata = { ...(document.extraction_metadata ?? {}), ...result.metadata };
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
      if (status === "COMPLETED" || status === "COMPLETED_WITH_WARNINGS") {
        const type = await pool.query("SELECT document_type FROM documents WHERE id=$1", [documentId]);
        if (["policy","procedure"].includes(type.rows[0]?.document_type)) {
          await queueDocumentImpact(documentId, boss).catch(error => console.error("Could not queue policy impact assessment", error));
        }
        const discoveredAct = await pool.query(`SELECT 1 FROM legislation_inbox WHERE imported_document_id=$1 AND status='IMPORTED'
          AND review_decision IS DISTINCT FROM 'NOT_RELEVANT'`,[documentId]);
        if (discoveredAct.rowCount) await queueDocumentImpact(documentId,boss).catch(error => console.error("Could not queue new-legislation impact assessment",error));
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
      await pool.query(`UPDATE legislation_inbox SET status='IMPORT_FAILED',status_note=$2
        WHERE imported_document_id=$1 AND status='IMPORTED'`,[documentId,unsupported && error instanceof Error ? error.message : "Document extraction failed; inspect the official source or upload a text-readable copy."]);
      await finishImportItem(documentId, unsupported ? "UNSUPPORTED" : "FAILED", error instanceof Error ? error.message : "Extraction failed.");
      if (!unsupported) throw error;
    }
  });

  console.info(`Document worker listening on queues: ${DOCUMENT_QUEUE}, ${VERSION_IMPORT_QUEUE}, ${ASSESSMENT_QUEUE}`);
}

async function importLikelyLegislation(organizationId: string,itemId: string) {
  const claimed = await pool.query(`UPDATE legislation_inbox SET status='IMPORTING',status_note=NULL
    WHERE organization_id=$1 AND item_id=$2 AND status='QUEUED' RETURNING item_id`,[organizationId,itemId]);
  if (!claimed.rowCount) return;
  let storedPath: string | undefined;
  let documentId: string | undefined;
  let persisted = false;
  try {
    const row = (await pool.query(`SELECT item.lex_document_id
      FROM legislation_discovery_items item JOIN legislation_inbox inbox ON inbox.item_id=item.id
      WHERE item.id=$1 AND inbox.organization_id=$2`,[itemId,organizationId])).rows[0];
    if (!row) throw new Error("Discovered act metadata is missing.");
    // The listing's /{lang}/pdfs/{id} URL is a viewer page, not necessarily
    // the PDF endpoint. Try Lex.uz's canonical binary endpoint, then the
    // canonical /docs/{id} text page for cases where Lex serves the PDF only
    // through its document viewer.
    let sourceUrl = `https://lex.uz/pdffile/${row.lex_document_id}`;
    let downloaded: Awaited<ReturnType<typeof downloadRemoteDocument>>;
    try { downloaded = await downloadRemoteDocument(sourceUrl); }
    catch(pdfError) {
      sourceUrl = `https://lex.uz/docs/${row.lex_document_id}`;
      try { downloaded = await downloadRemoteDocument(sourceUrl); }
      catch(pageError) {
        const pdfMessage=pdfError instanceof Error?pdfError.message:"PDF download failed";
        const pageMessage=pageError instanceof Error?pageError.message:"Lex.uz page download failed";
        throw new Error(`Could not retrieve the official act. PDF: ${pdfMessage} Page: ${pageMessage}`);
      }
    }
    documentId = randomUUID();
    const storageKey = `${documentId}${downloaded.filename.toLowerCase().endsWith(".html") ? ".html" : ".pdf"}`;
    const contentHash = createHash("sha256").update(downloaded.contents).digest("hex");
    storedPath = await storeUpload(storageKey,downloaded.contents);
    const client = await pool.connect();
    let version: Awaited<ReturnType<typeof allocateVersion>>;
    try {
      await client.query("BEGIN");
      version = await allocateVersion(client,{organizationId,sourceUrl,documentType:"legislation",filename:downloaded.filename,versionLabel:`New act ${row.lex_document_id}`});
      await client.query(`INSERT INTO documents
        (id,filename,mime_type,file_size_bytes,storage_key,content_hash,document_type,source_type,source_url,retrieved_at,
         processing_status,extraction_metadata,document_group_id,version_number,version_label,revision_date,organization_id)
        VALUES ($1,$2,$3,$4,$5,$6,'legislation','REMOTE',$7,NOW(),'QUEUED',$8::jsonb,$9,$10,$11,$12,$13)`,
      [documentId,downloaded.filename,downloaded.mimeType,downloaded.contents.length,storageKey,contentHash,sourceUrl,
        JSON.stringify({monitoringSnapshot:true,discoveryItemId:itemId,legislationAct:true,legalMetadataVerified:false}),
        version.documentGroupId,version.versionNumber,version.versionLabel,version.revisionDate,organizationId]);
      await client.query(`UPDATE legislation_inbox SET status='IMPORTED',imported_document_id=$3,
        status_note='Automatically imported from the official Lex.uz source after a keyword match; relevance remains for human review.'
        WHERE organization_id=$1 AND item_id=$2`,[organizationId,itemId,documentId]);
      await client.query("COMMIT");
      persisted = true;
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const extractionJob = await boss.send(DOCUMENT_QUEUE,{documentId},{retryLimit:2,retryDelay:30});
    if (!extractionJob) throw new Error("Document extraction queue did not accept the discovered act.");
    storedPath = undefined;
  } catch(error) {
    if (storedPath && !persisted) await unlink(storedPath).catch(()=>undefined);
    const message = error instanceof Error ? error.message.slice(0,1000) : "Automatic act import failed.";
    await pool.query(`UPDATE legislation_inbox SET status='IMPORT_FAILED',status_note=$3
      WHERE organization_id=$1 AND item_id=$2 AND status IN ('IMPORTING','IMPORTED')`,[organizationId,itemId,message]);
    if (documentId) await pool.query("UPDATE documents SET processing_status='FAILED',error_message=$2 WHERE id=$1",[documentId,message]);
    throw error;
  }
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
      RETURNING batch_id, source_url, revision_date::text, version_label, declared_language,
        (SELECT organization_id FROM document_import_batches WHERE id = document_import_items.batch_id) AS organization_id`,
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
        organizationId: item.organization_id,
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
            document_group_id, version_number, version_label, revision_date, organization_id)
          VALUES ($1, $2, $3, $4, $5, $6, 'regulation', $7, 'REMOTE', $8, NOW(), 'QUEUED', $9, $10, $11, $12, $13)`,
        [documentId, downloaded.filename, downloaded.mimeType, downloaded.contents.length, storageKey, contentHash,
          item.declared_language, item.source_url, version.documentGroupId, version.versionNumber, version.versionLabel, version.revisionDate, item.organization_id],
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
