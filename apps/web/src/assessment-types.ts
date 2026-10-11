export interface SourceEvidence {
  section_id: string; document_id: string; excerpt: string; source_reference: string | null;
  version_label: string | null; content_hash: string; title?: string; filename?: string;
  source_url?: string | null; page_start?: number | null;
}
export interface Obligation {
  id: string; title?: string; citation: string; requirement: string;
  extraction_status?: string; regulation_evidence?: SourceEvidence[];
}
export interface Finding {
  id: string; assessment_id?: string; title: string; obligation_id: string;
  classification: string; applicability: string; explanation: string; proposed_action: string;
  limitations: string[]; evidence: SourceEvidence[]; review_status: string;
  change_status?: string; reused_from_finding_id?: string | null;
}
export interface AssessmentPayload {
  assessment: {
    id: string; status: string; processing_stage: string; error_message: string | null;
    obligations: Obligation[];
    corpus_document_ids: string[];
    coverage_warnings?: string[];
    baseline_assessment_id?: string | null;
    change_summary?: { new?: number; changed?: number; resolved?: number; unchanged?: number; removed_from_scope?: number };
    progress: { regulations_completed?: number; regulations_failed?: number; regulations_total?: number; current_regulation?: string;
      batches_completed?: number; batches_total?: number; obligations_completed?: number; obligations_total?: number };
  };
  findings: Finding[];
  limitations: string[];
}
export const findingLabels: Record<string, { label: string; color: string; priority: number }> = {
  POTENTIAL_CONFLICT: { label: "Potential conflict", color: "red", priority: 0 },
  MISSING_EVIDENCE: { label: "Missing policy evidence", color: "gold", priority: 1 },
  REQUIRES_REVIEW: { label: "Needs interpretation", color: "blue", priority: 2 },
  SUPPORTED_IN_POLICY: { label: "Supported in policy", color: "green", priority: 3 },
  NOT_APPLICABLE: { label: "Not applicable", color: "default", priority: 4 },
};
