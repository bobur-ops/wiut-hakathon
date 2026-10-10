import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://regcheck:change-me@localhost:5432/regcheck",
});

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72635421)");
    await client.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      normalized_content_hash TEXT,
      document_type TEXT NOT NULL DEFAULT 'policy',
      declared_language TEXT,
      source_type TEXT NOT NULL DEFAULT 'UPLOAD',
      source_url TEXT,
      retrieved_at TIMESTAMPTZ,
      processing_status TEXT NOT NULL,
      extraction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_message TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'UPLOAD';
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS normalized_content_hash TEXT;

    CREATE TABLE IF NOT EXISTS document_sections (
      id UUID PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      parent_section_id UUID REFERENCES document_sections(id) ON DELETE CASCADE,
      section_type TEXT NOT NULL DEFAULT 'PARAGRAPH',
      heading TEXT,
      content TEXT NOT NULL,
      normalized_content TEXT NOT NULL DEFAULT '',
      normalized_hash TEXT,
      page_start INTEGER,
      page_end INTEGER,
      source_reference TEXT,
      UNIQUE (document_id, section_index)
    );

    ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS source_reference TEXT;
    ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS parent_section_id UUID REFERENCES document_sections(id) ON DELETE CASCADE;
    ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS section_type TEXT NOT NULL DEFAULT 'PARAGRAPH';
    ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS normalized_content TEXT NOT NULL DEFAULT '';
    ALTER TABLE document_sections ADD COLUMN IF NOT EXISTS normalized_hash TEXT;

    CREATE INDEX IF NOT EXISTS document_sections_document_idx
      ON document_sections(document_id, section_index);
    CREATE INDEX IF NOT EXISTS documents_status_idx
      ON documents(processing_status, uploaded_at DESC);

    CREATE TABLE IF NOT EXISTS document_groups (
      id UUID PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      document_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_group_id UUID REFERENCES document_groups(id);
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version_number INTEGER;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS version_label TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS revision_date DATE;

    -- Preserve existing snapshot IDs, content, and files. Only add grouping metadata.
    CREATE TEMP TABLE version_backfill ON COMMIT DROP AS
      SELECT id, document_type, filename,
        CASE WHEN source_type = 'REMOTE' AND source_url ~ '^https://(www\\.)?lex\\.uz/(docs|pdffile)/[0-9]+(/)?([?].*)?$'
          THEN 'lex:' || substring(source_url FROM '/(?:docs|pdffile)/([0-9]+)') || ':' || document_type
          ELSE 'snapshot:' || id::text END AS source_key
      FROM documents WHERE document_group_id IS NULL;

    INSERT INTO document_groups (id, source_key, title, document_type)
      SELECT gen_random_uuid(), source_key, MIN(filename), MIN(document_type)
      FROM version_backfill GROUP BY source_key
      ON CONFLICT (source_key) DO NOTHING;
    UPDATE documents AS document SET document_group_id = groups.id
      FROM version_backfill AS backfill JOIN document_groups AS groups USING (source_key)
      WHERE document.id = backfill.id;
    WITH numbered AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY document_group_id ORDER BY uploaded_at, id)::integer AS number
      FROM documents
    ) UPDATE documents SET version_number = numbered.number,
        version_label = COALESCE(version_label, 'Snapshot ' || numbered.number)
      FROM numbered WHERE documents.id = numbered.id AND documents.version_number IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS documents_group_version_idx ON documents(document_group_id, version_number);

    CREATE TABLE IF NOT EXISTS document_import_batches (
      id UUID PRIMARY KEY,
      source_url TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS document_import_items (
      id UUID PRIMARY KEY,
      batch_id UUID NOT NULL REFERENCES document_import_batches(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      revision_date DATE,
      version_label TEXT NOT NULL,
      declared_language TEXT,
      status TEXT NOT NULL,
      document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      UNIQUE (batch_id, source_url)
    );
    ALTER TABLE document_import_items ADD COLUMN IF NOT EXISTS declared_language TEXT;
    CREATE INDEX IF NOT EXISTS document_import_items_batch_idx ON document_import_items(batch_id, created_at);
  `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
