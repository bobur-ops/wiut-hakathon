import { PgBoss } from "pg-boss";

export const DOCUMENT_QUEUE = "document-extraction";
export const VERSION_IMPORT_QUEUE = "document-version-import";
export const ASSESSMENT_QUEUE = "compliance-assessment";
export const ASSESSMENT_IMPACT_QUEUE = "assessment-document-impact";
export const MONITOR_DISPATCH_QUEUE = "regulatory-monitor-dispatch";
export const MONITOR_CHECK_QUEUE = "regulatory-source-check";
export const LEGISLATION_IMPORT_QUEUE = "new-legislation-import";
export const EMAIL_QUEUE = "organization-email-notifications";

export function createJobQueue() {
  return new PgBoss(
    process.env.DATABASE_URL ??
      "postgres://regcheck:change-me@localhost:5432/regcheck",
  );
}
