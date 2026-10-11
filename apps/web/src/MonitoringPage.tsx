import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Empty, Input, Modal, Space, Switch, Table, Tag, Typography, message } from "antd";
import { api, jsonBody } from "./api";
import { Link } from "react-router-dom";

interface Source {
  id: string; name: string; source_url: string; enabled: boolean; check_interval_minutes: number;
  last_checked_at: string | null; last_successful_check_at: string | null; next_check_at: string;
  last_status: string; last_error: string | null; organization_id: string | null;
}
interface Change { change_type: string; source_reference: string; previous_text?: string; new_text?: string; needs_review?: boolean }
interface Update {
  id: string; name: string; source_url: string; detected_at: string; status: string;
  organization_id: string | null; previous_document_id: string; new_document_id: string;
  comparison: { summary: { added: number; removed: number; modified: number }; changes: Change[] };
  reviewer_identifier: string | null; review_note: string | null;
}
interface Check { id: string; started_at: string; completed_at: string | null; status: string; error_message: string | null }
interface NewAct { id: string; lex_document_id: string; title: string; issuer_text: string | null; published_at: string | null; official_url: string; pdf_url: string | null; discovered_at: string; status: "NEW" | "LIKELY_RELEVANT" | "RELEVANT" | "NOT_RELEVANT" | "QUEUED" | "IMPORTING" | "IMPORTED" | "IMPORT_FAILED"; relevance_reasons: string[]; reviewer_identifier: string | null; review_note: string | null; review_decision: "RELEVANT" | "NOT_RELEVANT" | null; status_note: string | null; impact_assessment_id: string|null; impact_assessment_status: string|null; impact_assessment_stage: string|null; impact_assessment_completed_at: string|null }
interface DiscoveryRun { started_at: string; completed_at: string | null; status: string; scanned_count: number; inserted_count: number; error_message: string | null }
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet checked";
const listingDate = (value: string | null) => {
  const match=value?.slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]),Number(match[2])-1,Number(match[3]),12).toLocaleDateString() : "Not parsed";
};

