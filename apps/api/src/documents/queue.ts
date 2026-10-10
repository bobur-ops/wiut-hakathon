import { PgBoss } from "pg-boss";

export const DOCUMENT_QUEUE = "document-extraction";
export const VERSION_IMPORT_QUEUE = "document-version-import";
export const ASSESSMENT_QUEUE = "compliance-assessment";

export function createJobQueue() {
  return new PgBoss(
    process.env.DATABASE_URL ??
      "postgres://regcheck:change-me@localhost:5432/regcheck",
  );
}
