import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { DOCUMENT_QUEUE } from "./queue.js";
import { storeUpload } from "./storage.js";
import { downloadRemoteDocument, RemoteDocumentError } from "./remote.js";
import { compareSections } from "./compare.js";
import type { PgBoss } from "pg-boss";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const errorResponseSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
} as const;
const documentStatusSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    filename: { type: "string" },
    mime_type: { type: "string" },
    file_size_bytes: { type: "integer" },
    content_hash: { type: "string" },
    normalized_content_hash: { type: ["string", "null"] },
    document_type: { type: "string" },
    declared_language: { type: ["string", "null"] },
    source_type: { type: "string", enum: ["UPLOAD", "REMOTE"] },
    source_url: { type: ["string", "null"] },
    retrieved_at: { type: ["string", "null"], format: "date-time" },
    processing_status: {
      type: "string",
      enum: ["QUEUED", "PROCESSING", "COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED", "UNSUPPORTED"],
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
      body: { document_id: string; filename: string; processing_status: "QUEUED"; file_size_bytes: number; content_hash: string };
    }
  | { statusCode: 400 | 413 | 415 | 503; body: { error: string } };

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "Upload failed";
}

export function registerDocumentRoutes(app: FastifyInstance, boss: PgBoss) {
  async function enqueueDocument(input: {
    request: { log: { error: (error: unknown, message: string) => void } };
    contents: Buffer;
    filename: string;
    mimeType: string;
    documentType: string;
    declaredLanguage: string | null;
    sourceType: "UPLOAD" | "REMOTE";
    sourceUrl?: string | null;
  }): Promise<EnqueueResult> {
    const { contents, filename, mimeType, documentType, declaredLanguage, sourceType, sourceUrl } = input;
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
    try {
      filePath = await storeUpload(storageKey, contents);
      await pool.query(
        `INSERT INTO documents
          (id, filename, mime_type, file_size_bytes, storage_key, content_hash,
           document_type, declared_language, source_type, source_url, retrieved_at, processing_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           CASE WHEN $9 = 'REMOTE' THEN NOW() ELSE NULL END, 'QUEUED')`,
        [id, filename, mimeType, contents.length, storageKey, contentHash, documentType, declaredLanguage, sourceType, sourceUrl ?? null],
      );
      await boss.send(DOCUMENT_QUEUE, { documentId: id });
    } catch (error) {
      await pool.query("DELETE FROM documents WHERE id = $1", [id]).catch(() => undefined);
      if (filePath) await unlink(filePath).catch(() => undefined);
      input.request.log.error(error, "Could not queue document extraction");
      return { statusCode: 503, body: { error: "Document could not be queued. Please retry." } };
    }

    return {
      statusCode: 202,
      body: {
        document_id: id,
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
          document_type: { type: "string", default: "policy" },
          declared_language: { type: "string" },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            document_id: { type: "string", format: "uuid" },
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

    try {
      for await (const part of request.parts({
        limits: { files: 1, fields: 5, fileSize: MAX_FILE_SIZE },
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
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.post<{ Body: { url: string; document_type?: string; declared_language?: string } }>("/api/documents/from-url", {
    schema: {
      tags: ["Documents"],
      summary: "Fetch an allowlisted official PDF or Lex.uz page and queue extraction",
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", description: "HTTPS PDF or Lex.uz /docs/{id} page on an allowlisted official domain." },
          document_type: { type: "string", default: "regulation" },
          declared_language: { type: "string" },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            document_id: { type: "string", format: "uuid" },
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
      `SELECT id, filename, mime_type, file_size_bytes, content_hash, normalized_content_hash, document_type,
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
                  section_type: { type: "string" },
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
