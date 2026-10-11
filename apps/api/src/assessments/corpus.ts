import { pool } from "../db.js";

export interface CorpusDocument {
  id: string; title: string; filename: string; content_hash: string;
  source_url: string | null; version_label: string | null; revision_date: string | null;
  source_reviewed: boolean;
  document_group_id?: string;
}

export async function selectAssessmentCorpus(organizationId: string): Promise<CorpusDocument[]> {
  const result = await pool.query<CorpusDocument>(`
    WITH accepted AS (SELECT accepted_document_id AS id FROM regulatory_sources WHERE accepted_document_id IS NOT NULL),
    selected AS (
      SELECT DISTINCT ON (documents.document_group_id) documents.id, documents.document_group_id, groups.title,
        documents.filename, documents.content_hash, documents.source_url, documents.version_label,
        documents.revision_date::text, (accepted.id IS NOT NULL) AS source_reviewed
      FROM documents JOIN document_groups AS groups ON groups.id = documents.document_group_id
      LEFT JOIN accepted ON accepted.id = documents.id
      WHERE documents.document_type = 'regulation'
        AND COALESCE(documents.extraction_metadata->>'discoveryItemId','') = ''
        AND documents.processing_status = 'COMPLETED'
        AND (documents.organization_id = $1 OR documents.organization_id IS NULL)
        AND (accepted.id IS NOT NULL OR (documents.revision_date IS NULL
          AND COALESCE(documents.extraction_metadata->>'monitoringSnapshot', 'false') <> 'true'))
      ORDER BY documents.document_group_id, (accepted.id IS NOT NULL) DESC, documents.uploaded_at DESC, documents.id
    ) SELECT * FROM selected WHERE EXISTS (
      SELECT 1 FROM document_sections WHERE document_id = selected.id
        AND section_type IN ('CHAPTER', 'ARTICLE', 'PARAGRAPH', 'PAGE')
        AND length(btrim(content)) > 0
    ) ORDER BY title, id`, [organizationId]);
  return result.rows;
}

export function scopeAssessmentCorpus(documents: CorpusDocument[], requestedIds?: string[]) {
  if (requestedIds === undefined) return { documents, omitted: 0 };
  if (!requestedIds.length || requestedIds.some(id => !documents.some(document => document.id === id))) {
    throw new Error("Select one or more eligible regulation snapshots from this workspace.");
  }
  const selected = new Set(requestedIds);
  const scoped = documents.filter(document => selected.has(document.id));
  return { documents: scoped, omitted: documents.length - scoped.length };
}

export function selectIncrementalCorpus(documents: CorpusDocument[], baselineSnapshots: Array<{kind?:string;document_group_id?:string}>, affectedDocumentId: string, addNewAct: boolean) {
  const baselineGroups = new Set(baselineSnapshots.filter(snapshot => snapshot.kind === "regulation")
    .map(snapshot => snapshot.document_group_id).filter((id): id is string => Boolean(id)));
  return documents.filter(document => baselineGroups.has(document.document_group_id ?? "")
    || (addNewAct && document.id === affectedDocumentId));
}

export async function excludedCorpusSources(organizationId: string, documents: CorpusDocument[]) {
  const groups = await pool.query<{ id: string; title: string }>(`SELECT DISTINCT groups.id, groups.title
    FROM document_groups AS groups JOIN documents ON documents.document_group_id = groups.id
    WHERE documents.document_type = 'regulation' AND (documents.organization_id = $1 OR documents.organization_id IS NULL)`, [organizationId]);
  const included = new Set(documents.map((document) => document.document_group_id));
  return groups.rows.filter((group) => !included.has(group.id));
}

export const CORPUS_LIMITATIONS = [
  "Covers selected snapshots from the imported regulatory corpus, not every law in Uzbekistan.",
  "AI-extracted obligations are draft interpretations; their applicability and legal effective dates require human verification.",
  "Pending or rejected monitoring snapshots and historical revisions are not automatically selected as the current baseline.",
  "Lexical evidence retrieval can miss translations, synonyms, and wording variations. Missing evidence is not proof of a violation.",
  "Scanning every selected source section does not guarantee that AI extraction identifies every legal obligation.",
  "The assessment date is recorded, but snapshot selection does not reconstruct historical legal applicability or verify effective dates.",
];
