import React, {useEffect,useMemo,useRef,useState} from "react";
import {orphanItemsForCase} from "./orphan-selection.mjs";
import {previewCandidate,previewBelongsToCase,orphanCaseEvidenceVersion} from "./orphan-preview-state.mjs";

type CaseIdentity={id:string;profile:string;status:string;updatedAt?:string};
type OrphanProps={
  item:CaseIdentity;
  snapshots:any[];
  loading?:boolean;
  recheck:()=>void|Promise<void>;
  api:(path:string,init?:{method?:string;body?:string})=>Promise<any>;
};

/** A destructive action is intentionally not offered until the server has an
 * actual immutable case-bound, single-target, fenced erasure protocol.
 * Existing arbitrary task-ID purging cannot safely delete Calendar orphans. */
export function OrphanDeletionPanel({item,snapshots,loading=false,recheck,api}:OrphanProps){
  const [key,setKey]=useState("");
  const [preview,setPreview]=useState<any>();
  const [previewing,setPreviewing]=useState(false);
  const [previewError,setPreviewError]=useState("");
  const [inspection,setInspection]=useState<any>();
  const [inspectionError,setInspectionError]=useState("");
  const [inspecting,setInspecting]=useState(false);
  const requestSequence=useRef(0);
  const candidates=useMemo(()=>orphanItemsForCase({item,snapshots}),[item,snapshots]);
  const evidenceVersion=orphanCaseEvidenceVersion(item,snapshots);
  // Scoped to the immutable alert, not the global inbox/reconciliation filter.
  useEffect(()=>{
    requestSequence.current++;
    setInspection(undefined);setInspectionError("");setInspecting(false);
    setKey("");setPreview(undefined);setPreviewError("");setPreviewing(false);
  },[item.id,item.profile,item.updatedAt,evidenceVersion]);
  const change=(next:string)=>{
    requestSequence.current++;
    setKey(next);
    setPreview(undefined);setPreviewError("");setPreviewing(false);
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
  const candidateToPreview=previewCandidate(candidates,item,key);
  const serverPreview=previewBelongsToCase(preview,item,candidateToPreview)?preview:undefined;
  const requestPreview=async()=>{
    if(!candidateToPreview||previewing||loading)return;
    const request=++requestSequence.current;
    const proposed={...candidateToPreview};
    setPreview(undefined);setPreviewError("");setPreviewing(true);
    try {
      const value=await api("cases/"+encodeURIComponent(item.id)+"/orphan-previews",{
        method:"POST",body:JSON.stringify({side:proposed.side,id:proposed.id}),
      });
      if(request!==requestSequence.current)return;
      if(!previewBelongsToCase(value?.preview,item,proposed))
        throw new Error("Server returned an expired, altered or incorrectly scoped preview; no confirmation was accepted");
      setPreview(value.preview);
    } catch(error) {
      if(request===requestSequence.current)
        setPreviewError(error instanceof Error?error.message:String(error));
    } finally {
      if(request===requestSequence.current)setPreviewing(false);
    }
  };
  return <section className="preview orphan-deletion" aria-label="Delete orphan item">
    <h3>Delete orphan item</h3>
    <p>Only the surviving item from this specific open review alert can be considered. A missing mapping, an empty search or a stale alert does not prove the other provider item was deleted. Other review actions remain available below.</p>
    <label>Item to delete
      <select value={candidates.some(candidate=>candidate.key===key)?key:""} onChange={e=>change(e.target.value)}>
        <option value="">Choose exactly one Todoist or Calendar item from this alert</option>
        {candidates.map(candidate=><option key={candidate.key} value={candidate.key} disabled={!candidate.live}>
          {candidate.label} · {candidate.status} · {candidate.live?"preview only — deletion not enabled":`blocked: ${candidate.reason}`}
        </option>)}
      </select>
    </label>
    {selected&&<div className="item-identity" role="status" aria-live="polite">
      <strong>{selected.side==="todoist"?"Todoist":"Calendar"} · {selected.title}</strong>
      <span>Sync profile: {item.profile} · Full provider ID: <code>{selected.id}</code></span>
      <span>Status: {selected.status}</span>
      <p className="warning">{selected.reason}</p>
    </div>}
    {!serverPreview&&<p className="notice" role="status">No provider deletion is available. You can select a live item and request an authoritative, case-bound safety preview; this does not delete anything. If blocked, use Link / Repair / Exclude / Dismiss instead.</p>}
    {candidates.length>0&&!candidates.some(candidate=>candidate.eligible)&&<div className="orphan-blockers">
      <p>All case-recorded items are blocked. Reasons:</p>
      <ul>{candidates.map(candidate=><li key={candidate.key}><strong>{candidate.label}</strong> — {candidate.reason}</li>)}</ul>
    </div>}
    <button className="secondary" disabled={!candidateToPreview||loading||previewing} onClick={()=>void requestPreview()}>
      {previewing?"Checking complete provider and state inventory…":"Request verified deletion preview (no changes)"}
    </button>
    {previewError&&<p className="warning" role="alert">{previewError}. No deletion was performed. Refresh this alert before retrying if its evidence changed.</p>}
    {serverPreview&&<div className="orphan-preview" role="status" aria-live="polite">
      <p><strong>Server-verified safety preview — NOT a deletion.</strong></p>
      <p>{serverPreview.title} · {serverPreview.profile} · {serverPreview.side} · <code>{serverPreview.targetId}</code></p>
      <p>Expires: {new Date(serverPreview.expiresAt).toLocaleString()}.</p>
      <p className="notice">{serverPreview.warning||"Production execution is disabled. No provider or state changes are queued."}</p>
      <p>Execution queued: No · DynamoDB cleanup scheduled: No</p>
    </div>}
    <button className="secondary" disabled={loading||inspecting||previewing} onClick={()=>void inspect()}>
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
    <button className="secondary" disabled={loading||inspecting||previewing} onClick={()=>{
      requestSequence.current++;setInspection(undefined);setInspectionError("");
      setPreview(undefined);setPreviewError("");setPreviewing(false);
      void recheck();
    }}>
      {loading?"Rechecking…":"Recheck this alert's provider items (no changes)"}
    </button>
  </section>;
}
