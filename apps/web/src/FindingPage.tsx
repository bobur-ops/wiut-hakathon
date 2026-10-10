import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Collapse, Input, Space, Spin, Tag, Typography } from "antd";
import { Link, useParams } from "react-router-dom";
import { api, jsonBody } from "./api";
import { findingLabels, type Finding, type Obligation, type SourceEvidence } from "./assessment-types";

interface FindingPayload {
  finding: Finding & { assessment_status: string };
  obligation: Obligation | null;
  reviews: { decision: string; reviewer_identifier: string; comment: string | null; created_at: string }[];
}
export default function FindingPage() {
  const { id } = useParams();
  const [result, setResult] = useState<FindingPayload | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setResult(await api<FindingPayload>(`/api/findings/${id}`)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load finding."); }
  }, [id]);
  useEffect(() => { setResult(null); void load(); }, [load]);
  async function review(decision: string) {
    setBusy(true);
    try { await api(`/api/findings/${id}/review`, jsonBody({ decision, comment: note })); setNote(""); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save review."); }
    finally { setBusy(false); }
  }
  if (!result) return error ? <Alert type="error" message={error} /> : <Spin />;
  const { finding, obligation, reviews } = result;
  const label = findingLabels[finding.classification];
  return <>
    <Link to={`/assessments/${finding.assessment_id}`}>← Back to assessment</Link>
    {error && <Alert type="error" message={error} />}
    {finding.assessment_status !== "COMPLETED" && <Alert type="warning" message="This assessment is still processing or incomplete. Treat this finding as a partial result." />}
    <div className="finding-detail-heading"><Space wrap><Tag color={label?.color}>{label?.label ?? finding.classification}</Tag><Tag>{finding.review_status === "PENDING" ? "Awaiting human review" : finding.review_status}</Tag></Space><Typography.Title level={2}>{finding.title || obligation?.title || "Policy requirement"}</Typography.Title><Typography.Paragraph>{finding.explanation}</Typography.Paragraph></div>
    <div className="finding-evidence-grid"><Card title="What the regulation requires"><Typography.Paragraph strong>{obligation?.requirement ?? "Regulatory interpretation unavailable for this legacy finding."}</Typography.Paragraph>{obligation?.extraction_status === "AI_DRAFT" && <Tag color="gold">Draft AI interpretation · legal review required</Tag>}{obligation?.regulation_evidence?.map((evidence, index) => <Evidence key={`${evidence.section_id}-${index}`} evidence={evidence} />)}{!obligation?.regulation_evidence?.length && <Alert type="warning" message="No verified regulatory excerpt stored for this legacy finding" />}</Card><Card title="What the internal policy says">{finding.evidence.length ? finding.evidence.map((evidence, index) => <Evidence key={`${evidence.section_id}-${index}`} evidence={evidence} />) : <div className="missing-evidence-state"><strong>No supporting policy passage was cited</strong><p>Check related procedures or add further documentary evidence. This does not establish a legal violation.</p></div>}</Card></div>
    <Card className="suggested-change" title="Suggested policy action"><Typography.Paragraph>{finding.proposed_action}</Typography.Paragraph><Typography.Text type="secondary">Suggestion only. A qualified reviewer decides whether an amendment is needed; no policy is automatically rewritten.</Typography.Text></Card>
    <Card title="Your review"><Input.TextArea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a review note or describe evidence still needed" maxLength={4000} /><Space wrap className="finding-review-actions"><Button type="primary" loading={busy} onClick={() => void review("CONFIRMED")}>Confirm finding</Button><Button loading={busy} onClick={() => void review("NEEDS_EVIDENCE")}>Request more evidence</Button><Button danger loading={busy} onClick={() => void review("REJECTED")}>Reject finding</Button></Space>{reviews.length > 0 && <div className="review-timeline">{reviews.map((review, index) => <div key={index}><Tag>{review.decision}</Tag><strong>{review.reviewer_identifier}</strong><small>{new Date(review.created_at).toLocaleString()}</small><p>{review.comment}</p></div>)}</div>}</Card>
    <Collapse items={[{ key: "limits", label: "Limitations and applicability", children: <><p>Applicability: {finding.applicability}</p><ul>{finding.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></> }]} />
  </>;
}
function Evidence({ evidence }: { evidence: SourceEvidence }) {
  return <blockquote className="detail-evidence"><strong>{evidence.title ?? evidence.filename}</strong><p>{evidence.excerpt}</p><footer>{evidence.version_label ?? "Snapshot"} · {evidence.source_reference ?? "Location unavailable"}{evidence.page_start ? ` · page ${evidence.page_start}` : ""}</footer>{evidence.source_url && <a href={evidence.source_url} target="_blank" rel="noreferrer">Official source ↗</a>}<details><summary>Source integrity details</summary><code>Document: {evidence.document_id}<br />Section: {evidence.section_id}<br />Hash: {evidence.content_hash}</code></details></blockquote>;
}
