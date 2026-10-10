import { PgBoss } from "pg-boss";

export const DOCUMENT_QUEUE = "document-extraction";

export function createJobQueue() {
  return new PgBoss(
    process.env.DATABASE_URL ??
      "postgres://regcheck:change-me@localhost:5432/regcheck",
  );
}
