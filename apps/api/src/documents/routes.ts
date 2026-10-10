import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { DOCUMENT_QUEUE, VERSION_IMPORT_QUEUE } from "./queue.js";
import { storeUpload } from "./storage.js";
import { discoverLexDocumentVersions, downloadRemoteDocument, RemoteDocumentError } from "./remote.js";
import { compareSections } from "./compare.js";
import { allocateVersion, DocumentVersionError } from "./versions.js";
import type { PgBoss } from "pg-boss";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const DOCUMENT_TYPES = ["policy", "regulation", "guidance", "procedure", "other"] as const;
const DOCUMENT_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED", "UNSUPPORTED"] as const;
const BATCH_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "COMPLETED_WITH_ERRORS"] as const;
const IMPORT_ITEM_STATUSES = ["QUEUED", "DOWNLOADING", "QUEUED_EXTRACTION", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED", "UNSUPPORTED"] as const;
const SECTION_TYPES = ["DOCUMENT_METADATA", "DOCUMENT_TITLE", "CHAPTER", "ARTICLE", "PARAGRAPH", "PAGE", "SIGNATURE"] as const;
const errorResponseSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
} as const;
const documentStatusSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    document_group_id: { type: "string", format: "uuid" },
    version_number: { type: "integer" },
    version_label: { type: "string" },
    revision_date: { type: ["string", "null"], format: "date" },
    filename: { type: "string" },
    mime_type: { type: "string" },
    file_size_bytes: { type: "integer" },
    content_hash: { type: "string" },
    normalized_content_hash: { type: ["string", "null"] },
    document_type: { type: "string", enum: DOCUMENT_TYPES },
    declared_language: { type: ["string", "null"] },
    source_type: { type: "string", enum: ["UPLOAD", "REMOTE"] },
    source_url: { type: ["string", "null"] },
    retrieved_at: { type: ["string", "null"], format: "date-time" },
    processing_status: {
      type: "string",
      enum: DOCUMENT_STATUSES,
    },
    extraction_metadata: { type: "object", additionalProperties: true },
    error_message: { type: ["string", "null"] },
    uploaded_at: { type: "string", format: "date-time" },
    processed_at: { type: ["string", "null"], format: "date-time" },
  },
} as const;
const allowedTypes: Record<string, { mimeType: string; extension: string }> = {
  pdf: { mimeType: "application/pdf", extension: ".pdf" },
  docx: {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
  },
  txt: { mimeType: "text/plain", extension: ".txt" },
  html: { mimeType: "text/html", extension: ".html" },
};

type EnqueueResult =
  | {
      statusCode: 202;
      body: { document_id: string; document_group_id: string; version_number: number; version_label: string; filename: string; processing_status: "QUEUED"; file_size_bytes: number; content_hash: string };
    }
  | { statusCode: 400 | 413 | 415 | 503; body: { error: string } };

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "Upload failed";
}

