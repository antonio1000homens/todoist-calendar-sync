import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Case = { id:string; profile:string; title:string; reason:string; status:string; taskId?:string; eventId?:string; createdAt:string };
type ProviderObject = { id:string; content?:string; summary?:string; description?:string; url?:string; htmlLink?:string; due?:{date?:string;datetime?:string;string?:string;is_recurring?:boolean}; start?:{date?:string;dateTime?:string}; end?:{date?:string;dateTime?:string}; recurrence?:string[]; recurringEventId?:string };
const profiles = ["home","antonio","work"];
const api = async (path:string, init?:RequestInit) => {
  const response = await fetch("/review/api/" + path, { ...init, headers:{ "content-type":"application/json", ...(init?.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};
function App() {
  const [cases,setCases] = useState<Case[]>([]), [selected,setSelected] = useState<Case>(), [details,setDetails] = useState<any>(), [profile,setProfile] = useState("home"), [history,setHistory] = useState(false);
  const [message,setMessage] = useState("");
  const refresh = async () => { const data = await api(`cases?profile=${profile}&history=${history}`); setCases(data.items); };
  useEffect(() => {
    const caseId = new URLSearchParams(location.search).get("case");
    if (!caseId) return;
    api(`cases/${encodeURIComponent(caseId)}`).then(data=>{ setProfile(data.item.profile); setSelected(data.item); setDetails(data); })
      .catch(e=>setMessage(e.message));
  },[]);
  useEffect(() => { refresh().catch(e=>setMessage(e.message)); },[profile,history]);
  useEffect(() => {
    if (!selected) return;
    api(`cases/${encodeURIComponent(selected.id)}`).then(data=>{ setDetails(data); }).catch(e=>setMessage(e.message));
  },[selected]);
  const snapshot=(sideName:string) => details?.snapshots?.find((s:any)=>s.ref.side===sideName)?.object;
  const providerLink=(item:ProviderObject|undefined) => {
    const href=item?.url||item?.htmlLink;
    if (!href) return undefined;
    try { const parsed=new URL(href); return ["https:","http:"].includes(parsed.protocol)?parsed.href:undefined; } catch { return undefined; }
  };
  const displaySnapshot=(sideName:"todoist"|"calendar") => {
    const current=details?.snapshots?.find((s:any)=>s.ref.side===sideName), item=current?.object as ProviderObject|undefined;
    if (!item) return <p>No live {sideName} item was found.</p>;
    const start=sideName==="todoist"?(item.due?.datetime||item.due?.date):(item.start?.dateTime||item.start?.date);
    const end=sideName==="calendar"?(item.end?.dateTime||item.end?.date):undefined;
    const recurrence=sideName==="todoist"?(item.due?.is_recurring?item.due.string||"Recurring":"None"):(item.recurrence?.join(" · ")||(item.recurringEventId?"Part of a recurring series":"None"));
    const href=providerLink(item);
    return <><h4>{item.content||item.summary||item.id}</h4>{href&&<p><a href={href} target="_blank" rel="noreferrer">Open in {sideName==="todoist"?"Todoist":"Google Calendar"}</a></p>}<dl><dt>Date</dt><dd>{start||"Not set"}{end?` → ${end}`:""}</dd><dt>Description</dt><dd>{item.description||"None"}</dd><dt>Recurrence</dt><dd>{recurrence}</dd><dt>Existing counterpart</dt><dd>{current.mapping?`${current.mapping.taskId} ↔ ${current.mapping.eventId}`:"No mapping recorded"}</dd></dl><small>Checked {current.checkedAt?new Date(current.checkedAt).toLocaleString():"just now"}</small><details><summary>Provider details</summary><pre>{JSON.stringify(item,null,2)}</pre></details></>;
  };
  const originalMapping=details?.item?.decision?.mappingSnapshot;
  const liveMapping=details?.snapshots?.find((s:any)=>s.mapping)?.mapping;
  const mappingChanges=originalMapping&&liveMapping?["taskId","eventId","masterEventId","activeInstanceId","seriesId","recurrenceOwner"].filter(key=>originalMapping[key]!==liveMapping[key]):[];
  return <main>
    <header><div><h1>Calendar sync review</h1><p>Review conflicts using current Todoist and Calendar data.</p></div>
      <label>Inbox <select value={profile} onChange={e=>{setProfile(e.target.value);setSelected(undefined);}}>{profiles.map(p=><option key={p}>{p}</option>)}</select></label>
    </header>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="layout"><nav aria-label="Conflicts"><h2>Conflicts</h2><label className="history-toggle"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)} /> Show dismissed and resolved cases</label>{cases.map(item=><button className={`case ${selected?.id===item.id?"active":""}`} key={item.id} onClick={()=>setSelected(item)}><strong>{item.title}</strong><span>{item.profile} · {item.status}</span><small>{item.reason}</small></button>)}{cases.length===0&&<p>{history?"No conflict history.":"No open conflicts."}</p>}</nav>
      <section className="detail">{!selected?<p>Select a conflict to inspect its live provider data.</p>:<>
        <div className="title"><div><h2>{selected.title}</h2><p>{selected.reason} · opened {new Date(selected.createdAt).toLocaleString()}</p></div></div>
        <div className="columns"><article><h3>Todoist</h3>{displaySnapshot("todoist")}</article><article><h3>Calendar</h3>{displaySnapshot("calendar")}</article></div>
        <p className="change-summary">{originalMapping?mappingChanges.length?`Association changed since the alert: ${mappingChanges.join(", ")}.`:"Association matches the alert snapshot.":"The original alert did not capture an association snapshot; compare the live provider details above."}</p>
        <p className="notice">This public MVP is read-only. Use the existing sync controls to run reconciliation or make changes.</p>
      </>}</section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
