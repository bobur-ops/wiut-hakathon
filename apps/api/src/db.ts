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
    CREATE INDEX IF NOT EXISTS document_sections_search_idx
      ON document_sections USING GIN
      (to_tsvector('simple', COALESCE(heading, '') || ' ' || content));
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

    CREATE TABLE IF NOT EXISTS assessments (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')),
      assessment_date DATE NOT NULL,
      policy_document_ids UUID[] NOT NULL,
      obligations JSONB NOT NULL,
      model_identifier TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS findings (
      id UUID PRIMARY KEY,
      assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      obligation_id TEXT NOT NULL,
      classification TEXT NOT NULL CHECK (classification IN ('SUPPORTED_IN_POLICY', 'POTENTIAL_CONFLICT', 'MISSING_EVIDENCE', 'REQUIRES_REVIEW')),
      applicability TEXT NOT NULL CHECK (applicability IN ('APPLICABLE', 'NOT_APPLICABLE', 'UNCERTAIN')),
      explanation TEXT NOT NULL,
      proposed_action TEXT NOT NULL,
      limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'NEEDS_EVIDENCE')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assessment_id, obligation_id)
    );
    CREATE INDEX IF NOT EXISTS findings_assessment_idx ON findings(assessment_id, created_at);
    CREATE TABLE IF NOT EXISTS finding_reviews (
      id UUID PRIMARY KEY,
      finding_id UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('CONFIRMED', 'REJECTED', 'NEEDS_EVIDENCE')),
      reviewer_identifier TEXT NOT NULL,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      organization_type TEXT NOT NULL,
      activities JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES organizations(id),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    );
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
    ALTER TABLE document_groups ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
    ALTER TABLE document_import_batches ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
    CREATE INDEX IF NOT EXISTS documents_organization_idx ON documents(organization_id, uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS assessments_organization_idx ON assessments(organization_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS regulatory_sources (
      id UUID PRIMARY KEY,
      organization_id UUID REFERENCES organizations(id),
      name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      check_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (check_interval_minutes >= 15),
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ,
      last_successful_check_at TIMESTAMPTZ,
      last_status TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
      last_error TEXT,
      last_text_hash TEXT,
      last_document_id UUID REFERENCES documents(id),
      accepted_document_id UUID REFERENCES documents(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS regulatory_sources_owner_url_idx ON regulatory_sources
      (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), source_url);
    CREATE TABLE IF NOT EXISTS regulatory_source_checks (
      id UUID PRIMARY KEY,
      source_id UUID NOT NULL REFERENCES regulatory_sources(id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      content_hash TEXT,
      text_hash TEXT,
      error_message TEXT,
      document_id UUID REFERENCES documents(id)
    );
    CREATE TABLE IF NOT EXISTS regulatory_update_candidates (
      id UUID PRIMARY KEY,
      source_id UUID NOT NULL REFERENCES regulatory_sources(id),
      check_id UUID NOT NULL REFERENCES regulatory_source_checks(id),
      previous_document_id UUID NOT NULL REFERENCES documents(id),
      new_document_id UUID NOT NULL REFERENCES documents(id),
      comparison JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED')),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewer_identifier TEXT,
      review_note TEXT,
      reviewed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS regulatory_checks_source_idx ON regulatory_source_checks(source_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS regulatory_updates_source_idx ON regulatory_update_candidates(source_id, detected_at DESC);
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS corpus_document_ids UUID[] NOT NULL DEFAULT '{}';
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS organization_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS input_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS processing_stage TEXT NOT NULL DEFAULT 'QUEUED';
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT 'manual-v1';
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS coverage_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
    ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_classification_check;
    ALTER TABLE findings ADD CONSTRAINT findings_classification_check CHECK
      (classification IN ('SUPPORTED_IN_POLICY', 'POTENTIAL_CONFLICT', 'MISSING_EVIDENCE', 'REQUIRES_REVIEW', 'NOT_APPLICABLE'));
    CREATE TABLE IF NOT EXISTS regulatory_obligation_cache (
      document_id UUID NOT NULL REFERENCES documents(id),
      extractor_version TEXT NOT NULL,
      obligations JSONB NOT NULL,
      processed_sections INTEGER NOT NULL,
      extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (document_id, extractor_version)
    );
    CREATE TABLE IF NOT EXISTS regulatory_extraction_attempts (
      id BIGSERIAL PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      extractor_version TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      response JSONB NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS document_group_source_aliases (
      source_key TEXT PRIMARY KEY,
      document_group_id UUID NOT NULL REFERENCES document_groups(id),
      verified_from_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE assessments DROP CONSTRAINT IF EXISTS assessments_status_check;
    ALTER TABLE assessments ADD CONSTRAINT assessments_status_check CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','FAILED','CANCELLED'));
    CREATE UNIQUE INDEX IF NOT EXISTS assessments_one_active_per_org_idx ON assessments(organization_id)
      WHERE organization_id IS NOT NULL AND status IN ('QUEUED','PROCESSING');
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS job_id UUID;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS baseline_assessment_id UUID;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS comparison_model TEXT;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS impact_document_id UUID;
    CREATE UNIQUE INDEX IF NOT EXISTS assessment_impact_event_idx ON assessments(organization_id,impact_document_id) WHERE impact_document_id IS NOT NULL;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS comparison_key TEXT;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS duty_key TEXT;
    ALTER TABLE assessments ADD COLUMN IF NOT EXISTS change_summary JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS change_status TEXT NOT NULL DEFAULT 'NEW';
    ALTER TABLE findings ADD COLUMN IF NOT EXISTS reused_from_finding_id UUID;
    CREATE INDEX IF NOT EXISTS findings_comparison_key_idx ON findings(comparison_key);
    CREATE TABLE IF NOT EXISTS assessment_ai_usage (
      id BIGSERIAL PRIMARY KEY,
      assessment_id UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd NUMERIC,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
