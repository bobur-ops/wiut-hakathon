import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Empty, Form, Input, Popconfirm, Select, Space, Spin, Table, Tag, Typography, Upload, message } from "antd";
import AuthScreen, { organizationTypes } from "./AuthScreen";
import AssessmentWorkspace from "./AssessmentWorkspace";
import MonitoringPage from "./MonitoringPage";
import { api, jsonBody, setSessionToken, type Identity } from "./api";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import FindingPage from "./FindingPage";
import NotificationSettings from "./NotificationSettings";

type Page = "dashboard" | "policies" | "library" | "assessments" | "updates" | "reviews" | "settings";
const navigation: { key: Page; label: string; icon: string }[] = [
  { key: "dashboard", label: "Overview", icon: "◫" },
  { key: "policies", label: "Internal policies", icon: "▤" },
  { key: "library", label: "Regulatory library", icon: "§" },
  { key: "assessments", label: "Assessments & findings", icon: "◎" },
  { key: "updates", label: "Regulatory updates", icon: "↻" },
  { key: "reviews", label: "Review history", icon: "◷" },
  { key: "settings", label: "Organization settings", icon: "⚙" },
];
const pagePath = (page: Page) => page === "library" ? "/regulations" : `/${page}`;
interface DocumentRecord {
  id: string; filename: string; processing_status: string; version_label: string;
  uploaded_at: string; error_message: string | null; document_group_id: string;
}
interface Group { id: string; title: string; document_type: string; version_count: number }
interface AssessmentRecord { id: string; status: string; created_at: string; finding_count: number; pending_count: number }
interface ReviewRecord { id: string; decision: string; reviewer_identifier: string; comment: string | null; created_at: string; assessment_id: string }
interface Section { id: string; heading: string | null; content: string; source_reference: string | null }
const format = (text: string) => text.replaceAll("_", " ");
const date = (value: string) => new Date(value).toLocaleString();

export default function App() {
  const location = useLocation();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSessionError("");
    setChecking(true);
    api<{ identity: Identity }>("/api/auth/me", { signal: controller.signal })
      .then((result) => { if (active) setIdentity(result.identity); })
      .catch((reason) => {
        if (!active) return;
        if ((reason as {status?:number})?.status === 401) { setIdentity(null); setSessionError(""); }
        else setSessionError(reason instanceof Error ? reason.message : "Could not restore your session.");
      })
      .finally(() => { if (active) setChecking(false); });
    const expire = () => { setIdentity(null); setSessionError(""); };
    window.addEventListener("regcheck-session-expired", expire);
    return () => { active = false; controller.abort(); window.removeEventListener("regcheck-session-expired", expire); };
  }, [restoreAttempt]);
  if (checking) return <div className="session-loading"><Spin size="large" /><span>Opening your workspace…</span></div>;
  if (sessionError && !identity) return <div className="session-loading"><Alert type="warning" showIcon message="Your login is saved, but the workspace could not be reached" description={sessionError} /><Button type="primary" onClick={() => setRestoreAttempt((value) => value + 1)}>Retry connection</Button></div>;
  const from = (location.state as { from?: string } | null)?.from;
  return <Routes>
    <Route path="/login" element={identity ? <Navigate to={from?.startsWith("/") && !from.startsWith("//") && from !== "/login" ? from : "/dashboard"} replace /> : <AuthScreen onSignedIn={setIdentity} />} />
    <Route path="/*" element={identity ? <OrganizationWorkspace key={identity.organization_id} identity={identity} onIdentity={setIdentity} onSignedOut={() => setIdentity(null)} /> : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
  </Routes>;
}

