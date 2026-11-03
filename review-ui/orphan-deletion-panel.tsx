import React, {useEffect,useMemo,useRef,useState} from "react";
import {chosenOrphan,orphanItemsForCase} from "./orphan-selection.mjs";

type CaseIdentity={id:string;profile:string;status:string};
type OrphanProps={
  item:CaseIdentity;
  snapshots:any[];
  loading?:boolean;
  recheck:()=>void|Promise<void>;
  api:(path:string)=>Promise<any>;
};

/** A destructive action is intentionally not offered until the server has an
 * actual immutable case-bound, single-target, fenced erasure protocol.
 * Existing arbitrary task-ID purging cannot safely delete Calendar orphans. */
export function OrphanDeletionPanel({item,snapshots,loading=false,recheck,api}:OrphanProps){
  const [key,setKey]=useState("");
  const [preview,setPreview]=useState<any>();
  const [typed,setTyped]=useState({phrase:"",id:""});
  const [inspection,setInspection]=useState<any>();
  const [inspectionError,setInspectionError]=useState("");
  const [inspecting,setInspecting]=useState(false);
  const requestSequence=useRef(0);
  const candidates=useMemo(()=>orphanItemsForCase({item,snapshots}),[item,snapshots]);
  // Scoped to the immutable alert, not the global inbox/reconciliation filter.
  useEffect(()=>{
    requestSequence.current++;
    setInspection(undefined);setInspectionError("");setInspecting(false);
    setKey("");setPreview(undefined);setTyped({phrase:"",id:""});
  },[item.id,item.profile]);
  const change=(next:string)=>{
    setKey(next);
    setPreview(undefined);setTyped({phrase:"",id:""});
  };
  const inspect=async()=>{
    const request=++requestSequence.current;
    setInspection(undefined);setInspectionError("");setInspecting(true);
    try {
      const value=await api("cases/"+encodeURIComponent(item.id)+"/orphan-readiness");
      if(request===requestSequence.current && value?.readiness?.caseId===item.id
        && value.readiness.profile===item.profile) setInspection(value.readiness);
    } catch(error) {
      if(request===requestSequence.current) setInspectionError(error instanceof Error?error.message:String(error));
    } finally {
      if(request===requestSequence.current)setInspecting(false);
    }
  };
  const selected=candidates.find(candidate=>candidate.key===key);
  const eligible=chosenOrphan(candidates,item,key);
  return <section className="preview orphan-deletion" aria-label="Delete orphan item">
    <h3>Delete orphan item</h3>
    <p>Only the surviving item from this specific open review alert can be considered. A missing mapping, an empty search or a stale alert does not prove the other provider item was deleted. Other review actions remain available below.</p>
    <label>Item to delete
      <select value={candidates.some(candidate=>candidate.key===key)?key:""} onChange={e=>change(e.target.value)}>
        <option value="">Choose exactly one Todoist or Calendar item from this alert</option>
        {candidates.map(candidate=><option key={candidate.key} value={candidate.key} disabled={!candidate.eligible}>
          {candidate.label} · {candidate.status} · {candidate.eligible?"eligible":`blocked: ${candidate.reason}`}
        </option>)}
      </select>
    </label>
    {selected&&<div className="item-identity" role="status" aria-live="polite">
      <strong>{selected.side==="todoist"?"Todoist":"Calendar"} · {selected.title}</strong>
      <span>Sync profile: {item.profile} · Full provider ID: <code>{selected.id}</code></span>
      <span>Status: {selected.status}</span>
      <p className="warning">{selected.reason}</p>
    </div>}
    {!eligible&&<p className="notice" role="status">No verified orphan item available for deletion. The current review cannot prove an exact safe one-sided deletion with a durable fence, cross-provider absence and replay suppression. Use the existing Link / Repair / Exclude / Dismiss options instead.</p>}
    {candidates.length>0&&!candidates.some(candidate=>candidate.eligible)&&<div className="orphan-blockers">
      <p>All case-recorded items are blocked. Reasons:</p>
      <ul>{candidates.map(candidate=><li key={candidate.key}><strong>{candidate.label}</strong> — {candidate.reason}</li>)}</ul>
    </div>}
    <button className="secondary" disabled={loading||inspecting} onClick={()=>void inspect()}>
      {inspecting?"Checking direct provider evidence…":"Inspect deletion readiness (read-only)"}
    </button>
    {inspectionError&&<p className="warning" role="alert">{inspectionError}. Nothing has been deleted.</p>}
    {inspection&&<div className="orphan-readiness" role="status" aria-live="polite">
      <p><strong>Server assessment: blocked — no deletion is enabled.</strong> Checked: {inspection.checkedAt}</p>
      {inspection.blockers?.map((blocker:string)=><p key={blocker} className="warning">{blocker}</p>)}
      <ul>{inspection.items?.map((entry:any)=><li key={entry.side+":"+entry.id}>
        <strong>{entry.side==="todoist"?"Todoist":"Calendar"} · {entry.title} · {entry.id}</strong>
        <span> {entry.state}. {entry.blockers?.join("; ")}</span>
      </li>)}</ul>
    </div>}
    <button className="secondary" disabled={loading||inspecting} onClick={()=>{
      requestSequence.current++;setInspection(undefined);setInspectionError("");
      void recheck();
    }}>
      {loading?"Rechecking…":"Recheck this alert's provider items (no changes)"}
    </button>
    {eligible&&preview&&<p>Verified case-bound deletion preview: {preview.operationId}</p>}
  </section>;
}
