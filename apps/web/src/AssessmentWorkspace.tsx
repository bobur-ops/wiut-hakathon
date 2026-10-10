import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Descriptions, Divider, Input, Layout, message,
  Progress, Space, Spin, Tag, Typography, Upload,
} from "antd";
import type { UploadProps } from "antd";
import { api } from "./api";

type Document = {
  id: string;
  filename: string;
  document_type: string;
  processing_status: string;
  version_label: string | null;
  uploaded_at: string;
};
type Evidence = {
  section_id: string;
  document_id: string;
  filename: string;
  version_label: string | null;
  content_hash: string;
  source_reference: string | null;
  page_start: number | null;
  page_end: number | null;
  excerpt: string;
};
type Finding = {
  id: string;
  obligation_id: string;
  classification: string;
  applicability: string;
  explanation: string;
  proposed_action: string;
  limitations: string[];
  evidence: Evidence[];
  review_status: string;
};
type Assessment = {
  assessment: {
    id: string;
    status: string;
    error_message: string | null;
    model_identifier: string | null;
    obligations: { id: string; citation: string; requirement: string }[];
  };
  findings: Finding[];
};

function classificationColor(value: string) {
  if (value === "SUPPORTED_IN_POLICY") return "green";
  if (value === "POTENTIAL_CONFLICT") return "red";
  if (value === "MISSING_EVIDENCE") return "gold";
  return "blue";
}

