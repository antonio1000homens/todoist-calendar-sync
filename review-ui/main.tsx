import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Case = { id:string; profile:string; title:string; reason:string; status:string; taskId?:string; eventId?:string; createdAt:string };
type Item = { id:string; title:string; start?:string };
type Preview = { id:string; changes:string[]; warnings:string[]; expiresAt:number };
const profiles = ["home","antonio","work"];
const api = async (path:string, init?:RequestInit) => {
  const response = await fetch("/review/api/" + path, { ...init, headers:{ "content-type":"application/json", ...(init?.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};
function App() {
  const [cases,setCases] = useState<Case[]>([]), [selected,setSelected] = useState<Case>(), [details,setDetails] = useState<any>(), [profile,setProfile] = useState("home");
  const [action,setAction] = useState("link"), [winner,setWinner] = useState("none"), [scope,setScope] = useState("occurrence");
  const [taskId,setTaskId] = useState(""), [eventId,setEventId] = useState(""), [query,setQuery] = useState(""), [side,setSide] = useState("todoist");
  const [results,setResults] = useState<Item[]>([]), [preview,setPreview] = useState<Preview>(), [operation,setOperation] = useState<any>(), [message,setMessage] = useState("");
  const refresh = async () => { const data = await api(`cases?profile=${profile}`); setCases(data.items); };
  useEffect(() => {
    const caseId = new URLSearchParams(location.search).get("case");
    if (!caseId) return;
    api(`cases/${encodeURIComponent(caseId)}`).then(data=>{ setProfile(data.item.profile); setSelected(data.item); setDetails(data); setTaskId(data.item.taskId || ""); setEventId(data.item.eventId || ""); })
      .catch(e=>setMessage(e.message));
  },[]);
  useEffect(() => { refresh().catch(e=>setMessage(e.message)); },[profile]);
  useEffect(() => {
    if (!selected) return;
    api(`cases/${encodeURIComponent(selected.id)}`).then(data=>{ setDetails(data); setTaskId(data.item.taskId || ""); setEventId(data.item.eventId || ""); setPreview(undefined); }).catch(e=>setMessage(e.message));
  },[selected]);
  useEffect(() => { if (!operation || ["succeeded","failed","needs_review"].includes(operation.status)) return;
    const timer=setInterval(()=>api(`operations/${operation.id}`).then(data=>setOperation(data.operation)).catch(e=>setMessage(e.message)),2000); return ()=>clearInterval(timer);
  },[operation]);
  const search = async () => { const data=await api(`search?profile=${profile}&side=${side}&q=${encodeURIComponent(query)}`); setResults(data.items); };
  const makeIntent = () => ({caseId:selected!.id,profile:selected!.profile,action,taskId:taskId||undefined,eventId:eventId||undefined,winner,scope,leftovers:{}});
  const makePreview = async () => { setMessage(""); const data=await api("previews",{method:"POST",body:JSON.stringify({intent:makeIntent()})}); setPreview(data.preview); };
  const submit = async () => { if (!preview) return; const data=await api("repairs",{method:"POST",body:JSON.stringify({previewId:preview.id,idempotencyKey:crypto.randomUUID()})}); setOperation(data.operation); setMessage("Repair queued. This page will show its result."); };
  const dismiss = async () => { if (!selected) return; await api(`cases/${encodeURIComponent(selected.id)}/dismiss`,{method:"POST",body:"{}"}); setSelected(undefined); await refresh(); };
  const reconcile = async () => { const data=await api("reconcile",{method:"POST",body:JSON.stringify({profile})}); setMessage(`Reconciliation queued for ${profile}.`); setOperation(data.reconciliation); };
  const snapshot=(sideName:string) => details?.snapshots?.find((s:any)=>s.ref.side===sideName)?.object;
  return <main>
    <header><div><h1>Calendar sync review</h1><p>Review conflicts using current Todoist and Calendar data.</p></div>
      <label>Inbox <select value={profile} onChange={e=>{setProfile(e.target.value);setSelected(undefined);}}>{profiles.map(p=><option key={p}>{p}</option>)}</select></label>
      <button onClick={()=>reconcile().catch(e=>setMessage(e.message))}>Run reconciliation</button>
    </header>
    {message && <p className="notice" role="status">{message}</p>}
    <div className="layout"><nav aria-label="Conflicts"><h2>Conflicts</h2>{cases.map(item=><button className={`case ${selected?.id===item.id?"active":""}`} key={item.id} onClick={()=>setSelected(item)}><strong>{item.title}</strong><span>{item.profile} · {item.status}</span><small>{item.reason}</small></button>)}{cases.length===0&&<p>No open conflicts.</p>}</nav>
      <section className="detail">{!selected?<p>Select a conflict to inspect its live provider data.</p>:<>
        <div className="title"><div><h2>{selected.title}</h2><p>{selected.reason} · opened {new Date(selected.createdAt).toLocaleString()}</p></div><button className="secondary" onClick={()=>dismiss().catch(e=>setMessage(e.message))}>Dismiss alert</button></div>
        <div className="columns"><article><h3>Todoist</h3><pre>{snapshot("todoist")?JSON.stringify(snapshot("todoist"),null,2):"No linked task loaded"}</pre></article><article><h3>Calendar</h3><pre>{snapshot("calendar")?JSON.stringify(snapshot("calendar"),null,2):"No linked event loaded"}</pre></article></div>
        <h3>Repair</h3><div className="formgrid">
          <label>Operation<select value={action} onChange={e=>setAction(e.target.value)}>{["link","separate","create","exclude","verify","move","decision"].map(x=><option key={x}>{x}</option>)}</select></label>
          <label>Field winner<select value={winner} onChange={e=>setWinner(e.target.value)}><option value="none">No field changes</option><option value="todoist">Todoist</option><option value="calendar">Calendar</option></select></label>
          <label>Recurrence scope<select value={scope} onChange={e=>setScope(e.target.value)}><option value="occurrence">This occurrence</option><option value="series">Entire series</option><option value="future">Future occurrences</option></select></label>
          <label>Todoist task ID<input value={taskId} onChange={e=>setTaskId(e.target.value)} /></label>
          <label>Calendar event ID<input value={eventId} onChange={e=>setEventId(e.target.value)} /></label>
        </div>
        <div className="search"><label>Find another counterpart<select value={side} onChange={e=>setSide(e.target.value)}><option value="todoist">Todoist task</option><option value="calendar">Calendar event</option></select></label><input placeholder="Search title or ID" value={query} onChange={e=>setQuery(e.target.value)} /><button className="secondary" onClick={()=>search().catch(e=>setMessage(e.message))}>Search</button></div>
        {results.length>0&&<ul className="results">{results.map(item=><li key={item.id}><button onClick={()=>side==="todoist"?setTaskId(item.id):setEventId(item.id)}>{item.title} · {item.start||"no date"} · {item.id}</button></li>)}</ul>}
        <button onClick={()=>makePreview().catch(e=>setMessage(e.message))}>Preview changes</button>
        {preview&&<div className="preview"><h3>Preview</h3><ul>{preview.changes.map((x,i)=><li key={i}>{x}</li>)}</ul>{preview.warnings.map((x,i)=><p className="warning" key={i}>{x}</p>)}<p>Expires {new Date(preview.expiresAt*1000).toLocaleString()}</p><button onClick={()=>submit().catch(e=>setMessage(e.message))}>Approve and queue repair</button></div>}
        {operation&&<p className="notice">Repair status: <strong>{operation.status}</strong>{operation.error?` — ${operation.error}`:""}</p>}
      </>}</section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
