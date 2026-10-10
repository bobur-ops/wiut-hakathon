import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://regcheck:change-me@localhost:5432/regcheck",
});

export async function migrate() {
  await pool.query(`
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
  `);
}