function pretty(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

export default function AssessmentWorkspace({ openAssessmentId = "" }: { openAssessmentId?: string }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [assessmentId, setAssessmentId] = useState(openAssessmentId);
  const [obligation, setObligation] = useState("Describe how customer records are retained and made available for review.");
  const [obligationCitation, setObligationCitation] = useState("Synthetic demo obligation — not legal text");
  const [reviewNote, setReviewNote] = useState("");
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyFinding, setBusyFinding] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, contextHolder] = message.useMessage();

  const refreshDocuments = useCallback(async () => {
    setLoadingDocuments(true);
    try {
      const response = await api<{ documents: Document[] }>("/api/documents?document_type=policy&limit=100");
      setDocuments(response.documents);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load policy documents.");
    } finally {
      setLoadingDocuments(false);
    }
  }, []);

  const refreshAssessment = useCallback(async (id: string) => {
    try {
      const result = await api<Assessment>(`/api/assessments/${id}`);
      setAssessment(result);
      if (["COMPLETED", "FAILED"].includes(result.assessment.status)) return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load assessment.");
      return true;
    }
    return false;
  }, []);

  useEffect(() => { void refreshDocuments(); }, [refreshDocuments]);

  useEffect(() => {
    const extracting = documents.some((document) => ["QUEUED", "PROCESSING"].includes(document.processing_status));
    if (!extracting) return;
    const timer = window.setInterval(() => void refreshDocuments(), 2500);
    return () => window.clearInterval(timer);
  }, [documents, refreshDocuments]);

  useEffect(() => {
    if (!assessmentId || ["COMPLETED", "FAILED"].includes(assessment?.assessment.status ?? "")) return;
    let cancelled = false;
    const poll = async () => {
      const finished = await refreshAssessment(assessmentId);
      if (!cancelled && !finished) timer = window.setTimeout(poll, 1800);
    };
    let timer = window.setTimeout(poll, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [assessmentId, assessment?.assessment.status, refreshAssessment]);

  const readyDocuments = useMemo(
    () => documents.filter((document) => ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(document.processing_status)),
    [documents],
  );

  const uploadProps: UploadProps = {
    accept: ".pdf,.docx,.txt",
    maxCount: 1,
    showUploadList: false,
    beforeUpload: async (file) => {
      setUploading(true);
      setError("");
      const form = new FormData();
      form.append("file", file);
      form.append("document_type", "policy");
      try {
        await api("/api/documents", { method: "POST", body: form });
        toast.success("Policy uploaded; extraction is queued.");
        await refreshDocuments();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
      return false;
    },
  };

  async function startAssessment() {
    setStarting(true);
    setError("");
    try {
      const result = await api<{ assessment_id: string }>("/api/assessments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy_document_ids: selected,
          obligations: [{ id: "demo-record-retention", citation: obligationCitation, requirement: obligation }],
        }),
      });
      setAssessment(null);
      setAssessmentId(result.assessment_id);
      toast.success("Assessment queued.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start assessment.");
    } finally {
      setStarting(false);
    }
  }

  async function reviewFinding(findingId: string, decision: "CONFIRMED" | "REJECTED" | "NEEDS_EVIDENCE") {
    setBusyFinding(findingId);
    setError("");
    try {
      await api(`/api/findings/${findingId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, comment: reviewNote || undefined }),
      });
      if (assessmentId) await refreshAssessment(assessmentId);
      toast.success("Review decision saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save review.");
    } finally {
      setBusyFinding(null);
    }
  }

  const status = assessment?.assessment.status;
  const completedCount = assessment?.findings.length ?? 0;
  const expectedCount = assessment?.assessment.obligations.length ?? 1;
  const progress = Math.min(100, Math.round(completedCount / expectedCount * 100));

  return (
    <Layout className="app-layout">
      {contextHolder}
      <main className="assessment-workspace" id="top">
        <div className="hero">
          <div>
            <Typography.Text className="eyebrow">AI-ASSISTED REGULATORY REVIEW</Typography.Text>
            <Typography.Title level={1}>Policy assessment</Typography.Title>
            <Typography.Paragraph className="intro">Compare a policy with a requirement, inspect the source evidence, and record a human decision.</Typography.Paragraph>
          </div>
          <div className="hero-badge"><span className="pulse" /> Synthetic data only</div>
        </div>

        <Alert
          className="safety-alert"
          type="warning"
          showIcon
          message="Comparison preview — selected requirement, not a complete corpus assessment"
          description="The next increment will assess the reviewed regulatory corpus automatically. This screen currently compares a caller-supplied requirement. Findings are suggestions, not legal advice."
        />
        {error && <Alert className="error-alert" type="error" showIcon message={error} closable onClose={() => setError("")} />}

        <div className="workspace-grid">
          <section className="workflow-column">
            <Card className="panel" bordered={false}>
              <div className="step-heading"><span className="step-number">01</span><div><Typography.Title level={4}>Choose policy documents</Typography.Title><Typography.Text type="secondary">Select extracted documents or upload a new policy.</Typography.Text></div></div>
              <Upload {...uploadProps}>
                <Button loading={uploading}>Upload a policy</Button>
              </Upload>
              <Divider />
              {loadingDocuments ? <Spin /> : readyDocuments.length ? (
                <Checkbox.Group value={selected} onChange={(value) => setSelected(value as string[])} className="document-list">
                  {readyDocuments.map((document) => (
                    <Checkbox key={document.id} value={document.id} disabled={selected.length >= 5 && !selected.includes(document.id)} className="document-choice">
                      <span className="document-icon">PDF</span>
                      <span className="document-meta"><b>{document.filename}</b><small>{document.version_label ?? "Policy snapshot"} · {document.processing_status === "COMPLETED_WITH_WARNINGS" ? "Ready with warnings" : "Ready"}</small></span>
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              ) : (
                <div className="empty-docs"><Typography.Text strong>No extracted policies yet</Typography.Text><Typography.Text type="secondary">Upload a synthetic PDF, DOCX, or TXT file. The worker will extract it in the background.</Typography.Text></div>
              )}
              {documents.some((document) => !["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(document.processing_status)) && <Button type="link" onClick={() => void refreshDocuments()}>Refresh extraction status</Button>}
            </Card>

            <Card className="panel" bordered={false}>
              <div className="step-heading"><span className="step-number">02</span><div><Typography.Title level={4}>Assessment requirement</Typography.Title><Typography.Text type="secondary">For this MVP, enter the requirement to assess.</Typography.Text></div></div>
              <label className="field-label" htmlFor="requirement-citation">Citation or source label</label>
              <Input id="requirement-citation" value={obligationCitation} onChange={(event) => setObligationCitation(event.target.value)} maxLength={500} />
              <label className="field-label" htmlFor="requirement-text">Requirement text</label>
              <Input.TextArea id="requirement-text" value={obligation} onChange={(event) => setObligation(event.target.value)} rows={4} maxLength={4000} />
              <div className="requirement-note">Add a reviewed clause or a synthetic test requirement. The app does not verify legal sources yet.</div>
              <Button type="primary" size="large" block className="run-button" disabled={!selected.length || obligation.trim().length < 10 || !obligationCitation.trim()} loading={starting} onClick={() => void startAssessment()}>
                Run assessment <span aria-hidden>→</span>
              </Button>
            </Card>
          </section>

          <section className="results-column">
            {!assessmentId && !assessment ? (
              <div className="results-empty"><div className="empty-art"><span>§</span><i>✓</i><i>↗</i></div><Typography.Title level={3}>Evidence-backed review</Typography.Title><Typography.Paragraph>Assessment results will appear here. Select a processed policy, add a requirement, and run your first assessment.</Typography.Paragraph><div className="empty-steps"><span><b>01</b> Retrieve policy evidence</span><span><b>02</b> Compare with AI</span><span><b>03</b> Review and record</span></div></div>
            ) : !assessment || (status !== "COMPLETED" && status !== "FAILED") ? (
              <Card className="panel processing-panel" bordered={false}>
                <div className="processing-icon"><Spin size="large" /></div>
                <Typography.Title level={3}>Assessment in progress</Typography.Title>
                <Typography.Paragraph type="secondary">Retrieving policy passages and comparing evidence. This can take a short while.</Typography.Paragraph>
                <Progress percent={progress} status="active" showInfo={false} />
                <div className="processing-status"><Tag color="blue">{pretty(status ?? "QUEUED")}</Tag><span>{completedCount} of {expectedCount} findings ready</span></div>
              </Card>
            ) : status === "FAILED" ? (
              <Card className="panel"><Alert type="error" showIcon message="Assessment failed" description={assessment.assessment.error_message ?? "The worker could not complete this assessment."} /></Card>
            ) : (
              <>
                <div className="result-summary"><div><Typography.Text className="eyebrow">ASSESSMENT COMPLETE</Typography.Text><Typography.Title level={3}>Review findings</Typography.Title></div><Tag color="green">{assessment.findings.length} finding{assessment.findings.length === 1 ? "" : "s"}</Tag></div>
                {assessment.assessment.model_identifier && <Typography.Text className="model-note">Analyzed with {assessment.assessment.model_identifier} · AI-generated, human review required</Typography.Text>}
                {assessment.findings.map((finding, index) => {
                  const requirement = assessment.assessment.obligations.find((item) => item.id === finding.obligation_id);
                  return (
                    <Card className="finding-card" bordered={false} key={finding.id}>
                      <div className="finding-title-row"><div className="finding-index">{String(index + 1).padStart(2, "0")}</div><div><Typography.Text className="finding-source">{requirement?.citation}</Typography.Text><Typography.Title level={4}>{requirement?.requirement}</Typography.Title></div></div>
                      <Space wrap className="finding-tags"><Tag color={classificationColor(finding.classification)}>{pretty(finding.classification)}</Tag><Tag>{pretty(finding.applicability)}</Tag><Tag color={finding.review_status === "PENDING" ? "default" : "cyan"}>{pretty(finding.review_status)}</Tag></Space>
                      <Typography.Paragraph className="finding-explanation">{finding.explanation}</Typography.Paragraph>
                      <div className="action-callout"><b>Suggested next step</b><span>{finding.proposed_action}</span></div>
                      {finding.evidence.length > 0 ? <div className="evidence-list"><Typography.Text className="evidence-label">POLICY EVIDENCE</Typography.Text>{finding.evidence.map((evidence, evidenceIndex) => <blockquote key={`${evidence.section_id}-${evidenceIndex}`}><p>“{evidence.excerpt}”</p><footer>{evidence.filename} · {evidence.version_label ?? "snapshot"} · {evidence.source_reference ?? "Location unavailable"}{evidence.page_start ? ` · p. ${evidence.page_start}` : ""}</footer><details><summary>Source integrity details</summary><code>{evidence.content_hash}</code><br /><code>{evidence.section_id}</code></details></blockquote>)}</div> : <Alert className="no-evidence" type="info" showIcon message="No verified policy passage cited" description="This is not proof of a violation. Check other procedures or request more evidence." />}
                      {finding.limitations.length > 0 && <div className="limitations"><b>Limitations</b>{finding.limitations.map((limitation) => <span key={limitation}>• {limitation}</span>)}</div>}
                      {finding.review_status === "PENDING" && <div className="review-box"><Divider /><Typography.Text strong>Human review · recorded under your signed-in account</Typography.Text><div className="review-inputs"><Input aria-label="Review note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Optional note" /></div><Space wrap><Button type="primary" loading={busyFinding === finding.id} onClick={() => void reviewFinding(finding.id, "CONFIRMED")}>Confirm</Button><Button loading={busyFinding === finding.id} onClick={() => void reviewFinding(finding.id, "NEEDS_EVIDENCE")}>Need more evidence</Button><Button danger loading={busyFinding === finding.id} onClick={() => void reviewFinding(finding.id, "REJECTED")}>Reject</Button></Space></div>}
                    </Card>
                  );
                })}
                <Card className="assessment-meta" bordered={false}><Descriptions size="small" column={1} title="Assessment record"><Descriptions.Item label="Assessment ID"><code>{assessment.assessment.id}</code></Descriptions.Item><Descriptions.Item label="Status">{pretty(status!)}</Descriptions.Item><Descriptions.Item label="Model">{assessment.assessment.model_identifier ?? "—"}</Descriptions.Item></Descriptions></Card>
              </>
            )}
          </section>
        </div>
      </main>
    </Layout>
  );
}
