import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export class DocumentVersionError extends Error {}

export type VersionInput = {
  documentGroupId?: string;
  versionLabel?: string;
  revisionDate?: string;
  sourceUrl?: string | null;
  documentType: string;
  filename: string;
};

function lexSourceKey(sourceUrl: string | null | undefined, documentType: string) {
  if (!sourceUrl) return null;
  const url = new URL(sourceUrl);
  if (!["lex.uz", "www.lex.uz"].includes(url.hostname.toLowerCase())) return null;
  const id = url.pathname.match(/^\/(?:docs|pdffile)\/(\d+)\/?$/)?.[1];
  return id ? `lex:${id}:${documentType}` : null;
}

export function revisionFromUrl(sourceUrl?: string | null) {
  if (!sourceUrl) return null;
  const value = new URL(sourceUrl).searchParams.get("ONDATE");
  const match = value?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(date);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

// Must run in the snapshot insert transaction. The group row lock serializes
// numbering for concurrent imports, without imposing legal chronological order.
export async function allocateVersion(client: PoolClient, input: VersionInput) {
  if (input.documentGroupId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.documentGroupId)) {
    throw new DocumentVersionError("document_group_id must be a UUID.");
  }
  if (input.versionLabel !== undefined && (!input.versionLabel.trim() || input.versionLabel.length > 200)) {
    throw new DocumentVersionError("version_label must contain 1 to 200 characters.");
  }
  if (input.revisionDate != null) {
    const parsed = new Date(input.revisionDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.revisionDate) || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== input.revisionDate) {
      throw new DocumentVersionError("revision_date must be a valid YYYY-MM-DD date.");
    }
  }
  const sourceKey = lexSourceKey(input.sourceUrl, input.documentType);
  let groupId = input.documentGroupId;
  if (!groupId) {
    const result = await client.query(
      `INSERT INTO document_groups (id, source_key, title, document_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_key) DO UPDATE SET source_key = EXCLUDED.source_key
       RETURNING id`,
      [randomUUID(), sourceKey ?? `upload:${randomUUID()}`, input.filename, input.documentType],
    );
    groupId = result.rows[0].id;
  }
  const group = await client.query("SELECT * FROM document_groups WHERE id = $1 FOR UPDATE", [groupId]);
  if (!group.rows[0]) throw new DocumentVersionError("Document group not found.");
  if (group.rows[0].document_type !== input.documentType) {
    throw new DocumentVersionError("The version must have the same document type as its document group.");
  }
  if (sourceKey && group.rows[0].source_key !== sourceKey) {
    throw new DocumentVersionError("The Lex.uz URL does not belong to this document group.");
  }
  if (!sourceKey && String(group.rows[0].source_key).startsWith("lex:")) {
    throw new DocumentVersionError("A Lex.uz document group requires a matching Lex.uz URL.");
  }
  const number = await client.query(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS number FROM documents WHERE document_group_id = $1",
    [groupId],
  );
  const versionNumber = Number(number.rows[0].number);
  const revisionDate = input.revisionDate ?? revisionFromUrl(input.sourceUrl);
  return {
    documentGroupId: groupId as string,
    versionNumber,
    versionLabel: input.versionLabel ?? (revisionDate ? `Revision ${revisionDate}` : `Snapshot ${versionNumber}`),
    revisionDate,
  };
}
