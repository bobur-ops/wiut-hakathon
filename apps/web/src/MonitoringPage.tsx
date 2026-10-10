import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Empty, Input, Space, Switch, Table, Tag, Typography, message } from "antd";
import { api, jsonBody } from "./api";

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
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "Not yet checked";

export default function MonitoringPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [canReviewShared, setCanReviewShared] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Update | null>(null);
  const [history, setHistory] = useState<{ name: string; checks: Check[] } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, holder] = message.useMessage();
  const refresh = useCallback(async () => {
    try {
      const [result, candidates] = await Promise.all([
        api<{ monitor_enabled: boolean; shared_review_allowed: boolean; sources: Source[] }>("/api/regulatory-sources"),
        api<{ updates: Update[] }>("/api/regulatory-updates"),
      ]);
      setSources(result.sources); setEnabled(result.monitor_enabled); setCanReviewShared(result.shared_review_allowed);
      setUpdates(candidates.updates); setError("");
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
  const pending = updates.filter((update) => update.status === "PENDING_REVIEW");
  const failed = sources.filter((source) => source.enabled && source.last_status === "FAILED");
  const stale = sources.filter((source) => source.enabled && (!source.last_successful_check_at || Date.now() - new Date(source.last_successful_check_at).getTime() > source.check_interval_minutes * 2 * 60_000));
  return <>
    {holder}
    <Alert type={enabled ? "info" : "warning"} showIcon message={enabled ? "Scheduled checks configured · source checks run in the background worker" : "Scheduled monitoring is disabled"} description="Only configured imported official URLs are checked. This does not discover every new law. Check timestamps and failures below; configuration alone does not prove a check succeeded." />
    {error && <Alert type="error" showIcon message={error} />}
    <div className="metrics-grid monitoring-metrics"><div className="metric-card"><span>Configured sources</span><strong>{sources.length}</strong><small>Current pages, not historical revisions</small></div><div className="metric-card"><span>Pending updates</span><strong>{pending.length}</strong><small>Among latest 100 candidates</small></div><div className="metric-card"><span>Failed checks</span><strong>{failed.length}</strong><small>Last check failed</small></div><div className="metric-card"><span>Stale / unverified checks</span><strong>{stale.length}</strong><small>No recent successful retrieval</small></div></div>
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
