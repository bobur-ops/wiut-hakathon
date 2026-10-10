import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Checkbox, Collapse, Empty, Input, Popconfirm, Progress, Space, Spin, Table, Tag, Typography } from "antd";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, jsonBody } from "./api";
import { findingLabels, type AssessmentPayload, type Finding } from "./assessment-types";

interface Policy { id: string; filename: string; version_label: string | null; document_group_id: string; processing_status: string }
interface Corpus { documents: { id: string; title: string; version_label: string; source_reviewed: boolean }[]; excluded_sources?: { id: string; title: string }[]; limitations: string[];
  cached_snapshots?: number; cached_obligations?: number; comparison_model?: string; batch_size?: number; budget_usd?: number }

export default function AssessmentWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("filter") ?? "attention";
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [corpus, setCorpus] = useState<Corpus | null>(null);
  const [result, setResult] = useState<AssessmentPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    setLoading(true); setError(""); setResult(null);
    if (id) {
      const poll = async () => {
        try {
          const response = await api<AssessmentPayload>(`/api/assessments/${id}`);
          if (!active) return;
          setResult(response); setLoading(false);
          if (!["COMPLETED", "FAILED", "CANCELLED"].includes(response.assessment.status)) timer = window.setTimeout(poll, 2500);
        } catch (reason) { if (active) { setError(reason instanceof Error ? reason.message : "Could not load assessment."); setLoading(false); } }
      };
      void poll();
    } else {
      Promise.all([api<{ documents: Policy[] }>("/api/documents?document_type=policy&limit=100"), api<Corpus>("/api/assessment-corpus")])
        .then(([documents, baseline]) => {
          if (!active) return;
          setPolicies(documents.documents); setCorpus(baseline);
          const groups = new Set<string>();
          const latest = documents.documents.filter((document) => {
            if (!["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(document.processing_status) || groups.has(document.document_group_id)) return false;
            groups.add(document.document_group_id); return true;
          });
          setSelected(latest.slice(0, 5).map((document) => document.id));
        }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Could not load policies and regulations."); })
        .finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [id]);

  async function start() {
    setStarting(true); setError("");
    try {
      const response = await api<{ assessment_id: string }>("/api/assessments", jsonBody({ policy_document_ids: selected }));
      navigate(`/assessments/${response.assessment_id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not queue assessment."); }
    finally { setStarting(false); }
  }
  const obligations = useMemo(() => new Map(result?.assessment.obligations.map((obligation) => [obligation.id, obligation]) ?? []), [result]);
  const findings = [...result?.findings ?? []].sort((a, b) => (findingLabels[a.classification]?.priority ?? 5) - (findingLabels[b.classification]?.priority ?? 5));
  const counts = Object.fromEntries(Object.keys(findingLabels).map((key) => [key, findings.filter((finding) => finding.classification === key).length]));
  const visible = findings.filter((finding) => {
    const matches = filter === "all" || (filter === "attention" ? ["POTENTIAL_CONFLICT", "MISSING_EVIDENCE", "REQUIRES_REVIEW"].includes(finding.classification) : finding.classification === filter);
    const text = `${finding.title} ${finding.explanation} ${obligations.get(finding.obligation_id)?.citation ?? ""}`.toLowerCase();
    return matches && text.includes(query.toLowerCase());
  });
  if (loading) return <Card><Spin /><Typography.Text> Loading assessment workspace…</Typography.Text></Card>;
  if (!id) return <Card className="start-assessment-card" title="Check policies against the regulatory corpus">
    {error && <Alert type="error" showIcon message={error} />}
    <Typography.Paragraph>Select policy snapshots and start the check. The system reads the selected regulation snapshots, extracts draft requirements, and checks policy evidence. No prompts or requirements to type.</Typography.Paragraph>
    <div className="assessment-start-grid"><section><Typography.Title level={4}>Internal policies</Typography.Title><Checkbox.Group className="document-list" value={selected} onChange={(values) => setSelected(values as string[])}>{policies.map((policy) => <Checkbox key={policy.id} value={policy.id} disabled={!["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(policy.processing_status) || (selected.length >= 5 && !selected.includes(policy.id))} className="document-choice"><span className="document-meta"><b>{policy.filename}</b><small>{policy.version_label} · {policy.processing_status.replaceAll("_", " ")}</small></span></Checkbox>)}</Checkbox.Group>{!policies.length && <Empty description="Upload an internal policy first"><Link to="/policies">Go to policies</Link></Empty>}<small className="selection-note">Latest ready policy versions are preselected · up to 5 snapshots per run</small></section><section className="corpus-preview"><span className="eyebrow">REGULATORY SCOPE</span><strong>{corpus?.documents.length ?? 0} regulation snapshots</strong><p>One selected snapshot per imported regulation group. Source-reviewed updates take precedence; pending updates and historical revisions are not automatically used.</p><Collapse ghost items={[{ key: "sources", label: "View included regulations", children: <ul>{corpus?.documents.map((document) => <li key={document.id}>{document.title}<small>{document.version_label} · {document.source_reviewed ? "Source reviewed; obligations remain draft" : "Observed snapshot — legal dates unverified"}</small></li>)}</ul> }]} /></section></div>
    <Alert type="warning" showIcon message="AI-extracted requirements need legal review" description="The first run can take several minutes while the full selected corpus is processed. Later runs reuse cached obligations. This does not guarantee every duty was identified or establish legal compliance." />
    {!!corpus?.excluded_sources?.length && <Alert type="warning" showIcon message={`${corpus.excluded_sources.length} regulatory sources are not ready for assessment`} description={corpus.excluded_sources.map((source) => source.title).join("; ")} />}
    <Alert type="info" showIcon message="Batched, incremental assessment" description={`${corpus?.comparison_model ?? "Configured model"} · up to ${corpus?.batch_size ?? 8} requirements per comparison request · ${corpus?.cached_snapshots ?? 0} snapshots / ${corpus?.cached_obligations ?? 0} draft requirements cached · $${corpus?.budget_usd ?? 2} budget guard. Unchanged findings are reused; reported token usage and estimated spend appear during processing.`} />
    <Button type="primary" size="large" loading={starting} disabled={!selected.length || !corpus?.documents.length} onClick={() => void start()}>Assess {selected.length} {selected.length === 1 ? "policy" : "policies"} against the corpus</Button>
  </Card>;
  if (!result) return <Alert type="error" showIcon message={error || "Assessment could not be loaded"} />;
  const assessment = result.assessment;
  const progress = assessment.progress ?? {};
  const running = !["COMPLETED", "FAILED", "CANCELLED"].includes(assessment.status);
  const total = assessment.processing_stage === "EXTRACTING_OBLIGATIONS" ? progress.regulations_total : progress.obligations_total;
  const done = assessment.processing_stage === "EXTRACTING_OBLIGATIONS" ? progress.regulations_completed : progress.obligations_completed;
  return <>
    <div className="assessment-result-toolbar"><Link to="/assessments">← All assessments</Link><Space><Tag color={assessment.status === "FAILED" ? "red" : assessment.status === "CANCELLED" ? "default" : running ? "blue" : "green"}>{assessment.status}</Tag>{running && <Popconfirm title="Cancel this assessment?" description="Saved findings are preserved. In-flight requests may already be billed." onConfirm={async () => {
      try { await api(`/api/assessments/${id}/cancel`, jsonBody({})); setResult(await api<AssessmentPayload>(`/api/assessments/${id}`)); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Could not cancel"); }
    }}><Button danger>Cancel assessment</Button></Popconfirm>}</Space></div>
    {assessment.status === "CANCELLED" && <Alert type="info" showIcon message="Assessment cancelled" description="Partial findings are preserved and are not complete coverage." />}
    {assessment.baseline_assessment_id && assessment.status === "COMPLETED" && <Alert type="info" message="Incremental assessment" description={`${assessment.change_summary?.new ?? 0} new · ${assessment.change_summary?.changed ?? 0} changed · ${assessment.change_summary?.resolved ?? 0} resolved documentary gaps · ${assessment.change_summary?.unchanged ?? 0} reused. ${assessment.change_summary?.removed_from_scope ?? 0} earlier findings are no longer in this run's scope; removal does not establish legal resolution.`} />}
    {running && progress.estimated_comparison_cost_usd != null && <Alert type="info" message={`Rough comparison estimate: $${progress.estimated_comparison_cost_usd.toFixed(4)}`} description="Based on prepared input size and an assumed 300 output tokens per requirement. Excludes retries and uncached regulatory extraction; actual cost may differ." />}
    <Card size="small"><Space wrap><Tag>{assessment.comparison_model ?? "Configured model"}</Tag><span>{result.usage?.requests ?? 0} API attempts</span><span>Estimated API cost: {result.usage?.estimated_cost_usd == null ? "not available yet" : `$${result.usage.estimated_cost_usd.toFixed(4)}`}</span><span>Budget guard: ${result.budget_usd ?? 2}</span><span>{progress.reused_findings ?? 0} findings reused</span>{progress.comparison_batches_total != null && <span>{progress.comparison_batches_completed ?? 0}/{progress.comparison_batches_total} comparison batches</span>}</Space><Typography.Paragraph type="secondary">Cost is estimated from reported tokens, not an invoice. Unreported requests and in-flight calls may add charges. Budget enforcement is a guard, not a provider-side spending cap.</Typography.Paragraph></Card>
    {error && <Alert type="error" message={error} />}
    {assessment.status === "FAILED" && <Alert type="error" showIcon message="Assessment incomplete — do not treat partial findings as complete coverage" description={assessment.error_message} />}
    {!!assessment.coverage_warnings?.length && <Alert type="warning" showIcon message="Regulatory coverage gaps" description={<ul>{assessment.coverage_warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
    {running && <Card className="assessment-processing"><Space><Spin /><Typography.Title level={4}>{assessment.processing_stage === "EXTRACTING_OBLIGATIONS" ? "Reading regulatory requirements" : assessment.processing_stage === "COMPARING_POLICIES" ? "Checking policy evidence" : "Waiting for the worker"}</Typography.Title></Space>{total ? <><Progress percent={Math.round((done ?? 0) / total * 100)} status="active" showInfo={false} /><p>{done ?? 0} / {total} {assessment.processing_stage === "EXTRACTING_OBLIGATIONS" ? "regulations processed" : "requirements assessed"}</p></> : <p>Real execution progress will appear when processing starts.</p>}{progress.current_regulation && <small>{progress.current_regulation}{progress.batches_total ? ` · batch ${progress.batches_completed ?? 0}/${progress.batches_total}` : ""}</small>}</Card>}
    {!running && assessment.status === "COMPLETED" && <Alert type={counts.POTENTIAL_CONFLICT ? "error" : counts.MISSING_EVIDENCE || counts.REQUIRES_REVIEW ? "warning" : "success"} showIcon message={counts.POTENTIAL_CONFLICT ? `${counts.POTENTIAL_CONFLICT} potential ${counts.POTENTIAL_CONFLICT === 1 ? "conflict needs" : "conflicts need"} attention` : counts.MISSING_EVIDENCE || counts.REQUIRES_REVIEW ? "Policy evidence needs your attention" : "No potential conflicts or missing evidence identified in this run"} description={`${findings.length} requirements assessed across ${assessment.corpus_document_ids?.length ?? 0} snapshots. These are documentary AI findings, not a certification.`} />}
    <div className="finding-summary-grid">{Object.entries(findingLabels).map(([key, label]) => <button type="button" className={`finding-summary ${label.color} ${filter === key ? "selected" : ""}`} key={key} onClick={() => setSearchParams({ filter: key })}><strong>{counts[key]}</strong><span>{label.label}</span></button>)}</div>
    <Card title="Findings" extra={<Space><Button type={filter === "attention" ? "primary" : "default"} onClick={() => setSearchParams({ filter: "attention" })}>Needs attention</Button><Button onClick={() => setSearchParams({ filter: "all" })}>All findings</Button></Space>}>
      <Input.Search placeholder="Search findings or regulations" value={query} onChange={(event) => setQuery(event.target.value)} allowClear className="findings-search" />
      <Table<Finding> rowKey="id" dataSource={visible} pagination={{ pageSize: 12 }} scroll={{ x: 750 }} rowClassName={(finding) => `finding-row ${finding.classification.toLowerCase()}`} locale={{ emptyText: <Empty description={running ? "Findings will appear as requirements are checked" : "No findings match this view"} /> }} columns={[
        { title: "Finding", render: (_, finding) => <Link to={`/findings/${finding.id}`} className="finding-link"><strong>{finding.title || obligations.get(finding.obligation_id)?.title || "Policy requirement"}</strong><small>{obligations.get(finding.obligation_id)?.regulation_evidence?.[0]?.title ?? obligations.get(finding.obligation_id)?.citation}</small></Link> },
        { title: "Result", width: 190, render: (_, finding) => <Tag color={findingLabels[finding.classification]?.color}>{findingLabels[finding.classification]?.label ?? finding.classification}</Tag> },
        { title: "Policy evidence", render: (_, finding) => finding.evidence.length ? finding.evidence.map((evidence) => evidence.filename).filter((value, index, all) => all.indexOf(value) === index).join(", ") : <span className="missing-policy-label">No cited policy passage</span> },
        { title: "Review", dataIndex: "review_status", render: (status: string) => <Tag>{status === "PENDING" ? "Awaiting review" : status.replaceAll("_", " ")}</Tag> },
        { title: "Change", dataIndex: "change_status", render: (status?: string) => <Tag>{status ?? "NEW"}</Tag> },
        { title: "", width: 90, render: (_, finding) => <Link to={`/findings/${finding.id}`}>Inspect →</Link> },
      ]} />
    </Card>
    <Collapse items={[{ key: "coverage", label: "Coverage, limitations and assessment record", children: <><p>Pipeline: {assessment.pipeline_version} · Model: {assessment.model_identifier ?? "processing"} · ID: {assessment.id}</p><ul>{result.limitations?.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></> }]} />
  </>;
}