export function registerDocumentRoutes(app: FastifyInstance, boss: PgBoss) {
  app.get<{
    Querystring: {
      document_type?: typeof DOCUMENT_TYPES[number];
      source_type?: "UPLOAD" | "REMOTE";
      processing_status?: typeof DOCUMENT_STATUSES[number];
      document_group_id?: string;
      q?: string;
      limit?: number;
      offset?: number;
    };
  }>("/api/documents", {
    schema: {
      tags: ["Documents"],
      summary: "List saved document snapshots with optional filters",
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_type: { type: "string", enum: DOCUMENT_TYPES },
          source_type: { type: "string", enum: ["UPLOAD", "REMOTE"] },
          processing_status: { type: "string", enum: DOCUMENT_STATUSES },
          document_group_id: { type: "string", format: "uuid" },
          q: { type: "string", minLength: 1, maxLength: 200, description: "Search filename, version label, source URL, or logical document title." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            total: { type: "integer" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            documents: { type: "array", items: documentStatusSchema },
          },
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { document_type, source_type, processing_status, document_group_id, q } = request.query;
    const limit = Number(request.query.limit ?? 20);
    const offset = Number(request.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return reply.code(400).send({ error: "limit must be 1–100 and offset must be a non-negative integer." });
    }
    const conditions: string[] = [];
    const values: unknown[] = [];
    const addFilter = (sql: string, value: unknown) => {
      values.push(value);
      conditions.push(sql.replace("?", `$${values.length}`));
    };
    if (document_type) addFilter("document.document_type = ?", document_type);
    if (source_type) addFilter("document.source_type = ?", source_type);
    if (processing_status) addFilter("document.processing_status = ?", processing_status);
    if (document_group_id) addFilter("document.document_group_id = ?::uuid", document_group_id);
    if (q) {
      values.push(`%${q}%`);
      const parameter = `$${values.length}`;
      conditions.push(`(document.filename ILIKE ${parameter} OR document.version_label ILIKE ${parameter} OR document.source_url ILIKE ${parameter} OR groups.title ILIKE ${parameter})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const count = await pool.query(
      `SELECT COUNT(*)::integer AS total FROM documents AS document
       LEFT JOIN document_groups AS groups ON groups.id = document.document_group_id ${where}`,
      values,
    );
    const pageValues = [...values, limit, offset];
    const { rows } = await pool.query(
      `SELECT document.id, document.document_group_id, document.version_number,
              document.version_label, document.revision_date::text, document.filename,
              document.mime_type, document.file_size_bytes, document.content_hash,
              document.normalized_content_hash, document.document_type, document.declared_language,
              document.source_type, document.source_url, document.retrieved_at,
              document.processing_status, document.extraction_metadata, document.error_message,
              document.uploaded_at, document.processed_at
       FROM documents AS document
       LEFT JOIN document_groups AS groups ON groups.id = document.document_group_id
       ${where}
       ORDER BY document.uploaded_at DESC, document.id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues,
    );
    return { total: count.rows[0].total, limit, offset, documents: rows };
  });

  app.post<{ Body: { url: string; declared_language?: string } }>("/api/documents/from-url/versions", {
    schema: {
      tags: ["Documents"],
      summary: "Discover and queue all available Lex.uz revisions for a law",
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", description: "Lex.uz /docs/{id} page; its revision list is discovered from the HTML." },
          declared_language: { type: "string" },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            import_id: { type: "string", format: "uuid" },
            title: { type: "string" },
            version_count: { type: "integer" },
            status: { type: "string", enum: BATCH_STATUSES },
          },
        },
        400: errorResponseSchema,
        502: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const discovered = await discoverLexDocumentVersions(request.body.url);
      if (discovered.versions.length > 100) {
        return reply.code(400).send({ error: "The page lists more than 100 revisions; import them in smaller groups." });
      }
      const batchId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO document_import_batches (id, source_url, status) VALUES ($1, $2, 'QUEUED')",
          [batchId, request.body.url],
        );
        for (const version of discovered.versions) {
          const itemId = randomUUID();
          await client.query(
            `INSERT INTO document_import_items
              (id, batch_id, source_url, revision_date, version_label, declared_language, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED')`,
            [itemId, batchId, version.url, version.revisionDate, version.label, request.body.declared_language ?? null],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const { rows: items } = await pool.query(
        "SELECT id FROM document_import_items WHERE batch_id = $1 ORDER BY revision_date NULLS LAST, source_url",
        [batchId],
      );
      for (const item of items) {
        try {
          await boss.send(VERSION_IMPORT_QUEUE, { importItemId: item.id });
        } catch (error) {
          await pool.query(
            `UPDATE document_import_items SET status = 'FAILED', error_message = $2,
               completed_at = NOW() WHERE id = $1`,
            [item.id, error instanceof Error ? error.message : "Could not queue revision download."],
          );
        }
      }
      await pool.query(
        `UPDATE document_import_batches SET status = CASE
           WHEN EXISTS (SELECT 1 FROM document_import_items WHERE batch_id = $1 AND status IN ('QUEUED', 'DOWNLOADING', 'QUEUED_EXTRACTION')) THEN 'PROCESSING'
           WHEN EXISTS (SELECT 1 FROM document_import_items WHERE batch_id = $1 AND status = 'FAILED') THEN 'COMPLETED_WITH_ERRORS'
           ELSE 'COMPLETED' END,
         completed_at = CASE WHEN EXISTS (
           SELECT 1 FROM document_import_items WHERE batch_id = $1 AND status IN ('QUEUED', 'DOWNLOADING', 'QUEUED_EXTRACTION')
         ) THEN NULL ELSE NOW() END WHERE id = $1`,
        [batchId],
      );
      const batchStatus = await pool.query("SELECT status FROM document_import_batches WHERE id = $1", [batchId]);
      return reply.code(202).send({
        import_id: batchId,
        title: discovered.title,
        version_count: discovered.versions.length,
        status: batchStatus.rows[0].status,
      });
    } catch (error) {
      if (error instanceof RemoteDocumentError) return reply.code(400).send({ error: error.message });
      request.log.error(error, "Could not discover Lex.uz revisions");
      return reply.code(502).send({ error: "Could not retrieve the Lex.uz revision list." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/document-imports/:id", {
    schema: {
      tags: ["Documents"],
      summary: "Get status and per-revision results for a bulk Lex.uz import",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      response: {
        200: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            source_url: { type: "string" },
            status: { type: "string", enum: BATCH_STATUSES },
            versions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  document_id: { type: ["string", "null"], format: "uuid" },
                  source_url: { type: "string" },
                  revision_date: { type: ["string", "null"], format: "date" },
                  version_label: { type: "string" },
                  status: { type: "string", enum: IMPORT_ITEM_STATUSES },
                  error_message: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const batch = await pool.query("SELECT id, source_url, status FROM document_import_batches WHERE id = $1", [request.params.id]);
    if (!batch.rows[0]) return reply.code(404).send({ error: "Import not found." });
    const { rows: versions } = await pool.query(
      `SELECT document_id, source_url, revision_date::text, version_label, status, error_message
       FROM document_import_items WHERE batch_id = $1 ORDER BY revision_date NULLS LAST, source_url`,
      [request.params.id],
    );
    return { ...batch.rows[0], versions };
  });

  app.get("/api/document-groups", {
    schema: {
      tags: ["Documents"],
      summary: "List logical documents and their snapshot counts",
      response: {
        200: {
          type: "object",
          properties: {
            documents: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  title: { type: "string" },
                  document_type: { type: "string", enum: DOCUMENT_TYPES },
                  source_key: { type: "string" },
                  version_count: { type: "integer" },
                  created_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const { rows } = await pool.query(
      `SELECT groups.id, groups.title, groups.document_type, groups.source_key, groups.created_at,
              COUNT(documents.id)::integer AS version_count
       FROM document_groups AS groups JOIN documents ON documents.document_group_id = groups.id
       GROUP BY groups.id ORDER BY groups.created_at DESC`,
    );
    return { documents: rows };
  });

  app.get<{ Params: { id: string } }>("/api/document-groups/:id/versions", {
    schema: {
      tags: ["Documents"],
      summary: "List snapshots of a logical document (numbered by import order, not legal chronology)",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      response: {
        200: {
          type: "object",
          properties: {
            document_group_id: { type: "string", format: "uuid" },
            versions: { type: "array", items: documentStatusSchema },
          },
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const group = await pool.query("SELECT 1 FROM document_groups WHERE id = $1", [request.params.id]);
    if (!group.rowCount) return reply.code(404).send({ error: "Document group not found." });
    const { rows } = await pool.query(
      `SELECT id, document_group_id, version_number, version_label, revision_date::text,
              filename, mime_type, file_size_bytes, content_hash, normalized_content_hash, document_type,
              declared_language, source_type, source_url, retrieved_at, processing_status,
              extraction_metadata, error_message, uploaded_at, processed_at
       FROM documents WHERE document_group_id = $1 ORDER BY version_number DESC`,
      [request.params.id],
    );
    return { document_group_id: request.params.id, versions: rows };
  });

  async function enqueueDocument(input: {
    request: { log: { error: (error: unknown, message: string) => void } };
    contents: Buffer;
    filename: string;
    mimeType: string;
    documentType: string;
    declaredLanguage: string | null;
    sourceType: "UPLOAD" | "REMOTE";
    sourceUrl?: string | null;
    documentGroupId?: string;
    versionLabel?: string;
    revisionDate?: string;
  }): Promise<EnqueueResult> {
    const { contents, filename, mimeType, documentType, declaredLanguage, sourceType, sourceUrl } = input;
    if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      return { statusCode: 400, body: { error: `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}.` } };
    }
    if (!contents.length) return { statusCode: 400, body: { error: "The document is empty." } };
    const extension = filename.toLowerCase().split(".").pop() ?? "";
    const expected = allowedTypes[extension];
    if (sourceType === "UPLOAD" && extension === "html") {
      return { statusCode: 415, body: { error: "HTML files are accepted only from allowlisted remote sources." } };
    }
    if (!expected || expected.mimeType !== mimeType) {
      return { statusCode: 415, body: { error: "Upload a PDF, DOCX, or TXT file with a matching content type." } };
    }
    const signatureIsValid =
      (extension === "pdf" && contents.subarray(0, 1024).includes(Buffer.from("%PDF-"))) ||
      (extension === "docx" && contents.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) ||
      (extension === "html" && /<(?:!doctype\s+html|html)\b/i.test(contents.toString("utf8", 0, 1024))) ||
      (extension === "txt" && !contents.includes(0));
    if (!signatureIsValid) {
      return { statusCode: 400, body: { error: "The file contents do not match the declared file type." } };
    }

    const id = randomUUID();
    const storageKey = `${id}${expected.extension}`;
    const contentHash = createHash("sha256").update(contents).digest("hex");
    let filePath: string | undefined;
    let version: Awaited<ReturnType<typeof allocateVersion>>;
    try {
      filePath = await storeUpload(storageKey, contents);
      const client = await pool.connect();
      try {
      await client.query("BEGIN");
      version = await allocateVersion(client, input);
      await client.query(
        `INSERT INTO documents
          (id, filename, mime_type, file_size_bytes, storage_key, content_hash,
           document_type, declared_language, source_type, source_url, retrieved_at, processing_status,
           document_group_id, version_number, version_label, revision_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            CASE WHEN $9 = 'REMOTE' THEN NOW() ELSE NULL END, 'QUEUED', $11, $12, $13, $14)`,
        [id, filename, mimeType, contents.length, storageKey, contentHash, documentType, declaredLanguage, sourceType, sourceUrl ?? null,
          version.documentGroupId, version.versionNumber, version.versionLabel, version.revisionDate],
      );
      await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await boss.send(DOCUMENT_QUEUE, { documentId: id });
    } catch (error) {
      await pool.query("DELETE FROM documents WHERE id = $1", [id]).catch(() => undefined);
      if (filePath) await unlink(filePath).catch(() => undefined);
      if (error instanceof DocumentVersionError) {
        return { statusCode: 400, body: { error: error.message } };
      }
      input.request.log.error(error, "Could not queue document extraction");
      return { statusCode: 503, body: { error: "Document could not be queued. Please retry." } };
    }

    return {
      statusCode: 202,
      body: {
        document_id: id,
        document_group_id: version.documentGroupId,
        version_number: version.versionNumber,
        version_label: version.versionLabel,
        filename,
        processing_status: "QUEUED",
        file_size_bytes: contents.length,
        content_hash: contentHash,
      },
    };
  }

  app.post("/api/documents", {
    schema: {
      tags: ["Documents"],
      summary: "Upload a document for background extraction",
      consumes: ["multipart/form-data"],
      body: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "string", format: "binary" },
          document_type: { type: "string", enum: DOCUMENT_TYPES, default: "policy" },
          declared_language: { type: "string" },
          document_group_id: { type: "string", format: "uuid", description: "Link an upload to an existing logical document." },
          version_label: { type: "string", minLength: 1, maxLength: 200 },
          revision_date: { type: "string", format: "date", description: "Revision date, not a verified legal effective date." },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            document_id: { type: "string", format: "uuid" },
            document_group_id: { type: "string", format: "uuid" },
            version_number: { type: "integer" },
            version_label: { type: "string" },
            filename: { type: "string" },
            processing_status: { type: "string", enum: ["QUEUED"] },
            file_size_bytes: { type: "integer" },
            content_hash: { type: "string" },
          },
        },
        400: errorResponseSchema,
        413: errorResponseSchema,
        415: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    let fileBuffer: Buffer | undefined;
    let originalFilename = "";
    let contentType = "";
    let documentType = "policy";
    let declaredLanguage: string | null = null;
    let documentGroupId: string | undefined;
    let versionLabel: string | undefined;
    let revisionDate: string | undefined;

    try {
      for await (const part of request.parts({
        limits: { files: 1, fields: 8, fileSize: MAX_FILE_SIZE },
      })) {
        if (part.type === "file") {
          originalFilename = part.filename;
          contentType = part.mimetype;
          fileBuffer = await part.toBuffer();
          if (part.file.truncated) {
      return reply.code(413).send({ error: "File exceeds the 5 MB limit." });
          }
        } else if (part.fieldname === "document_type") {
          documentType = String(part.value);
        } else if (part.fieldname === "declared_language") {
          declaredLanguage = String(part.value);
        } else if (part.fieldname === "document_group_id") {
          documentGroupId = String(part.value);
        } else if (part.fieldname === "version_label") {
          versionLabel = String(part.value);
        } else if (part.fieldname === "revision_date") {
          revisionDate = String(part.value);
        }
      }
    } catch (error) {
      const status = safeError(error).toLowerCase().includes("file too large") ? 413 : 400;
      if (status === 413) return reply.code(413).send({ error: "File exceeds the 5 MB limit." });
      return reply.code(400).send({ error: "Invalid multipart upload." });
    }

    if (!fileBuffer || !originalFilename) {
      return reply.code(400).send({ error: "A file field is required." });
    }

    const result = await enqueueDocument({
      request,
      contents: fileBuffer,
      filename: originalFilename,
      mimeType: contentType,
      documentType,
      declaredLanguage,
      sourceType: "UPLOAD",
      documentGroupId,
      versionLabel,
      revisionDate,
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post<{ Body: { url: string; document_type?: typeof DOCUMENT_TYPES[number]; declared_language?: string; document_group_id?: string; version_label?: string; revision_date?: string } }>("/api/documents/from-url", {
    schema: {
      tags: ["Documents"],
      summary: "Fetch an allowlisted official PDF or Lex.uz page and queue extraction",
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", description: "HTTPS PDF or Lex.uz /docs/{id} page on an allowlisted official domain." },
          document_type: { type: "string", enum: DOCUMENT_TYPES, default: "regulation" },
          declared_language: { type: "string" },
          document_group_id: { type: "string", format: "uuid" },
          version_label: { type: "string", minLength: 1, maxLength: 200 },
          revision_date: { type: "string", format: "date" },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            document_id: { type: "string", format: "uuid" },
            document_group_id: { type: "string", format: "uuid" },
            version_number: { type: "integer" },
            version_label: { type: "string" },
            filename: { type: "string" },
            processing_status: { type: "string", enum: ["QUEUED"] },
            file_size_bytes: { type: "integer" },
            content_hash: { type: "string" },
          },
        },
        400: errorResponseSchema,
        413: errorResponseSchema,
        415: errorResponseSchema,
        502: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    try {
      const downloaded = await downloadRemoteDocument(request.body.url);
      const result = await enqueueDocument({
        request,
        contents: downloaded.contents,
        filename: downloaded.filename,
        mimeType: downloaded.mimeType,
        documentType: request.body.document_type ?? "regulation",
        declaredLanguage: request.body.declared_language ?? null,
        sourceType: "REMOTE",
        sourceUrl: request.body.url,
        documentGroupId: request.body.document_group_id,
        versionLabel: request.body.version_label,
        revisionDate: request.body.revision_date,
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) {
      if (error instanceof RemoteDocumentError) {
        return reply.code(400).send({ error: error.message });
      }
      request.log.error(error, "Remote PDF download failed");
      return reply.code(502).send({ error: "Could not retrieve the remote PDF." });
    }
  });

  app.post<{ Body: { previous_document_id: string; current_document_id: string } }>("/api/documents/compare", {
    schema: {
      tags: ["Documents"],
      summary: "Compare two fetched snapshots of the same Lex.uz regulation",
      body: {
        type: "object",
        required: ["previous_document_id", "current_document_id"],
        additionalProperties: false,
        properties: {
          previous_document_id: { type: "string", format: "uuid" },
          current_document_id: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            previous_document_id: { type: "string", format: "uuid" },
            current_document_id: { type: "string", format: "uuid" },
            previous_normalized_content_hash: { type: ["string", "null"] },
            current_normalized_content_hash: { type: ["string", "null"] },
            summary: {
              type: "object",
              properties: {
                added: { type: "integer" },
                removed: { type: "integer" },
                modified: { type: "integer" },
                matched_by: { type: "string" },
              },
            },
            changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  change_type: { type: "string", enum: ["ADDED", "REMOVED", "MODIFIED"] },
                  source_reference: { type: "string" },
                  article_reference: { type: ["string", "null"] },
                  match_method: { type: "string", enum: ["stable-source-reference", "article-and-text-similarity"] },
                  needs_review: { type: "boolean" },
                  previous_text: { type: "string" },
                  new_text: { type: "string" },
                },
              },
            },
          },
        },
        400: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { previous_document_id: previousId, current_document_id: currentId } = request.body;
    if (previousId === currentId) {
      return reply.code(400).send({ error: "Choose two different document snapshots." });
    }

    const result = await pool.query(
      `SELECT id, source_type, source_url, mime_type, document_type, processing_status,
              normalized_content_hash
       FROM documents WHERE id = ANY($1::uuid[])`,
      [[previousId, currentId]],
    );
    const documents = new Map<string, Record<string, unknown>>(
      result.rows.map((row: Record<string, unknown>) => [String(row.id), row]),
    );
    const previous = documents.get(previousId);
    const current = documents.get(currentId);
    if (!previous || !current) return reply.code(404).send({ error: "One or both document snapshots were not found." });

    const isLexHtmlRegulation = (document: Record<string, unknown>) => {
      if (document.source_type !== "REMOTE" || document.document_type !== "regulation" || document.mime_type !== "text/html") return false;
      try {
        const url = new URL(String(document.source_url));
        return ["lex.uz", "www.lex.uz"].includes(url.hostname.toLowerCase()) && /^\/docs\/\d+\/?$/.test(url.pathname);
      } catch {
        return false;
      }
    };
    if (!isLexHtmlRegulation(previous) || !isLexHtmlRegulation(current)) {
      return reply.code(400).send({ error: "Comparison currently supports fetched Lex.uz HTML regulation snapshots only." });
    }
    if (new URL(String(previous.source_url)).pathname !== new URL(String(current.source_url)).pathname) {
      return reply.code(400).send({ error: "Both snapshots must refer to the same Lex.uz document." });
    }

    const completed = new Set(["COMPLETED", "COMPLETED_WITH_WARNINGS"]);
    if (!completed.has(String(previous.processing_status)) || !completed.has(String(current.processing_status))) {
      return reply.code(409).send({ error: "Both snapshots must finish extraction before comparison." });
    }
    if (!previous.normalized_content_hash || !current.normalized_content_hash) {
      return reply.code(409).send({ error: "A snapshot lacks normalized extraction data. Re-fetch it with the current extractor before comparison." });
    }

    const getSections = async (documentId: string) => {
      const sections = await pool.query(
        `SELECT section.section_type, section.source_reference, section.normalized_content,
                parent.source_reference AS parent_source_reference, parent.normalized_content AS parent_content
         FROM document_sections AS section
         LEFT JOIN document_sections AS parent ON parent.id = section.parent_section_id
         WHERE section.document_id = $1 ORDER BY section.section_index`,
        [documentId],
      );
      return sections.rows;
    };
    const [previousSections, currentSections] = await Promise.all([
      getSections(previousId),
      getSections(currentId),
    ]);
    return {
      previous_document_id: previousId,
      current_document_id: currentId,
      previous_normalized_content_hash: previous.normalized_content_hash,
      current_normalized_content_hash: current.normalized_content_hash,
      ...compareSections(previousSections, currentSections),
    };
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id", {
    schema: {
      tags: ["Documents"],
      summary: "Get document metadata and extraction status",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      response: { 200: documentStatusSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, document_group_id, version_number, version_label, revision_date::text,
              filename, mime_type, file_size_bytes, content_hash, normalized_content_hash, document_type,
              declared_language, source_type, source_url, retrieved_at, processing_status, extraction_metadata, error_message,
              uploaded_at, processed_at
       FROM documents WHERE id = $1`,
      [request.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: "Document not found." });
    return rows[0];
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/sections", {
    schema: {
      tags: ["Documents"],
      summary: "Get extracted document sections and source locations",
      params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      response: {
        200: {
          type: "object",
          properties: {
            document_id: { type: "string", format: "uuid" },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  parent_section_id: { type: ["string", "null"], format: "uuid" },
                  section_index: { type: "integer" },
                  section_type: { type: "string", enum: SECTION_TYPES },
                  heading: { type: ["string", "null"] },
                  content: { type: "string" },
                  page_start: { type: ["integer", "null"] },
                  page_end: { type: ["integer", "null"] },
                  source_reference: { type: ["string", "null"] },
                  normalized_hash: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const exists = await pool.query("SELECT 1 FROM documents WHERE id = $1", [request.params.id]);
    if (!exists.rowCount) return reply.code(404).send({ error: "Document not found." });

    const { rows } = await pool.query(
      `SELECT id, parent_section_id, section_index, section_type, heading, content,
              page_start, page_end, source_reference, normalized_hash
       FROM document_sections WHERE document_id = $1 ORDER BY section_index`,
      [request.params.id],
    );
    return { document_id: request.params.id, sections: rows };
  });
}
