import type { QueryResultRow } from "pg";
import { pool } from "../db.js";

export interface SearchInput {
  organization_id?: string;
  query: string;
  policy_document_ids: string[];
  limit?: number;
}

export interface EvidencePassage {
  section_id: string;
  document_id: string;
  filename: string;
  version_label: string | null;
  content_hash: string;
  heading: string | null;
  content: string;
  source_reference: string | null;
  page_start: number | null;
  page_end: number | null;
  score: number;
}

interface Queryable {
  query<T extends QueryResultRow>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
}

export class EvidenceSearchError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409, message: string) {
    super(message);
  }
}

// Extract only Unicode letters/numbers, so uploaded query text cannot introduce
// tsquery operators. OR matching avoids losing partial evidence for long clauses.
export function buildSearchQuery(text: string): string {
  const tokens = [...new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  return tokens.slice(0, 64).join(" | ");
}

export async function searchPolicyEvidence(input: SearchInput, db: Queryable = pool) {
  const query = buildSearchQuery(input.query);
  if (!query) throw new EvidenceSearchError(400, "Query must contain letters or numbers.");
  const ids = [...new Set(input.policy_document_ids)];
  const documents = await db.query<{ id: string; document_type: string; processing_status: string }>(
    `SELECT id, document_type, processing_status FROM documents WHERE id = ANY($1::uuid[])
      ${input.organization_id ? "AND organization_id = $2" : ""}`, input.organization_id ? [ids, input.organization_id] : [ids],
  );
  if (documents.rows.length !== ids.length) {
    throw new EvidenceSearchError(404, "One or more selected policy documents do not exist.");
  }
  if (documents.rows.some((document) => !["policy", "procedure"].includes(document.document_type))) {
    throw new EvidenceSearchError(400, "Select only policy or procedure documents for evidence search.");
  }
  if (documents.rows.some((document) => !["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(document.processing_status))) {
    throw new EvidenceSearchError(409, "All selected documents must finish extraction before searching.");
  }
  const { rows } = await db.query<EvidencePassage>(`
    SELECT section.id AS section_id, document.id AS document_id,
           document.filename, document.version_label, document.content_hash,
           section.heading, section.content, section.source_reference,
           section.page_start, section.page_end,
           ts_rank_cd(to_tsvector('simple', COALESCE(section.heading, '') || ' ' || section.content),
                      to_tsquery('simple', $2), 32) AS score
    FROM document_sections AS section
    JOIN documents AS document ON document.id = section.document_id
    WHERE document.id = ANY($1::uuid[])
      AND document.document_type IN ('policy', 'procedure')
      AND document.processing_status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
      AND section.section_type NOT IN ('DOCUMENT_METADATA', 'DOCUMENT_TITLE', 'SIGNATURE')
      AND to_tsvector('simple', COALESCE(section.heading, '') || ' ' || section.content)
          @@ to_tsquery('simple', $2)
    ORDER BY score DESC, document.id, section.section_index
    LIMIT $3
  `, [ids, query, input.limit ?? 5]);
  return {
    query: input.query,
    retrieval_method: "postgresql_full_text_simple" as const,
    passages: rows,
    limitations: [
      "Lexical matching only: translations, synonyms, and word inflections may not match.",
      "No matching passage is not proof of a violation; evidence may be outside the selected documents.",
      "Scores indicate retrieval relevance, not confidence in legal correctness.",
    ],
  };
}
