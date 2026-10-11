import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Input, Space, Switch, Table, Tag, Typography, message } from "antd";
import { api, jsonBody } from "./api";

interface Recipient { id:string; email:string; verified_at:string|null; notify_assessments:boolean; notify_alerts:boolean }
interface Delivery { id:string; event_type:string; subject:string; status:string; attempts:number; last_error:string|null; created_at:string; sent_at:string|null }
interface Settings { recipients:Recipient[]; deliveries:Delivery[]; email_configured:boolean }

export default function NotificationSettings(){
  const [data,setData]=useState<Settings>(); const [email,setEmail]=useState(""); const [loading,setLoading]=useState(false); const [busy,setBusy]=useState(false); const [toast,holder]=message.useMessage();
  const load=useCallback(async()=>{setLoading(true);try{setData(await api<Settings>("/api/organization/notifications"));}catch(e){void toast.error(e instanceof Error?e.message:"Could not load notification settings.");}finally{setLoading(false);}},[toast]);
  useEffect(()=>{void load();},[load]);
  async function add(){setBusy(true);try{await api("/api/organization/notification-recipients",jsonBody({email}));setEmail("");void toast.success("Notification recipient added.");await load();}catch(e){void toast.error(e instanceof Error?e.message:"Could not add recipient.");}finally{setBusy(false);}}
  async function mutate(path:string,init:RequestInit,msg:string){setBusy(true);try{await api(path,init);void toast.success(msg);await load();}catch(e){void toast.error(e instanceof Error?e.message:"Could not update notifications.");}finally{setBusy(false);}}
  return <>{holder}<Card title="Email notifications" className="settings-card">
    {!data?.email_configured&&<Alert type="warning" showIcon message="Email delivery is not configured" description="Set RESEND_API_KEY and RESEND_FROM_EMAIL on the API server. You can configure recipients now; delivery will work once Resend is configured."/>}
    <Typography.Paragraph type="secondary">Add team addresses for assessment results and system alerts. For this demo, addresses are activated immediately. Email recipients get summaries and workspace links only; this does not grant workspace access.</Typography.Paragraph>
    <Space.Compact style={{width:"100%",maxWidth:600}}><Input type="email" value={email} onChange={e=>setEmail(e.target.value)} onPressEnter={()=>void add()} placeholder="compliance-team@example.com"/><Button type="primary" loading={busy} disabled={!email.trim()} onClick={()=>void add()}>Add recipient</Button></Space.Compact>
    <Table<Recipient> rowKey="id" loading={loading} dataSource={data?.recipients??[]} pagination={false} scroll={{x:700}} style={{marginTop:20}} columns={[
      {title:"Team email",dataIndex:"email",render:(v:string)=><span>{v} <Tag color="green">Active</Tag></span>},
      {title:"Assessment results",dataIndex:"notify_assessments",render:(v:boolean,r)=><Switch checked={v} disabled={busy} onChange={value=>void mutate(`/api/organization/notification-recipients/${r.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({notify_assessments:value,notify_alerts:r.notify_alerts})},"Preferences saved.")}/>},
      {title:"System alerts",dataIndex:"notify_alerts",render:(v:boolean,r)=><Switch checked={v} disabled={busy} onChange={value=>void mutate(`/api/organization/notification-recipients/${r.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({notify_assessments:r.notify_assessments,notify_alerts:value})},"Preferences saved.")}/>},
      {title:"",render:(_,r)=><Button danger size="small" disabled={busy} onClick={()=>void mutate(`/api/organization/notification-recipients/${r.id}`,{method:"DELETE"},"Recipient removed.")}>Remove</Button>},
    ]}/>
  </Card><Card title="Recent notification deliveries" style={{marginTop:16}}><Table<Delivery> rowKey="id" loading={loading} dataSource={data?.deliveries??[]} pagination={{pageSize:8}} scroll={{x:700}} columns={[
    {title:"Notification",dataIndex:"subject",render:(v:string,r)=><span>{v}<small style={{display:"block"}}>{r.event_type.replaceAll("_"," ")}</small></span>},
    {title:"Status",dataIndex:"status",render:(v:string)=><Tag color={v==="SENT"?"green":v==="FAILED"?"red":"blue"}>{v}</Tag>},
    {title:"Last error",dataIndex:"last_error"},
    {title:"",render:(_,r)=><Button size="small" disabled={busy||r.status==="QUEUED"} onClick={()=>void mutate(`/api/organization/notifications/${r.id}/resend`,jsonBody({}),"Notification resend queued.")}>Resend</Button>},
  ]}/><Typography.Text type="secondary">Delivery history is retained per organization. Failed messages may retry automatically; resending creates another delivery attempt to the same configured address.</Typography.Text></Card></>;
}
