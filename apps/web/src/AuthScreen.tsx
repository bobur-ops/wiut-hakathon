import { useState } from "react";
import { Alert, Button, Form, Input, Select, Typography } from "antd";
import { api, jsonBody, type Identity } from "./api";

export const organizationTypes = [
  { value: "commercial_bank", label: "Commercial bank" },
  { value: "payment_organization", label: "Payment organization" },
  { value: "electronic_money_provider", label: "Electronic-money provider" },
  { value: "other_fintech", label: "Other fintech" },
];

export default function AuthScreen({ onSignedIn }: { onSignedIn: (identity: Identity) => void }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(values: { email: string; password: string; name?: string; organization_type?: string }) {
    setBusy(true); setError("");
    try {
      const result = await api<{ identity: Identity }>(`/api/auth/${register ? "register" : "login"}`, jsonBody(values));
      onSignedIn(result.identity);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }
  return <div className="auth-page">
    <section className="auth-story"><a className="brand" href="#"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M8 23V9l16 14V9" /></svg></span><span className="brand-name">normiq</span></a>
      <div><span className="eyebrow">REGULATORY INTELLIGENCE WORKSPACE</span><h1>Keep policy<br />and regulation<br /><em>connected.</em></h1><p>A dedicated workspace for your compliance team. Evidence-backed assessments, accountable review, and a structured regulatory library.</p></div>
      <small>Hackathon prototype · Synthetic organization data only</small>
    </section>
    <section className="auth-form"><div className="auth-form-inner"><Typography.Title level={2}>{register ? "Create your workspace" : "Welcome back"}</Typography.Title><Typography.Paragraph type="secondary">{register ? "Create an owner account for a fictional organization." : "Sign in to your organization’s workspace."}</Typography.Paragraph>
      <Alert type="info" showIcon message="Use fictional organization details and a unique demo password. Do not upload confidential documents." />
      {error && <Alert type="error" showIcon message={error} />}
      <Form key={String(register)} layout="vertical" onFinish={submit} initialValues={{ organization_type: "commercial_bank" }}>
        {register && <><Form.Item name="name" label="Organization name" rules={[{ required: true, min: 2 }]}><Input maxLength={200} placeholder="Demo Bank UZ" /></Form.Item><Form.Item name="organization_type" label="Organization type" rules={[{ required: true }]}><Select options={organizationTypes} /></Form.Item></>}
        <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}><Input autoComplete="username" placeholder="reviewer@example.com" maxLength={254} /></Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true, min: 6, max: 128 }]}><Input.Password autoComplete={register ? "new-password" : "current-password"} placeholder="At least 6 characters" maxLength={128} /></Form.Item>
        <Button type="primary" htmlType="submit" block size="large" loading={busy}>{register ? "Create workspace" : "Sign in"}</Button>
      </Form>
      <Button type="link" block onClick={() => { setRegister(!register); setError(""); }}>{register ? "Already have an account? Sign in" : "New here? Create a workspace"}</Button>
    </div></section>
  </div>;
}
