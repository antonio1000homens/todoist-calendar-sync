import React, {useEffect,useState} from "react";
import {canApplyRecovery,recoveryNeedsDispatch} from "./erasure-recovery-policy.mjs";

// Historical erasure operations must remain inspectable/recoverable after the
// arbitrary item-erasure UI is removed. Never start or resume provider deletes.
type ErasureApi=(route:string,options?:RequestInit)=>Promise<any>;
type Operation={operationId:string;profile?:string;status:string;phase?:string;
  providerDeletionReady?:boolean;recoveryStatus?:string;operatorRecoveryRequired?:boolean;
  message?:string;backupRetentionNotice?:string};
export function ErasureRecoveryPanel({api}:{api:ErasureApi}){
  const [operationId,setOperationId]=useState("");
  const [operation,setOperation]=useState<Operation>();
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const [preview,setPreview]=useState<any>(),[confirmation,setConfirmation]=useState<any>();
  const [postWriteAssessment,setPostWriteAssessment]=useState<any>();
  const [typed,setTyped]=useState({phrase:"",operationId:"",profile:""});
  const [recoveryStatus,setRecoveryStatus]=useState<string>();
  const lookup=async()=>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||busy)return;
    setBusy(true);setNotice("");setOperation(undefined);setPreview(undefined);setPostWriteAssessment(undefined);setConfirmation(undefined);setTyped({phrase:"",operationId:"",profile:""});setRecoveryStatus(undefined);
    try{
      const result=await api("erasure-operations/"+encodeURIComponent(operationId));
      setOperation(result.operation);setRecoveryStatus(result.operation?.recoveryStatus);
    }catch(e:any){setNotice(e.message||"Operation lookup failed");}
    finally{setBusy(false);}
  };
  const refresh=async()=>{
    if(!operation||busy)return;
    try{
      const result=await api("erasure-operations/"+encodeURIComponent(operation.operationId));
      setOperation(result.operation);setRecoveryStatus(result.operation?.recoveryStatus);
    }catch(e:any){setNotice(e.message||"Operation status unavailable; no deletion success can be inferred");}
  };
  const inspect=async()=>{
    if(!operation||busy)return;
    setBusy(true);setPreview(undefined);setConfirmation(undefined);setNotice("");
    try{const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId));setPreview(result.preview);}
    catch(e:any){setNotice(e.message||"Recovery inspection failed");}
    finally{setBusy(false);}
  };
  const inspectPostWrite=async()=>{
    if(!operation||busy)return;
    setBusy(true);setPostWriteAssessment(undefined);setNotice("");
    try{
      const result=await api("erasure-postwrite-recoveries/"+encodeURIComponent(operation.operationId));
      setPostWriteAssessment(result.assessment);
    }catch(e:any){setNotice(e.message||"Post-write evidence inspection failed; fence remains protected");}
    finally{setBusy(false);}
  };
  const requestConfirmation=async()=>{
    if(!operation||!preview?.allowed||busy)return;
    setBusy(true);
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/confirm",{method:"POST",body:"{}"});
      setPreview(result.preview);setConfirmation({confirmationId:result.confirmationId,expiresAt:result.expiresAt});
    }catch(e:any){setConfirmation(undefined);setNotice(e.message||"Recovery confirmation failed");}
    finally{setBusy(false);}
  };
  const apply=async()=>{
    if(!operation||busy||!canApplyRecovery(preview,confirmation,typed,operation))return;
    if(!window.confirm("Restore synchronization for exactly this profile? This will not resume or undo provider deletion."))return;
    setBusy(true);
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/apply",{
        method:"POST",body:JSON.stringify({...typed,confirmationId:confirmation.confirmationId}),
      });
      setRecoveryStatus(result.recovery?.status||"queued");setConfirmation(undefined);setNotice("Guarded recovery accepted. No provider deletion was started.");
    }catch(e:any){setConfirmation(undefined);setNotice(e.message||"Recovery was rejected");}
    finally{setBusy(false);}
  };
  const refreshRecovery=async()=>{
    if(!operation)return;
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/status");
      setRecoveryStatus(result.recovery?.status);
      if(result.recovery?.lastError)setNotice(result.recovery.lastError);
    }catch(e:any){setNotice(e.message||"Recovery status unavailable");}
  };
  const dispatch=async()=>{
    if(!operation||busy||!recoveryNeedsDispatch(recoveryStatus))return;
    setBusy(true);
    try{
      await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/dispatch",{method:"POST",body:"{}"});
      setNotice("Existing recovery redispatched. No provider deletion was queued.");
    }catch(e:any){setNotice(e.message||"Recovery dispatch failed. Preserve the fence.");}
    finally{setBusy(false);}
  };
  useEffect(()=>{
    if(!operation||!recoveryNeedsDispatch(recoveryStatus))return;
    const timer=setInterval(()=>{void refreshRecovery();},10000);
    return()=>clearInterval(timer);
  },[operation?.operationId,recoveryStatus]);
  return <details className="preview erasure-recovery" aria-label="Existing erasure operation status and recovery">
    <summary>Existing erasure operation status / recovery</summary>
    <p>Inspect or recover an already-recorded operation. This panel cannot preview, create, start or resume provider deletion. A prior partially completed erasure may require break-glass recovery.</p>
    <label>Recorded operation ID<input autoComplete="off" value={operationId} onChange={e=>setOperationId(e.target.value)}/></label>
    <button className="secondary" disabled={busy||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)} onClick={()=>void lookup()}>Load operation status</button>
    {notice&&<p role="status" className="warning">{notice}</p>}
    {operation&&<div className="erasure-results">
      <p>Operation <code>{operation.operationId}</code> · profile <strong>{operation.profile}</strong> · status <strong>{operation.status}</strong> · phase {operation.phase||"not recorded"}</p>
      <button className="secondary" disabled={busy} onClick={()=>void refresh()}>Refresh operation status</button>
      {operation.operatorRecoveryRequired&&<p className="warning" role="alert">{operation.message||"Independent recovery is required. Do not clear a fence manually."}</p>}
      {operation.status==="review_required"&&<>
        <h4>Inspect independent recovery evidence</h4>
        <p>Recovery never resumes an old provider deletion or creates replacements.</p>
        <button disabled={busy} onClick={()=>void inspect()}>Inspect guarded recovery</button>
        {preview&&<>
          <p>Classification: {preview.classification} · Profile: {preview.profile} · fence owned: {preview.fenceOwned?"yes":"no"} · leases: {preview.leaseCount}</p>
          <p>Provider items absent: {preview.providerItemsAbsent?"yes":"no"} · attributable state absent: {preview.stateRowsAbsent?"yes":"no"}</p>
          {preview.blockers?.length>0&&<ul>{preview.blockers.map((text:string,i:number)=><li key={i} className="warning">{text}</li>)}</ul>}
          {preview.allowed&&!recoveryStatus&&!confirmation&&<button disabled={busy} onClick={()=>void requestConfirmation()}>Request recovery confirmation</button>}
        </>}
        <h4>Post-write evidence (read-only)</h4>
        <p>Inspect evidence after an erasure may have deleted a provider item. This assessment cannot confirm, resume or finish deletion, restore worker mappings, or release a fence.</p>
        <button className="secondary" disabled={busy} onClick={()=>void inspectPostWrite()}>Inspect post-write evidence</button>
        {postWriteAssessment&&<div className="erasure-results" aria-label="Post-write recovery evidence">
          <p>Classification: <strong>{postWriteAssessment.classification?.replaceAll("_"," ")}</strong> · profile <strong>{postWriteAssessment.profile}</strong> · fence release: <strong>not authorised</strong></p>
          <p>Write evidence recorded: {postWriteAssessment.evidence?.originalProviderWriteIndicated?"yes":"no"} · both original targets recorded: {postWriteAssessment.evidence?.exactTodoistAndCalendarTargetsRecorded?"yes":"no"} · matching fence: {postWriteAssessment.evidence?.matchingFence?"yes":"no"} · leases drained: {postWriteAssessment.evidence?.leasesDrained?"yes":"no"}</p>
          <p>Provider items absent: {postWriteAssessment.evidence?.providersAbsent?"yes":"no"} · state rows absent: {postWriteAssessment.evidence?.stateRowsAbsent?"yes":"no"} · original worker mappings restored: {postWriteAssessment.evidence?.workerMappingsRestored?"yes":"no"}</p>
          <p className="warning">Only safe action: preserve the existing fence for independently authorised follow-up. No post-write confirmation or apply action exists.</p>
          {postWriteAssessment.blockers?.length>0&&<ul>{postWriteAssessment.blockers.map((message:string,i:number)=><li key={i} className="warning">{message}</li>)}</ul>}
        </div>}
        {confirmation&&<>
          <p>Confirmation expires {new Date(confirmation.expiresAt).toLocaleString()}.</p>
          <label>Type RESTORE SYNC<input value={typed.phrase} autoComplete="off" onChange={e=>setTyped(v=>({...v,phrase:e.target.value}))}/></label>
          <label>Repeat operation ID<input value={typed.operationId} autoComplete="off" onChange={e=>setTyped(v=>({...v,operationId:e.target.value}))}/></label>
          <label>Repeat profile<input value={typed.profile} autoComplete="off" onChange={e=>setTyped(v=>({...v,profile:e.target.value}))}/></label>
          <button disabled={busy||!canApplyRecovery(preview,confirmation,typed,operation)} onClick={()=>void apply()}>Confirm guarded recovery</button>
        </>}
        {recoveryStatus&&<p role="status">Recovery state: {recoveryStatus.replaceAll("_"," ")}</p>}
        <button className="secondary" onClick={()=>void refreshRecovery()}>Refresh recovery status</button>
        {recoveryNeedsDispatch(recoveryStatus)&&<button className="secondary" disabled={busy} onClick={()=>void dispatch()}>Retry existing recovery dispatch</button>}
      </>}
    </div>}
  </details>;
}