function OrganizationWorkspace({ identity, onIdentity, onSignedOut }: { identity: Identity; onIdentity: (value: Identity) => void; onSignedOut: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const page: Page = location.pathname.startsWith("/findings/") || location.pathname.startsWith("/assessments") ? "assessments" : navigation.find((item) => pagePath(item.key) === location.pathname)?.key ?? "dashboard";
  const navigateTo = (value: Page) => navigate(pagePath(value));
  const [policies, setPolicies] = useState<DocumentRecord[]>([]);
  const [policyTotal, setPolicyTotal] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  const [assessments, setAssessments] = useState<AssessmentRecord[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [updatingGroup, setUpdatingGroup] = useState<string | undefined>();
  const [drawer, setDrawer] = useState<{ title: string; sections?: Section[]; versions?: DocumentRecord[] } | null>(null);
  const [toast, contextHolder] = message.useMessage();
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [documents, library, runs, decisions] = await Promise.all([
        api<{ documents: DocumentRecord[]; total: number }>("/api/documents?document_type=policy&limit=100"),
        api<{ documents: Group[] }>("/api/document-groups"),
        api<{ assessments: AssessmentRecord[] }>("/api/assessments"),
        api<{ reviews: ReviewRecord[] }>("/api/reviews"),
      ]);
      setPolicies(documents.documents); setPolicyTotal(documents.total);
      setGroups(library.documents.filter((group) => ["regulation", "guidance"].includes(group.document_type)));
      setAssessments(runs.assessments); setReviews(decisions.reviews);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load workspace."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [location.pathname, refresh]);
  useEffect(() => {
    if (!policies.some((policy) => ["QUEUED", "PROCESSING"].includes(policy.processing_status))) return;
    const timer = window.setTimeout(() => void refresh(), 2500);
    return () => window.clearTimeout(timer);
  }, [policies, refresh]);

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-out failed; please retry."); return; }
    setSessionToken(null); onSignedOut();
  }
  async function inspectDocument(record: DocumentRecord) {
    try {
      const response = await api<{ sections: Section[] }>(`/api/documents/${record.id}/sections`);
      setDrawer({ title: record.filename, sections: response.sections });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open document."); }
  }
  async function inspectGroup(group: Group) {
    try {
      const response = await api<{ versions: DocumentRecord[] }>(`/api/document-groups/${group.id}/versions`);
      setDrawer({ title: group.title, versions: response.versions });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open regulation."); }
  }
  function openAssessment(id: string) { navigate(`/assessments/${id}`); }
  async function upload(file: File) {
    setUploading(true); setError("");
    try {
      const body = new FormData(); body.append("file", file); body.append("document_type", "policy");
      if (updatingGroup) body.append("document_group_id", updatingGroup);
      await api("/api/documents", { method: "POST", body });
      toast.success("Policy snapshot saved. Extraction is queued."); setUpdatingGroup(undefined); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Upload failed."); }
    finally { setUploading(false); }
    return false;
  }
  const pending = assessments.reduce((sum, assessment) => sum + assessment.pending_count, 0);
  return <div className="workspace-shell">
    {contextHolder}
    <aside className="workspace-sidebar">
      <Link className="brand" to="/dashboard"><span className="brand-mark">R</span> REGCHECK <b>UZ</b></Link>
      <div className="organization-badge"><span className="org-avatar">{identity.name.slice(0, 2).toUpperCase()}</span><div><strong>{identity.name}</strong><small>{format(identity.organization_type)}</small></div></div>
      <span className="nav-caption">WORKSPACE</span>
      <nav aria-label="Workspace navigation">{navigation.map((item) => <NavLink key={item.key} to={pagePath(item.key)} className={() => page === item.key ? "nav-item active" : "nav-item"}><span aria-hidden>{item.icon}</span>{item.label}{item.key === "assessments" && pending > 0 && <b>{pending}</b>}</NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="demo-marker"><span className="pulse" /> Synthetic data only</div><small>Organization-scoped workspace<br />Hackathon MVP</small></div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-header"><span>Workspace <i>/</i> <b>{navigation.find((item) => item.key === page)?.label}</b></span><div><span className="account-email">{identity.email}</span><Button size="small" onClick={() => void logout()}>Sign out</Button></div></header>
      <main className="workspace-body">
        <Alert className="workspace-notice" type="info" showIcon message="Synthetic-data demo. AI findings require qualified human review; this application does not certify compliance." />
        {error && <Alert type="error" showIcon message={error} closable onClose={() => setError("")} />}
        <div className="page-heading"><div><span className="eyebrow">{identity.name}</span><Typography.Title level={2}>{navigation.find((item) => item.key === page)?.label}</Typography.Title></div><Button loading={loading} onClick={() => void refresh()}>Refresh workspace</Button></div>
        <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<>
          <div className="metrics-grid"><Metric label="Policy snapshots" value={policyTotal} note="Your organization’s uploads" /><Metric label="Regulatory documents" value={groups.length} note="Shared imports and your library" /><Metric label="Recent assessments" value={assessments.length} note="Latest 100 assessments" /><Metric label="Pending review" value={pending} note="Across latest 100 assessments" /></div>
          <div className="dashboard-grid"><Card title="Recent assessments" extra={<Button type="link" onClick={() => navigateTo("assessments")}>View all</Button>}><AssessmentTable assessments={assessments.slice(0, 5)} onOpen={openAssessment} /></Card><Card title="Next actions"><div className="next-actions"><Button block onClick={() => navigateTo("policies")}>Upload or update internal policies</Button><Button block onClick={() => navigateTo("library")}>Inspect the regulatory library</Button><Button block onClick={() => navigateTo("updates")}>Review monitored sources</Button><Button type="primary" block onClick={() => navigateTo("assessments")}>Assess policies against the corpus</Button></div><Alert type="info" showIcon message="No prompts required" description="Assessments extract draft requirements from selected current regulation snapshots. Legal interpretation and effective dates still require review." /></Card></div>
        </>} />
        <Route path="/policies" element={<Card title="Internal policy snapshots" extra={<Upload accept=".pdf,.docx,.txt" showUploadList={false} beforeUpload={upload}><Button type="primary" loading={uploading}>Upload policy</Button></Upload>}>
          <Typography.Paragraph type="secondary">PDF, DOCX, or TXT · Maximum 5 MB · New versions retain earlier snapshots.</Typography.Paragraph>
          {updatingGroup && <Alert type="info" closable onClose={() => setUpdatingGroup(undefined)} message="Version update selected. The next upload will join this policy’s existing document group." />}
          <Table<DocumentRecord> rowKey="id" dataSource={policies} loading={loading} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} columns={[
            { title: "Policy", dataIndex: "filename" }, { title: "Version", dataIndex: "version_label" },
            { title: "Status", dataIndex: "processing_status", render: (status: string, record) => <span><Tag color={status === "COMPLETED" ? "green" : status === "FAILED" || status === "UNSUPPORTED" ? "red" : "blue"}>{format(status)}</Tag>{record.error_message && <small className="document-error">{record.error_message}</small>}</span> },
            { title: "Uploaded", dataIndex: "uploaded_at", render: date },
            { title: "Actions", render: (_, record) => <Space><Button size="small" onClick={() => void inspectDocument(record)}>View text</Button><Button size="small" onClick={() => setUpdatingGroup(record.document_group_id)}>Update version</Button></Space> },
          ]} />
          <Typography.Text type="secondary">Showing the latest {policies.length} of {policyTotal} snapshots. Earlier unassigned demo policies are not visible; upload them into your own workspace.</Typography.Text>
        </Card>} />
        <Route path="/regulations" element={<Card title="Imported regulatory documents"><Alert type="warning" showIcon message="Imported does not mean legally verified" description="These snapshots retain source/version information. Effective dates and obligations still need review before being used as an authoritative assessment baseline." /><Table<Group> rowKey="id" dataSource={groups} loading={loading} pagination={{ pageSize: 12 }} columns={[
          { title: "Regulation", dataIndex: "title" }, { title: "Snapshots", dataIndex: "version_count", width: 110 }, { title: "Status", render: () => <Tag color="gold">Metadata review needed</Tag> },
          { title: "", render: (_, record) => <Button onClick={() => void inspectGroup(record)}>Open versions</Button> },
        ]} /></Card>} />
        <Route path="/assessments" element={<><AssessmentWorkspace /><Card title="Assessment history"><AssessmentTable assessments={assessments} onOpen={openAssessment} /></Card></>} />
        <Route path="/assessments/:id" element={<AssessmentWorkspace />} />
        <Route path="/findings/:id" element={<FindingPage />} />
        <Route path="/updates" element={<MonitoringPage />} />
        <Route path="/reviews" element={<Card title="Saved human decisions"><Table<ReviewRecord> rowKey="id" dataSource={reviews} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} columns={[
          { title: "Decision", dataIndex: "decision", render: (value: string) => <Tag>{format(value)}</Tag> }, { title: "Reviewer", dataIndex: "reviewer_identifier" }, { title: "Note", dataIndex: "comment" }, { title: "Time", dataIndex: "created_at", render: date },
          { title: "", render: (_, record) => <Button size="small" onClick={() => openAssessment(record.assessment_id)}>Open finding</Button> },
        ]} /></Card>} />
         <Route path="/settings" element={<><Card title="Organization profile" className="settings-card"><Typography.Paragraph type="secondary">Organization type and activities inform applicability in each assessment.</Typography.Paragraph><Form key={identity.name} layout="vertical" initialValues={{ name: identity.name, organization_type: identity.organization_type, activities: identity.activities }} onFinish={async (values) => {
          try { const result = await api<{ identity: Identity }>("/api/organization", { ...jsonBody(values), method: "PATCH" }); onIdentity(result.identity); toast.success("Organization profile saved."); }
          catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save profile."); }
         }}><Form.Item label="Organization name" name="name" rules={[{ required: true, min: 2 }]}><Input maxLength={200} /></Form.Item><Form.Item label="Organization type" name="organization_type" rules={[{ required: true }]}><Select options={organizationTypes} /></Form.Item><Form.Item label="Business activities" name="activities"><Select mode="tags" tokenSeparators={[","]} placeholder="Payments, retail banking, digital onboarding…" /></Form.Item><Button type="primary" htmlType="submit">Save profile</Button></Form><div className="settings-identity"><strong>Signed in as {identity.email}</strong><small>Organization ID: {identity.organization_id}</small><small>Owner account · Sessions expire after 24 hours</small></div></Card><NotificationSettings/></>} />
        <Route path="*" element={<Card><Empty description="This page does not exist" /><Button onClick={() => navigateTo("dashboard")}>Go to overview</Button></Card>} />
        </Routes>
      </main>
      <footer className="workspace-footer">RegCheck UZ · Recommendations, not legal certification</footer>
    </div>
    <Drawer width={720} title={drawer?.title} open={Boolean(drawer)} onClose={() => setDrawer(null)}>
      {drawer?.versions && <Table<DocumentRecord> rowKey="id" dataSource={drawer.versions} pagination={{ pageSize: 10 }} columns={[{ title: "Version", dataIndex: "version_label" }, { title: "Status", dataIndex: "processing_status" }, { title: "", render: (_, record) => <Button onClick={() => void inspectDocument(record)}>View text</Button> }]} />}
      {drawer?.sections && (drawer.sections.length ? drawer.sections.map((section) => <section className="source-section" key={section.id}><Tag>{section.source_reference ?? "Location unavailable"}</Tag>{section.heading && <h4>{section.heading}</h4>}<p>{section.content}</p></section>) : <Empty description="Extraction has not produced sections yet" />)}
    </Drawer>
  </div>;
}

function Metric({ label, value, note }: { label: string; value: number; note: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}
function AssessmentTable({ assessments, onOpen }: { assessments: AssessmentRecord[]; onOpen: (id: string) => void }) {
  return <Table<AssessmentRecord> rowKey="id" dataSource={assessments} pagination={{ pageSize: 8 }} scroll={{ x: 520 }} columns={[
    { title: "Created", dataIndex: "created_at", render: date }, { title: "Status", dataIndex: "status", render: (status: string) => <Tag color={status === "COMPLETED" ? "green" : status === "FAILED" ? "red" : "blue"}>{status}</Tag> },
    { title: "Findings", dataIndex: "finding_count" }, { title: "Pending", dataIndex: "pending_count" }, { title: "", render: (_, record) => <Space><Button size="small" onClick={() => onOpen(record.id)}>Open</Button>{["QUEUED","PROCESSING"].includes(record.status) && <Popconfirm title="Cancel this assessment?" onConfirm={async () => { try { await api(`/api/assessments/${record.id}/cancel`, jsonBody({})); onOpen(record.id); } catch (error) { void message.error(error instanceof Error ? error.message : "Could not cancel"); } }}><Button danger size="small">Cancel</Button></Popconfirm>}</Space> },
  ]} />;
}
