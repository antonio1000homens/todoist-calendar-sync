import React, {useEffect, useState} from "react";
import {
  backupNotice, erasureCanStart, erasureConfirmationReady,
  erasurePreviewMatchesSelection, profileOptions,
} from "./erasure-policy.mjs";
import {canApplyRecovery,recoveryNeedsDispatch} from "./erasure-recovery-policy.mjs";

type Selection = {profile:string; taskId:string; eventId:string; deleteCalendar:boolean};
type Preview = {
  operationId:string; profile:string; target:{taskId:string; eventId?:string};
  selectedActions:{deleteTodoist:boolean;deleteCalendar:boolean};
  blockers:string[]; inventory:Array<{type:string;key:{pk:string;sk:string};classification:string;digest:string}>;
  inventoryDigest?:string; classificationCounts?:Record<string,number>;
  confirmation?:{confirmationId:string;expiresAt:number};
  executionEnabled?:boolean; backupRetentionNotice?:string;
};
type Operation = {
  operationId:string;status:string;profile?:string;providerDeletionReady?:boolean;queueReady?:boolean;
  executionEnabled?:boolean;phase?:string;deletionProgress?:{stage:string;commentsCompleted:number;stateRowsCompleted:number};
  operatorRecoveryRequired?:boolean;message?:string;backupRetentionNotice?:string;
};
type ErasureApi=(route:string, options?:RequestInit)=>Promise<any>;
const startSelection:Selection={profile:"work",taskId:"",eventId:"",deleteCalendar:false};
export function ErasurePanel({api}:{api:ErasureApi}) {
  const [selection,setSelection]=useState<Selection>(startSelection);
  const [preview,setPreview]=useState<Preview|undefined>();
  const [confirmed,setConfirmed]=useState({phrase:"",taskId:"",eventId:""});
  const [operation,setOperation]=useState<Operation|undefined>();
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [statusMissing,setStatusMissing]=useState(false);
  const [started,setStarted]=useState(false);
  const [findOperationId,setFindOperationId]=useState("");
  const [recoveryPreview,setRecoveryPreview]=useState<any>();
  const [recoveryConfirmation,setRecoveryConfirmation]=useState<any>();
  const [recoveryTyped,setRecoveryTyped]=useState({phrase:"",operationId:"",profile:""});
  const [recoveryStatus,setRecoveryStatus]=useState<string|undefined>();
  const edit=(patch:Partial<Selection>)=>{
    setSelection(value=>({...value,...patch}));
    setPreview(undefined);setConfirmed({phrase:"",taskId:"",eventId:""});
    setOperation(undefined);setNotice("");setStarted(false);setStatusMissing(false);
    setRecoveryPreview(undefined);setRecoveryConfirmation(undefined);setRecoveryStatus(undefined);
  };
  const selectionReady=Boolean(selection.taskId.trim()
    && /^[A-Za-z0-9_.-]{1,256}$/.test(selection.taskId.trim())
    && (!selection.eventId.trim()||/^[A-Za-z0-9_.-]{1,1024}$/.test(selection.eventId.trim()))
    && (!selection.deleteCalendar||selection.eventId.trim()));
  const validPreview=erasurePreviewMatchesSelection(preview,selection)?preview:undefined;
  const confirmationReady=erasureConfirmationReady(validPreview,selection,confirmed);
  const fetchExisting=async()=>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(findOperationId)||busy)return;
    setBusy(true);setNotice("");setRecoveryPreview(undefined);setRecoveryConfirmation(undefined);
    try{
      const result=await api("erasure-operations/"+encodeURIComponent(findOperationId));
      setOperation(result.operation);setRecoveryStatus(undefined);setStarted(true);
      if(result.operation?.status==="review_required")setNotice("Recovery requires an independent inspection; the original purge cannot be resumed.");
    }catch(error:any){setNotice(error.message||"Operation lookup failed.");}
    finally{setBusy(false);}
  };
  const inspectRecovery=async()=>{
    if(!operation||busy)return;
    setBusy(true);setNotice("");setRecoveryConfirmation(undefined);setRecoveryTyped({phrase:"",operationId:"",profile:""});
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId));
      setRecoveryPreview(result.preview);
    }catch(error:any){setRecoveryPreview(undefined);setNotice(error.message||"Recovery inspection did not complete.");}
    finally{setBusy(false);}
  };
  const confirmRecovery=async()=>{
    if(!recoveryPreview?.allowed||busy||!operation)return;
    setBusy(true);setNotice("");
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/confirm",{
        method:"POST",body:"{}"
      });
      setRecoveryPreview(result.preview);setRecoveryConfirmation({confirmationId:result.confirmationId,expiresAt:result.expiresAt});
    }catch(error:any){setNotice(error.message||"Recovery confirmation could not be issued.");setRecoveryConfirmation(undefined);}
    finally{setBusy(false);}
  };
  const applyRecovery=async()=>{
    if(!canApplyRecovery(recoveryPreview,recoveryConfirmation,recoveryTyped,operation)||busy||!operation)return;
    if(!window.confirm("Restore synchronization for exactly this profile? This does not resume or undo provider erasure; it is a separately audited recovery operation."))return;
    setBusy(true);setNotice("");
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/apply",{
        method:"POST",body:JSON.stringify({operationId:recoveryTyped.operationId,profile:recoveryTyped.profile,
          phrase:recoveryTyped.phrase,confirmationId:recoveryConfirmation.confirmationId})
      });
      setRecoveryStatus(result.recovery?.status||"queued");setRecoveryConfirmation(undefined);
    }catch(error:any){
      setNotice(error.message||"Recovery apply was rejected. Inspect its durable status before retrying.");
      setRecoveryConfirmation(undefined);setRecoveryStatus(undefined);
    }finally{setBusy(false);}
  };
  const refreshRecovery=async()=>{
    if(!operation)return;
    try{
      const result=await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/status");
      setRecoveryStatus(result.recovery?.status);
      if(result.recovery?.lastError)setNotice(result.recovery.lastError);
    }catch(error:any){setNotice(error.message||"Recovery status unavailable. Do not start another erasure.");}
  };
  const retryRecoveryDispatch=async()=>{
    if(!operation||!recoveryNeedsDispatch(recoveryStatus)||busy)return;
    setBusy(true);
    try{await api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/dispatch",{
      method:"POST",body:"{}"
    });setNotice("Existing durable recovery redispatched; no provider deletion was queued.");}
    catch(error:any){setNotice(error.message||"Recovery dispatch failed; the fence remains.");}
    finally{setBusy(false);}
  };
  useEffect(()=>{
    if(!recoveryNeedsDispatch(recoveryStatus))return;
    const timer=setInterval(()=>{void refreshRecovery();},10000);
    return ()=>clearInterval(timer);
  },[recoveryStatus,operation?.operationId]);

  const loadPreview=async()=>{
    setBusy(true);setNotice("");setPreview(undefined);setOperation(undefined);
    setConfirmed({phrase:"",taskId:"",eventId:""});setStarted(false);setStatusMissing(false);
    try {
      const result=await api("erasure-previews",{method:"POST",body:JSON.stringify({
        profile:selection.profile,taskId:selection.taskId.trim(),
        ...(selection.eventId.trim()?{eventId:selection.eventId.trim()}:{}),
        deleteCalendar:selection.deleteCalendar
      })});
      setPreview(result.preview);
      if(result.preview?.blockers?.length)setNotice("Blocked: no erasure confirmation can be applied.");
    }catch(error:any){setNotice(error.message||"Unable to prepare exact inventory.");}
    finally{setBusy(false);}
  };
  const persistOperation=async()=>{
    if(!validPreview||!confirmationReady||busy)return;
    if(!window.confirm("Permanently erase the exact Todoist item and selected Calendar item? This deletes attributable live-table history. Backups may remain for 35 days."))return;
    setBusy(true);setNotice("");
    try{
      const result=await api("erasure-operations",{method:"POST",body:JSON.stringify({
        operationId:validPreview.operationId,
        confirmationId:validPreview.confirmation!.confirmationId
      })});
      setPreview(undefined);setConfirmed({phrase:"",taskId:"",eventId:""});
      setOperation(result.operation);
      if(!erasureCanStart(result.operation))setNotice("Prepared only; execution is not ready. No deletion was queued.");
    }catch(error:any){setNotice(error.message||"Erasure confirmation rejected. Request a fresh preview.");setPreview(undefined);}
    finally{setBusy(false);}
  };
  const launch=async()=>{
    if(!erasureCanStart(operation)||busy)return;
    setBusy(true);setNotice("");
    try{
      const result=await api(`erasure-operations/${encodeURIComponent(operation!.operationId)}/start`,{
        method:"POST",body:"{}"
      });
      setOperation(old=>old?{...old,...result.operation}:result.operation);setStarted(true);
    }catch(error:any){setNotice(error.message||"The erasure could not be queued. Verify status before retrying.");}
    finally{setBusy(false);}
  };
  const refreshStatus=async()=>{
    if(!operation)return;
    try{
      const result=await api(`erasure-operations/${encodeURIComponent(operation.operationId)}`);
      setOperation(result.operation);setStatusMissing(false);
    }catch(error:any){
      if(error?.status===404||error?.data?.error==="erasure_operation_not_found"){
        setStatusMissing(true);
        setNotice("The operation record is absent. This is not proof of successful erasure; independently verify both providers and attributable live-table records.");
      }else setNotice(error.message||"Could not refresh the operation. Retry without creating another.");
    }
  };
  useEffect(()=>{
    if(!started||!operation||statusMissing||operation.status==="review_required"
      ||operation.status==="partial_failure"||operation.status==="succeeded")return;
    const timer=setInterval(()=>{void refreshStatus();},7000);
    return ()=>clearInterval(timer);
  },[started,operation?.operationId,operation?.status,statusMissing]);
  return <section className="preview erasure-panel" aria-labelledby="erasure-heading">
    <h2 id="erasure-heading">Explicit item erasure — operator only</h2>
    <p>This is <strong>not ordinary sync deletion</strong>. It permanently deletes exact selected provider items and attributable live-table audit/history. It cannot be undone with this interface. Recurrences, shared/ambiguous identities, and replayable records are rejected.</p>
    <p className="warning">{backupNotice}</p>
    <fieldset disabled={busy||Boolean(operation)} className="erasure-fields"><legend>Exact target</legend>
      <div className="formgrid">
        <label>Sync profile<select value={selection.profile} onChange={event=>edit({profile:event.target.value})}>{profileOptions.map(name=><option key={name} value={name}>{name}</option>)}</select></label>
        <label>Exact Todoist task ID<input value={selection.taskId} autoComplete="off" onChange={event=>edit({taskId:event.target.value})}/></label>
        <label>Exact Calendar event ID (optional)<input value={selection.eventId} autoComplete="off" onChange={event=>edit({eventId:event.target.value,deleteCalendar:false})}/></label>
      </div>
      <label className="erasure-checkbox"><input type="checkbox" checked={selection.deleteCalendar} disabled={!selection.eventId.trim()} onChange={event=>edit({deleteCalendar:event.target.checked})}/> Separately delete the exact Calendar event</label>
    </fieldset>
    {!operation&&<div className="erasure-results">
      <h3>Resume inspection of an existing erasure</h3>
      <label>Recorded erasure operation ID
        <input autoComplete="off" value={findOperationId} onChange={event=>setFindOperationId(event.target.value)}/>
      </label>
      <button className="secondary" disabled={busy||!/^[A-Za-z0-9_-]{1,128}$/.test(findOperationId)}
        onClick={()=>void fetchExisting()}>Load operation status</button>
      <p>This loads evidence only. An existing <code>review_required</code> erasure cannot restart deletion.</p>
    </div>}
    {!operation&&<button disabled={busy||!selectionReady} onClick={()=>void loadPreview()}>{busy?"Inspecting exact inventory…":"Preview exact erasure"}</button>}
    {notice&&<p className="warning" role="status">{notice}</p>}
    {validPreview&&!operation&&<div className="erasure-results">
      <h3>Exact inventory</h3>
      <p>Profile <strong>{validPreview.profile}</strong> · Todoist <code>{validPreview.target.taskId}</code>
        {validPreview.target.eventId&&<> · Calendar <code>{validPreview.target.eventId}</code></>}
        · Calendar delete <strong>{validPreview.selectedActions.deleteCalendar?"yes":"no"}</strong>
      </p>
      <p>Matching records: {validPreview.inventory?.length||0}. Preview ID: <code>{validPreview.operationId}</code></p>
      {validPreview.inventory?.length>0&&<div className="erasure-scroll"><table><thead><tr><th>Type</th><th>DynamoDB exact key</th><th>Attribution</th></tr></thead>
        <tbody>{validPreview.inventory.map((item,index)=><tr key={index}><td>{item.type}</td><td><code>{item.key.pk} / {item.key.sk}</code></td><td>{item.classification}</td></tr>)}</tbody></table></div>}
      {validPreview.blockers?.length>0&&<><h4>Blocking conditions</h4><ul>{validPreview.blockers.map((item,i)=><li className="warning" key={i}>{item}</li>)}</ul></>}
      {validPreview.executionEnabled!==true&&<p className="warning">Execution is disabled in this deployment. This preview cannot be applied; an explicit reviewed deployment opt-in is required.</p>}
      {validPreview.confirmation&&validPreview.executionEnabled===true&&validPreview.blockers.length===0&&<>
        <h4>Fresh, exact action-time confirmation</h4>
        <p>Confirmation expires {new Date(validPreview.confirmation.expiresAt).toLocaleString()}. Review all record keys and the separately selected Calendar action before proceeding.</p>
        <div className="formgrid">
          <label>Type PERMANENTLY ERASE<input autoComplete="off" value={confirmed.phrase} onChange={event=>setConfirmed(v=>({...v,phrase:event.target.value}))}/></label>
          <label>Re-enter exact Todoist task ID<input autoComplete="off" value={confirmed.taskId} onChange={event=>setConfirmed(v=>({...v,taskId:event.target.value}))}/></label>
          {selection.deleteCalendar&&<label>Re-enter exact Calendar event ID<input autoComplete="off" value={confirmed.eventId} onChange={event=>setConfirmed(v=>({...v,eventId:event.target.value}))}/></label>}
        </div>
        <button disabled={!confirmationReady||busy} onClick={()=>void persistOperation()}>Confirm permanent erasure</button>
      </>}
      <button className="secondary" disabled={busy} onClick={()=>{setPreview(undefined);setConfirmed({phrase:"",taskId:"",eventId:""});}}>Cancel preview</button>
    </div>}
    {operation&&<div className="erasure-results">
      <h3>Erasure operation: {operation.status.replaceAll("_"," ")}</h3>
      <p>Operation ID: <code>{operation.operationId}</code> · Phase: {operation.phase||"not started"}</p>
      <p>Provider ready: {operation.providerDeletionReady?"yes":"no"} · Queue ready: {operation.queueReady?"yes":"no"}</p>
      {operation.deletionProgress&&<p>Deletion stage: {operation.deletionProgress.stage} · comments: {operation.deletionProgress.commentsCompleted} · state rows: {operation.deletionProgress.stateRowsCompleted}</p>}
      {operation.operatorRecoveryRequired&&<p className="warning" role="alert">{operation.message||"Operator break-glass recovery required. Do not clear fences manually."}</p>}
      {operation.status==="review_required"&&<div className="erasure-results" aria-label="Independent erasure recovery">
        <h4>Inspect guarded recovery</h4>
        <p className="warning">Provider deletion may have partially succeeded. This workflow never resumes deletion, creates missing provider records, or blindly clears a fence. A blocked case needs operator escalation.</p>
        <button disabled={busy} onClick={()=>void inspectRecovery()}>Inspect independent recovery evidence</button>
        {recoveryPreview&&<>
          <p>Classification: <strong>{recoveryPreview.classification}</strong> · Profile: <strong>{recoveryPreview.profile}</strong> · Fence owned: {recoveryPreview.fenceOwned?"yes":"no"} · Leases: {recoveryPreview.leaseCount}</p>
          <p>Provider items absent: {recoveryPreview.providerItemsAbsent?"yes":"no"} · Attributable state rows absent: {recoveryPreview.stateRowsAbsent?"yes":"no"} · Epoch: {recoveryPreview.epoch||"not verified"}</p>
          <div className="erasure-scroll"><table><thead><tr><th>Mapping UUID</th><th>Observed state</th><th>Original state</th></tr></thead><tbody>
            {recoveryPreview.mappingStates?.map((mapping:any)=><tr key={mapping.id}><td><code>{mapping.id}</code></td><td>{mapping.state}</td><td>{mapping.originallyEnabled?"Enabled":"Disabled"}</td></tr>)}
          </tbody></table></div>
          {recoveryPreview.blockers?.length>0&&<ul>{recoveryPreview.blockers.map((text:string,i:number)=><li key={i} className="warning">{text}</li>)}</ul>}
          {recoveryPreview.allowed&&!recoveryStatus&&!recoveryConfirmation&&<button disabled={busy} onClick={()=>void confirmRecovery()}>
            Request single-use recovery confirmation</button>}
        </>}
        {recoveryConfirmation&&<>
          <p>Recovery confirmation expires {new Date(recoveryConfirmation.expiresAt).toLocaleString()}.</p>
          <div className="formgrid">
            <label>Type RESTORE SYNC<input autoComplete="off" value={recoveryTyped.phrase} onChange={e=>setRecoveryTyped(v=>({...v,phrase:e.target.value}))}/></label>
            <label>Repeat exact operation ID<input autoComplete="off" value={recoveryTyped.operationId} onChange={e=>setRecoveryTyped(v=>({...v,operationId:e.target.value}))}/></label>
            <label>Repeat exact profile<input autoComplete="off" value={recoveryTyped.profile} onChange={e=>setRecoveryTyped(v=>({...v,profile:e.target.value}))}/></label>
          </div>
          <button disabled={busy||!canApplyRecovery(recoveryPreview,recoveryConfirmation,recoveryTyped,operation)}
            onClick={()=>void applyRecovery()}>Confirm guarded profile recovery</button>
        </>}
        {recoveryStatus&&<p role="status">Recovery state: <strong>{recoveryStatus.replaceAll("_"," ")}</strong>
          {recoveryStatus==="completed"?" — profile fence released after verified admission restoration.":""}
          {recoveryStatus==="blocked"?" — evidence changed; retain protections and escalate.":""}
        </p>}
        <button className="secondary" disabled={busy} onClick={()=>void refreshRecovery()}>Refresh recovery status</button>
        {recoveryNeedsDispatch(recoveryStatus)&&<button className="secondary" disabled={busy} onClick={()=>void retryRecoveryDispatch()}>Retry existing recovery dispatch</button>}
      </div>}
      {!started&&erasureCanStart(operation)&&<button disabled={busy} onClick={()=>void launch()}>Start guarded erasure</button>}
      <button className="secondary" disabled={busy||statusMissing} onClick={()=>void refreshStatus()}>Refresh operation status</button>
      {statusMissing&&<p className="warning">Status record absent. Verify provider readback and DynamoDB postflight independently before reporting success.</p>}
      <p className="warning">{operation.backupRetentionNotice||backupNotice}</p>
    </div>}
  </section>;
}
