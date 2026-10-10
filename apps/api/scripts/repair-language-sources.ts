import { randomUUID, createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { pool, migrate } from "../src/db.js";
import { downloadRemoteDocument } from "../src/documents/remote.js";
import { extractDocument, normalizeExtractedText } from "../src/documents/extract.js";
import { allocateVersion } from "../src/documents/versions.js";
import { storeUpload } from "../src/documents/storage.js";
import { comparableSections, textHash } from "../src/monitoring/content.js";

// Explicit, verified Lex.uz language-placeholder repairs; never rewrite snapshots.
const sources = [[6461368, 6461366], [6468758, 6466217], [4790648, 4790646], [4912275, 4912273], [4803931, 4803632]];
try {
  await migrate();
  for (const [placeholderId, originalId] of sources) {
    const oldUrl = `https://lex.uz/docs/${placeholderId}`;
    const originalUrl = `https://lex.uz/docs/${originalId}`;
    const placeholder = await downloadRemoteDocument(oldUrl);
    const $ = cheerio.load(placeholder.contents.toString("utf8"));
    const href = $("#divCont .COMMENT_FOR_WARNING a[href]").first().attr("href");
    if (href !== `/docs/${originalId}`) throw new Error(`Original-language link verification failed: ${oldUrl}`);
    const downloaded = await downloadRemoteDocument(originalUrl);
    const extracted = await extractDocument(downloaded.contents, downloaded.mimeType);
    if (extracted.warnings.length) throw new Error(`Incomplete extraction: ${originalUrl}`);
    const groups = await pool.query(`SELECT DISTINCT g.id, g.organization_id FROM document_groups g JOIN documents d ON d.document_group_id = g.id
      WHERE d.source_url = $1 AND d.document_type = 'regulation'`, [oldUrl]);
    for (const group of groups.rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM document_groups WHERE id = $1 FOR UPDATE", [group.id]);
        const aliasKey = `${group.organization_id ? `org:${group.organization_id}:` : ""}lex:${originalId}:regulation`;
        await client.query(`INSERT INTO document_group_source_aliases (source_key, document_group_id, verified_from_url)
          VALUES ($1,$2,$3) ON CONFLICT (source_key) DO NOTHING`, [aliasKey, group.id, oldUrl]);
        const existing = await client.query(`SELECT id FROM documents WHERE document_group_id = $1 AND source_url = $2
          AND extraction_metadata->>'languagePlaceholderRepair' = 'true' ORDER BY uploaded_at DESC LIMIT 1`, [group.id, originalUrl]);
        let id = existing.rows[0]?.id as string | undefined;
        if (!id) {
          const version = await allocateVersion(client, { organizationId: group.organization_id, documentGroupId: group.id,
            documentType: "regulation", sourceUrl: originalUrl, filename: downloaded.filename, versionLabel: "Original Uzbek text (placeholder recovery)" });
          id = randomUUID();
          const storageKey = `${id}.html`;
          await storeUpload(storageKey, downloaded.contents);
          const normalized = extracted.sections.map(s => normalizeExtractedText(s.content));
          const normalizedHash = createHash("sha256").update(extracted.sections.map((s, i) => [s.sectionType, s.sourceReference ?? "",
            s.parentSectionIndex === null ? "" : extracted.sections[s.parentSectionIndex]?.sourceReference ?? "", normalized[i]].join("\u0000")).join("\n")).digest("hex");
          await client.query(`INSERT INTO documents (id,filename,mime_type,file_size_bytes,storage_key,content_hash,normalized_content_hash,
            document_type,processing_status,document_group_id,version_number,version_label,organization_id,source_type,source_url,
            retrieved_at,processed_at,declared_language,extraction_metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'regulation','COMPLETED',$8,$9,$10,$11,'REMOTE',$12,NOW(),NOW(),'uz',$13::jsonb)`,
          [id, downloaded.filename, downloaded.mimeType, downloaded.contents.length, storageKey,
            createHash("sha256").update(downloaded.contents).digest("hex"), normalizedHash, group.id, version.versionNumber,
            version.versionLabel, group.organization_id, originalUrl, JSON.stringify({ ...extracted.metadata,
              languagePlaceholderRepair: true, placeholderSourceUrl: oldUrl, normalizedContentHash: normalizedHash })]);
          const ids = extracted.sections.map(() => randomUUID());
          for (const [i, section] of extracted.sections.entries()) {
            await client.query(`INSERT INTO document_sections (id,document_id,section_index,parent_section_id,section_type,heading,content,
              normalized_content,normalized_hash,page_start,page_end,source_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [ids[i], id, i, section.parentSectionIndex === null ? null : ids[section.parentSectionIndex], section.sectionType,
              section.heading, section.content, normalized[i], createHash("sha256").update(normalized[i]!).digest("hex"),
              section.pageStart, section.pageEnd, section.sourceReference]);
          }
        }
        // Correct monitoring URL/baseline without asserting approval or legal currency.
        await client.query(`UPDATE regulatory_sources SET source_url=$2,last_document_id=$3,last_text_hash=$4,
          last_status='NEVER_CHECKED',last_error=NULL,next_check_at=NOW()
          WHERE source_url=$1 AND organization_id IS NOT DISTINCT FROM $5::uuid`,
        [oldUrl, originalUrl, id, textHash(comparableSections(extracted.sections)), group.organization_id]);
        await client.query("COMMIT");
        console.log(JSON.stringify({ placeholder: oldUrl, original: originalUrl, document_id: id, sections: extracted.sections.length }));
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
  }
} finally { await pool.end(); }
