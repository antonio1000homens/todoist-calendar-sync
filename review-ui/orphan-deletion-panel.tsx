import React, {useEffect,useMemo,useState} from "react";
import {chosenOrphan,orphanItemsForCase} from "./orphan-selection.mjs";

type CaseIdentity={id:string;profile:string;status:string};
type OrphanProps={
  item:CaseIdentity;
  snapshots:any[];
  loading?:boolean;
  recheck:()=>void|Promise<void>;
};

/** A destructive action is intentionally not offered until the server has an
 * actual immutable case-bound, single-target, fenced erasure protocol.
 * Existing arbitrary task-ID purging cannot safely delete Calendar orphans. */
export function OrphanDeletionPanel({item,snapshots,loading=false,recheck}:OrphanProps){
  const [key,setKey]=useState("");
  const [preview,setPreview]=useState<any>();
  const [typed,setTyped]=useState({phrase:"",id:""});
  const candidates=useMemo(()=>orphanItemsForCase({item,snapshots}),[item,snapshots]);
  // Scoped to the immutable alert, not the global inbox/reconciliation filter.
  useEffect(()=>{
    setKey("");setPreview(undefined);setTyped({phrase:"",id:""});
  },[item.id,item.profile]);
  const change=(next:string)=>{
    setKey(next);
    setPreview(undefined);setTyped({phrase:"",id:""});
  };
  const selected=candidates.find(candidate=>candidate.key===key);
  const eligible=chosenOrphan(candidates,item,key);
  return <section className="preview orphan-deletion" aria-label="Delete orphan item">
    <h3>Delete orphan item</h3>
    <p>Only the surviving item from this specific open review alert can be considered. A missing mapping, an empty search or a stale alert does not prove the other provider item was deleted. Other review actions remain available below.</p>
    <label>Item to delete
      <select value={candidates.some(candidate=>candidate.key===key)?key:""} onChange={e=>change(e.target.value)}>
        <option value="">Choose exactly one Todoist or Calendar item from this alert</option>
        {candidates.map(candidate=><option key={candidate.key} value={candidate.key}>
          {candidate.label} · {candidate.status} · {candidate.eligible?"eligible":"blocked"}
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
    <button className="secondary" disabled={loading} onClick={()=>void recheck()}>
      {loading?"Rechecking…":"Recheck this alert's provider items (no changes)"}
    </button>
    {eligible&&preview&&<p>Verified case-bound deletion preview: {preview.operationId}</p>}
  </section>;
}
