import React, {useEffect,useRef,useState} from "react";
import {orphanItemsForCase} from "./orphan-selection.mjs";
import {orphanCaseEvidenceVersion} from "./orphan-preview-state.mjs";

type CaseIdentity={id:string;profile:string;status:string;updatedAt?:string};
type OrphanProps={
  item:CaseIdentity;
  snapshots:any[];
  loading?:boolean;
  recheck:()=>void|Promise<void>;
  api:(path:string,init?:{method?:string;body?:string})=>Promise<any>;
};

/** Inspect only identities already recorded on this case. No selectable
 * deletion target exists until a separate guarded executor is enabled. */
export function OrphanDeletionPanel({item,snapshots,loading=false,recheck,api}:OrphanProps){
  const [inspection,setInspection]=useState<any>();
  const [inspectionError,setInspectionError]=useState("");
  const [inspecting,setInspecting]=useState(false);
  const sequence=useRef(0);
  const evidenceVersion=orphanCaseEvidenceVersion(item,snapshots);
  const candidates=orphanItemsForCase({item,snapshots});

  useEffect(()=>{
    sequence.current++;
    setInspection(undefined);setInspectionError("");setInspecting(false);
  },[item.id,item.profile,item.updatedAt,evidenceVersion]);

  const inspect=async()=>{
    if(inspecting||loading)return;
    const request=++sequence.current;
    setInspection(undefined);setInspectionError("");setInspecting(true);
    try{
      const result=await api("cases/"+encodeURIComponent(item.id)+"/orphan-readiness");
      if(request===sequence.current&&result?.readiness?.caseId===item.id
        &&result.readiness.profile===item.profile)setInspection(result.readiness);
    }catch(error){
      if(request===sequence.current)setInspectionError(error instanceof Error?error.message:String(error));
    }finally{
      if(request===sequence.current)setInspecting(false);
    }
  };

  if(candidates.length===0)return null;
  return <section className="orphan-evidence" aria-label="Orphan identity inspection">
    <h3>Orphan identity inspection (read-only)</h3>
    <p>These items were recorded on this specific alert. No deletion is enabled. An item cannot be selected for deletion from this page; inspection does not delete or modify any task, event or mapping.</p>
    <ul>{candidates.map(candidate=><li key={candidate.key}>
      <strong>{candidate.label}</strong> · {candidate.status}
      <p className="action-explanation">{candidate.reason}</p>
    </li>)}</ul>
    <button className="secondary" disabled={loading||inspecting} onClick={()=>void inspect()}>
      {inspecting?"Checking exact provider evidence…":"Inspect deletion readiness (read-only)"}
    </button>
    <button className="secondary" disabled={loading||inspecting} onClick={()=>{
      sequence.current++;setInspection(undefined);setInspectionError("");
      void recheck();
    }}>Recheck this alert's provider items (read-only)</button>
    {inspectionError&&<p className="warning" role="alert">{inspectionError}. Nothing was deleted.</p>}
    {inspection&&<div className="orphan-readiness" role="status">
      <p><strong>Server assessment: {inspection.status||"blocked"} — no deletion is enabled.</strong> Checked: {inspection.checkedAt}</p>
      {inspection.blockers?.map((blocker:string)=><p key={blocker} className="warning">{blocker}</p>)}
      <ul>{inspection.items?.map((entry:any)=><li key={entry.side+":"+entry.id}>
        <strong>{entry.side==="todoist"?"Todoist":"Calendar"} · {entry.title} · {entry.id}</strong>
        <span> {entry.state}. {entry.blockers?.join("; ")}</span>
      </li>)}</ul>
    </div>}
  </section>;
}