export default function MonitoringPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [newActs, setNewActs] = useState<NewAct[]>([]);
  const [discoveryRun, setDiscoveryRun] = useState<DiscoveryRun | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [canReviewShared, setCanReviewShared] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Update | null>(null);
  const [history, setHistory] = useState<{ name: string; checks: Check[] } | null>(null);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState<{act:NewAct;decision:"RELEVANT"|"NOT_RELEVANT"}|null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, holder] = message.useMessage();
  const refresh = useCallback(async () => {
    try {
      const [result, candidates, recentActs] = await Promise.all([
        api<{ monitor_enabled: boolean; shared_review_allowed: boolean; sources: Source[] }>("/api/regulatory-sources"),
        api<{ updates: Update[] }>("/api/regulatory-updates"),
        api<{ items: NewAct[]; latest_run: DiscoveryRun | null }>("/api/new-legislation"),
      ]);
      setSources(result.sources); setEnabled(result.monitor_enabled); setCanReviewShared(result.shared_review_allowed);
      setUpdates(candidates.updates); setNewActs(recentActs.items); setDiscoveryRun(recentActs.latest_run); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load monitoring status."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError("");
    try { await action(); toast.success(success); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Monitoring action failed."); }
    finally { setBusy(false); }
  }
  async function review(decision: "APPROVED" | "REJECTED") {
    if (!selected) return;
    const id = selected.id;
    await run(async () => {
      await api(`/api/regulatory-updates/${id}/review`, jsonBody({ decision, note }));
      setSelected(null); setNote("");
    }, "Source review recorded. Prior snapshots remain unchanged.");
  }
  async function reviewNewAct() {
    if (!reviewing || reviewNote.trim().length<5) return;
    const {act,decision}=reviewing;
    await run(async()=>{
      await api(`/api/new-legislation/${act.id}/review`,jsonBody({decision,note:reviewNote.trim()}));
      setReviewing(null);setReviewNote("");
    },decision==="RELEVANT"?"Relevance confirmed. Preliminary impact assessment queued.":"Not-relevant decision saved.");
  }
  const pending = updates.filter((update) => update.status === "PENDING_REVIEW");
  const failed = sources.filter((source) => source.enabled && source.last_status === "FAILED");
  const stale = sources.filter((source) => source.enabled && (!source.last_successful_check_at || Date.now() - new Date(source.last_successful_check_at).getTime() > source.check_interval_minutes * 2 * 60_000));
  return <>
    {holder}
    <Alert type={enabled ? "info" : "warning"} showIcon message={enabled ? "Scheduled checks configured · source checks run in the background worker" : "Scheduled monitoring is disabled"} description="Only configured imported official URLs are checked. This does not discover every new law. Check timestamps and failures below; configuration alone does not prove a check succeeded." />
    {error && <Alert type="error" showIcon message={error} />}
    <div className="metrics-grid monitoring-metrics"><div className="metric-card"><span>Configured sources</span><strong>{sources.length}</strong><small>Current pages, not historical revisions</small></div><div className="metric-card"><span>Pending updates</span><strong>{pending.length}</strong><small>Among latest 100 candidates</small></div><div className="metric-card"><span>Failed checks</span><strong>{failed.length}</strong><small>Last check failed</small></div><div className="metric-card"><span>Stale / unverified checks</span><strong>{stale.length}</strong><small>No recent successful retrieval</small></div></div>
    <Card title="New legislation · Lex.uz" extra={<Space><Button loading={busy} onClick={() => void run(() => api("/api/new-legislation/scan", { method: "POST" }), "Latest Lex.uz publications checked.")}>Check now</Button><a href="https://lex.uz/ru/search/unique" target="_blank" rel="noreferrer">Open Lex.uz listing ↗</a></Space>}>
      <Typography.Paragraph type="secondary">Recent official publications are screened using multilingual fintech-domain keywords matched against your organization type and declared activities. Matches are triage hints—not legal applicability conclusions. Review the official text, effective date, and transition rules before deciding what to do.</Typography.Paragraph>
      {discoveryRun?.status === "FAILED" && <Alert type="error" showIcon message="Latest new-legislation discovery failed" description={`${discoveryRun.error_message ?? "Unknown source error"} · Last attempt ${time(discoveryRun.started_at)}. Existing inbox items are not proof that discovery is current.`} />}
      {discoveryRun?.status === "COMPLETED" && <Typography.Text type="secondary">Last successful scan: {time(discoveryRun.completed_at)} · {discoveryRun.scanned_count} listing items scanned · {discoveryRun.inserted_count} new items discovered</Typography.Text>}
      <Table<NewAct> rowKey="id" dataSource={newActs} loading={loading} pagination={{ pageSize: 8 }} scroll={{ x: 900 }} locale={{ emptyText: <Empty description="No recent acts discovered yet" /> }} columns={[
        { title: "Publication", width: 360, render: (_, act) => <div className="monitor-source"><a href={act.official_url} target="_blank" rel="noreferrer"><strong>{act.title}</strong> ↗</a><small>{act.issuer_text || "Issuer/date not parsed from listing"}</small></div> },
        { title: "Date shown on listing", dataIndex: "published_at", render: (value: string | null, act) => `${listingDate(value)}${/registered|рўйхатдан ўтган|ro['’ʻʼ]?yxatdan o['’ʻʼ]?tgan|рўйхатга олинган/iu.test(act.issuer_text ?? "") ? " · registration date" : ""}` },
        { title: "Triage signals", render: (_, act) => <Space wrap>{(act.relevance_reasons ?? []).length ? act.relevance_reasons.map(reason => <Tag color="blue" key={reason}>{reason.replace("Keyword match: ","")}</Tag>) : <Tag>Needs screening</Tag>}</Space> },
        { title: "Automatic triage", render: (_, act) => <Space direction="vertical"><Tag color={act.status === "IMPORTED" ? "blue" : act.status === "NOT_RELEVANT" ? "default" : act.status === "IMPORT_FAILED" ? "red" : act.status === "NEW" ? "gold" : "green"}>{act.status === "LIKELY_RELEVANT" ? "Likely relevant · waiting" : act.status === "QUEUED" ? "Automatic check queued" : act.status === "IMPORTING" ? "Fetching official text" : act.status.replaceAll("_"," ")}</Tag>{act.status_note && <Typography.Text type="danger">{act.status_note}</Typography.Text>}{act.status === "IMPORTED" && !act.review_decision && <Typography.Text type="secondary">Preliminary check may already be running; review does not undo it.</Typography.Text>}{act.review_decision ? <Tag>Human review: {act.review_decision.replaceAll("_"," ")}</Tag> : <Space><Button size="small" disabled={busy || ["IMPORTING","IMPORT_FAILED"].includes(act.status)} onClick={() => {setReviewing({act,decision:"RELEVANT"});setReviewNote("");}}>Confirm relevance</Button><Button size="small" disabled={busy || ["IMPORTING","IMPORT_FAILED"].includes(act.status)} onClick={() => {setReviewing({act,decision:"NOT_RELEVANT"});setReviewNote("");}}>Not relevant</Button></Space>}{act.status === "IMPORT_FAILED" && <Button size="small" loading={busy} onClick={() => void run(() => api(`/api/new-legislation/${act.id}/retry`,jsonBody({})),"Act retrieval/extraction retry queued.")}>Retry</Button>}{act.status === "IMPORTED" && (act.impact_assessment_id ? <Space><Tag color={act.impact_assessment_status === "COMPLETED" ? "green" : act.impact_assessment_status === "FAILED" ? "red" : "blue"}>Impact {act.impact_assessment_status?.toLowerCase()}</Tag><Link to={`/assessments/${act.impact_assessment_id}`}>{act.impact_assessment_status === "COMPLETED" ? "Open assessment" : act.impact_assessment_status === "FAILED" ? "View assessment failure" : "View assessment progress"}</Link></Space> : <Typography.Text type="secondary">Imported · waiting for an eligible completed baseline to start impact analysis.</Typography.Text>)}</Space> },
      ]} />
      <Alert type="info" showIcon message="Discovery is bounded to the latest 50 entries on Lex.uz’s ‘Новое в законодательстве’ listing per scan; at most 3 automatic imports are queued per scan." description="Triage checks Russian, Uzbek Cyrillic, Uzbek Latin, and English wording. A keyword match automatically fetches and extracts the act, then queues a preliminary policy impact analysis. Acts stay separate from the manually maintained regulatory library; confirming relevance authorizes this impact review only and never adds the act to future regulation baselines. Human review remains required." />
    </Card>
    <Card title="Official source checks" extra={<Space wrap><Button loading={busy} onClick={() => void run(() => api("/api/regulatory-sources/discover", { method: "POST" }), "Imported official URLs discovered.")}>Discover imported URLs</Button><Button onClick={() => void refresh()}>Refresh</Button></Space>}>
      <Table<Source> rowKey="id" dataSource={sources} loading={loading} pagination={{ pageSize: 10 }} scroll={{ x: 1050 }} columns={[
        { title: "Source", width: 290, render: (_, source) => <div className="monitor-source"><strong>{source.name}</strong><a href={source.source_url} target="_blank" rel="noreferrer">Official document ↗</a><small>{source.organization_id ? "Organization source" : "Shared corpus source"}</small></div> },
        { title: "Interval", render: (_, source) => `${source.check_interval_minutes} min` },
        { title: "Last successful check", dataIndex: "last_successful_check_at", render: time },
        { title: "Latest result", render: (_, source) => <div><Tag color={source.last_status === "FAILED" ? "red" : source.last_status === "CHANGED" ? "gold" : source.last_status === "UNCHANGED" ? "green" : "blue"}>{source.last_status}</Tag><small className="document-error">{source.last_error}</small><small>Last attempt: {time(source.last_checked_at)}</small></div> },
        { title: "Enabled", render: (_, source) => <Switch size="small" checked={source.enabled} disabled={busy || (!source.organization_id && !canReviewShared)} onChange={(value) => void run(() => api(`/api/regulatory-sources/${source.id}`, { ...jsonBody({ enabled: value, check_interval_minutes: source.check_interval_minutes }), method: "PATCH" }), value ? "Source enabled." : "Source disabled.")} /> },
        { title: "Actions", render: (_, source) => <Space direction="vertical"><Button size="small" disabled={!source.enabled || !enabled} loading={busy} onClick={() => void run(() => api(`/api/regulatory-sources/${source.id}/check`, { method: "POST" }), "Source check requested (duplicate requests are coalesced).")}>Check now</Button><Button size="small" onClick={async () => { try { const result = await api<{ checks: Check[] }>(`/api/regulatory-sources/${source.id}/checks`); setHistory({ name: source.name, checks: result.checks }); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load check history."); } }}>Check history</Button></Space> },
      ]} />
    </Card>
    <Card title="Detected legal-text updates"><Typography.Paragraph type="secondary">Changes are candidates, not automatically current law. Approval records source review; legal effective dates and policy impact must still be verified.</Typography.Paragraph>
      <Table<Update> rowKey="id" dataSource={updates} pagination={{ pageSize: 10 }} scroll={{ x: 700 }} locale={{ emptyText: <Empty description="No text changes detected yet" /> }} columns={[
        { title: "Regulation", dataIndex: "name" }, { title: "Detected", dataIndex: "detected_at", render: time },
        { title: "Changes", render: (_, update) => <span>+{update.comparison.summary.added} / −{update.comparison.summary.removed} / ~{update.comparison.summary.modified}</span> },
        { title: "Review", dataIndex: "status", render: (value: string) => <Tag color={value === "PENDING_REVIEW" ? "gold" : value === "APPROVED" ? "green" : "default"}>{value}</Tag> },
        { title: "", render: (_, update) => <Button onClick={() => { setSelected(update); setNote(""); }}>View changes</Button> },
      ]} />
    </Card>
    <Modal title={reviewing?.decision === "RELEVANT" ? "Confirm likely relevance" : "Record not relevant"} open={Boolean(reviewing)} onCancel={()=>{setReviewing(null);setReviewNote("");}} onOk={()=>void reviewNewAct()} confirmLoading={busy} okButtonProps={{disabled:reviewNote.trim().length<5}} okText={reviewing?.decision === "RELEVANT" ? "Confirm & analyze" : "Save review"} cancelText="Cancel">
      {reviewing && <><Typography.Paragraph><a href={reviewing.act.official_url} target="_blank" rel="noreferrer">{reviewing.act.title} ↗</a></Typography.Paragraph><Alert type="info" showIcon message={reviewing.decision === "RELEVANT" ? "This confirms relevance for this act’s impact review." : "This records that the act is not relevant to your organization."} description="Acts remain separate from the regulation library. This review does not add the act to future regulatory baselines and is not legal certification."/><Typography.Paragraph style={{marginTop:16}}>{reviewing.decision === "RELEVANT" ? "Why may it affect your organization?" : "Why is it not relevant?"}</Typography.Paragraph><Input.TextArea value={reviewNote} onChange={event=>setReviewNote(event.target.value)} rows={4} maxLength={4000} showCount placeholder="Add a brief reason (at least 5 characters)"/></>}
    </Modal>
    <Drawer width={1000} title={selected?.name} open={Boolean(selected)} onClose={() => setSelected(null)}>
      {selected && <><Alert type="warning" showIcon message="Policy impact assessment is not connected yet" description="These are source-text differences. No internal policy has been automatically changed or declared affected." /><div className="monitor-snapshot-ids"><span>Previous snapshot: <code>{selected.previous_document_id}</code></span><span>New snapshot: <code>{selected.new_document_id}</code></span><a href={selected.source_url} target="_blank" rel="noreferrer">Open official source ↗</a></div>
        {selected.comparison.changes.length === 0 && <Alert type="info" message="The source hash changed, but the section matcher produced no precise difference. Inspect the snapshots manually." />}
        <Table<Change> rowKey={(_, index) => String(index)} dataSource={selected.comparison.changes} pagination={{ pageSize: 8 }} scroll={{ x: 700 }} columns={[
          { title: "Reference", width: 150, render: (_, change) => <div><Tag>{change.change_type}</Tag><small>{change.source_reference}</small>{change.needs_review && <Tag color="gold">Heuristic match</Tag>}</div> },
          { title: "Previous text", width: 350, render: (_, change) => <p className="legal-diff old-text">{change.previous_text ?? "No previous text"}</p> },
          { title: "New text", width: 350, render: (_, change) => <p className="legal-diff new-text">{change.new_text ?? "Removed text"}</p> },
        ]} />
        {selected.status === "PENDING_REVIEW" ? (selected.organization_id || canReviewShared ? <div className="source-review-form"><Typography.Title level={4}>Source review</Typography.Title><Typography.Paragraph type="secondary">Verify the official source, revision, and applicability before accepting. Acceptance preserves the immutable snapshot; it does not certify legal currency.</Typography.Paragraph><Input.TextArea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Record what you verified (at least 10 characters)" maxLength={4000} rows={3} /><Space><Button type="primary" loading={busy} disabled={note.trim().length < 10} onClick={() => void review("APPROVED")}>Accept candidate</Button><Button danger loading={busy} disabled={note.trim().length < 10} onClick={() => void review("REJECTED")}>Reject candidate</Button></Space></div> : <Alert type="info" message="Shared updates need an authorized source reviewer" description="Configure the reviewer's account email in REGULATORY_REVIEWER_EMAILS on the API server." />) : <Alert type="info" message={`${selected.status} by ${selected.reviewer_identifier}`} description={selected.review_note} />}
      </>}
    </Drawer>
    <Drawer width={700} title={`Check history · ${history?.name ?? ""}`} open={Boolean(history)} onClose={() => setHistory(null)}><Table<Check> rowKey="id" dataSource={history?.checks} columns={[{ title: "Started", dataIndex: "started_at", render: time }, { title: "Result", dataIndex: "status" }, { title: "Error", dataIndex: "error_message" }]} /></Drawer>
  </>;
}
