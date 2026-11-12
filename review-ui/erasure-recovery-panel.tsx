import React, {useEffect,useRef,useState} from "react";
import {canApplyRecovery,recoveryNeedsDispatch} from "./erasure-recovery-policy.mjs";
import {
  originalInventoryExplanation,recoveryClassificationExplanation,recoveryDiagnosticRows,
  recoveryComparisonRows,recoveryTombstoneStatus,recoveryIndependentGuard,recoveryNextSafeAction,
  recoveryExecutionSummary,workerMappingSummary,
} from "./erasure-recovery-explanations.mjs";

// Historical operations remain inspectable, but this panel never resumes provider deletion.
type ErasureApi=(route:string,options?:RequestInit)=>Promise<any>;
type Operation={operationId:string;profile?:string;status:string;phase?:string;
  recoveryStatus?:string;operatorRecoveryRequired?:boolean;message?:string;
  postWriteCompletion?:{completedAt:string;epoch:number;originalMappingCount:number;
    restoredMappingCount:number;tombstoneRetained:boolean;providerDeletesReplayed:boolean}};
type ActionKey="load"|"refreshOperation"|"inspect"|"inspectPostWrite"
  |"confirm"|"confirmDrift"|"apply"|"applyDrift"|"refreshRecovery"|"dispatch";
type ActionResult={action:string;mode:string;at:string;message:string;failed:boolean};
const actionNames:Record<ActionKey,string>={
  load:"Load operation status",refreshOperation:"Refresh operation status",
  inspect:"Inspect guarded recovery",inspectPostWrite:"Inspect post-write evidence",
  confirm:"Request recovery confirmation",confirmDrift:"Request reviewed Calendar-drift cancellation",
  apply:"Confirm guarded recovery",applyDrift:"Confirm reviewed erasure cancellation",
  refreshRecovery:"Refresh recovery status",dispatch:"Retry existing recovery dispatch",
};
const now=()=>new Date().toISOString();
const formatTime=(value?:string)=>value?new Date(value).toLocaleString():"not yet checked";
function terminalPostWriteAssessment(operation?:Operation):any {
  const receipt=operation?.postWriteCompletion;
  if(!receipt)return undefined;
  return {
    operationId:operation!.operationId,profile:operation!.profile,classification:"completed",
    completionEligible:false,completionBlockers:[],blockers:[],onlyAvailableAction:"completed",
    completion:{...receipt,status:"completed",automatic:true,tombstoneRetained:true,
      providerDeletesReplayed:false,fenceReleased:true},
    evidence:{originalProviderWriteIndicated:true,originalCalendarDeletionSelected:true,
      exactTodoistAndCalendarTargetsRecorded:true,matchingFence:true,epochVerified:true,
      leasesDrained:true,providersAbsent:true,stateRowsAbsent:true,mappingStateCount:receipt.originalMappingCount,
      workerMappingsRestored:true,deletionCheckpointComplete:true,projectTombstonePresent:true,
      knownCalendarAliasesComplete:true},
  };
}
function LocalResult({result}:{result?:ActionResult}) {
  const resultRef=useRef<HTMLParagraphElement|null>(null);
  useEffect(()=>{if(result)resultRef.current?.focus({preventScroll:true});},[result?.at]);
  return result?<p ref={resultRef} tabIndex={-1} role={result.failed?"alert":"status"} aria-live="polite"
    className={"recovery-action-result "+(result.failed?"warning":"info")}>
    <strong>{result.action}</strong> · {result.mode} · Completed <time dateTime={result.at}>{formatTime(result.at)}</time>.
    {" "}{result.message}
  </p>:null;
}

export function ErasureRecoveryPanel({api}:{api:ErasureApi}){
  const initialOperationId=useRef(new URLSearchParams(location.search).get("erasureOperation")||"").current;
  const [operationId,setOperationId]=useState(initialOperationId);
  const [operation,setOperation]=useState<Operation>();
  const [operationAt,setOperationAt]=useState<string>();
  const [preview,setPreview]=useState<any>(),[inspectionAt,setInspectionAt]=useState<string>();
  const [postWriteAssessment,setPostWriteAssessment]=useState<any>(),[postWriteAt,setPostWriteAt]=useState<string>();
  const [confirmation,setConfirmation]=useState<any>();
  const [applyReviewReady,setApplyReviewReady]=useState(false);
  const [typed,setTyped]=useState({phrase:"",operationId:"",profile:""});
  const [recoveryStatus,setRecoveryStatus]=useState<string>(),[recoveryAt,setRecoveryAt]=useState<string>();
  const [results,setResults]=useState<Partial<Record<ActionKey,ActionResult>>>({});
  const [busy,setBusy]=useState(false),[pending,setPending]=useState<ActionKey>();
  // Ignore responses from requests issued for an ID that has since been edited.
  const generation=useRef(0);
  const clearOperation=()=>{
    setOperation(undefined);setOperationAt(undefined);
    setPreview(undefined);setInspectionAt(undefined);
    setPostWriteAssessment(undefined);setPostWriteAt(undefined);
    setConfirmation(undefined);setApplyReviewReady(false);
    setTyped({phrase:"",operationId:"",profile:""});
    setRecoveryStatus(undefined);setRecoveryAt(undefined);
    setResults({});setBusy(false);setPending(undefined);
  };
  const changeOperationId=(id:string)=>{
    if(id===operationId)return;
    generation.current++;
    clearOperation();
    setOperationId(id);
  };
  const execute=async(
    key:ActionKey,mode:string,request:()=>Promise<any>,
    succeed:(data:any)=>string,failed:(error:any)=>string,
  )=>{
    if(busy)return;
    const version=generation.current;
    setBusy(true);setPending(key);
    try {
      const data=await request();
      if(version!==generation.current)return;
      const message=succeed(data);
      setResults(value=>({...value,[key]:{action:actionNames[key],mode,at:now(),message,failed:false}}));
    }catch(error:any){
      if(version!==generation.current)return;
      setResults(value=>({...value,[key]:{action:actionNames[key],mode,at:now(),message:failed(error),failed:true}}));
    }finally {
      if(version===generation.current){setBusy(false);setPending(undefined);}
    }
  };
  const messageOf=(error:any,fallback:string)=>error?.message||fallback;
  const lookup=()=>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)||busy)return;
    generation.current++;
    clearOperation();
    const id=operationId;
    void execute("load","Read-only",()=>api("erasure-operations/"+encodeURIComponent(id)),
      result=>{
        setOperation(result.operation);setOperationAt(now());
        setPostWriteAssessment(terminalPostWriteAssessment(result.operation));
        setPostWriteAt(result.operation?.postWriteCompletion?now():undefined);
        setRecoveryStatus(result.operation?.recoveryStatus);setRecoveryAt(undefined);
        if(initialOperationId===id&&!result.operation?.postWriteCompletion){
          const version=generation.current;
          void api("erasure-postwrite-recoveries/"+encodeURIComponent(id)).then(postWrite=>{
            if(version!==generation.current)return;
            setPostWriteAssessment(postWrite.assessment);setPostWriteAt(now());
            const assessment=postWrite.assessment;
            const message=assessment?.classification==="completed"
              ?"Verified post-write completion is complete; no provider deletion was replayed."
              :assessment?.stateCleanupPending
                ?"Automatic post-write state cleanup is pending on the existing watchdog. This read-only inspection does not confirm a worker is currently running."
                :assessment?.completionEligible
                  ?"Automatic post-write completion is eligible; the existing watchdog will finish it without another approval."
                  :`Automatic post-write completion is blocked: ${(assessment?.completionBlockers||assessment?.blockers||[]).join("; ")||"the operation does not meet the verified post-write conditions."}`;
            setResults(value=>({...value,inspectPostWrite:{action:actionNames.inspectPostWrite,
              mode:"Read-only",at:now(),message,failed:false}}));
          }).catch(error=>{
            if(version!==generation.current)return;
            setResults(value=>({...value,inspectPostWrite:{action:actionNames.inspectPostWrite,
              mode:"Read-only",at:now(),message:messageOf(error,"Post-write eligibility could not be verified."),failed:true}}));
          });
        }
        return result.operation?.postWriteCompletion
          ?"Verified post-write cleanup is complete. The original tombstone remains active and no provider delete was replayed."
          :"Operation record loaded. No inspection, recovery execution or provider state changed.";
      },error=>messageOf(error,"Operation lookup failed. No state changed."));
  };
  useEffect(()=>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(initialOperationId))return;
    const section=document.getElementById("erasure-recovery");
    if(section instanceof HTMLDetailsElement)section.open=true;
    lookup();
  },[]);
  const refresh=()=>{
    if(!operation||busy)return;
    const id=operation.operationId;
    setConfirmation(undefined);setApplyReviewReady(false);
    void execute("refreshOperation","Read-only",()=>api("erasure-operations/"+encodeURIComponent(id)),
      result=>{
        setOperation(result.operation);setOperationAt(now());
        setPostWriteAssessment(terminalPostWriteAssessment(result.operation));
        setPostWriteAt(result.operation?.postWriteCompletion?now():undefined);
        setRecoveryStatus(result.operation?.recoveryStatus);setRecoveryAt(undefined);
        return result.operation?.postWriteCompletion
          ?"Verified post-write cleanup is complete. The operation is terminal; no provider delete was replayed."
          :"Operation record refreshed. Existing recovery evidence was not re-inspected; no state changed.";
      },error=>messageOf(error,"Operation status unavailable; no deletion success can be inferred."));
  };
  const inspect=()=>{
    if(!operation||busy)return;
    setConfirmation(undefined);setApplyReviewReady(false);
    void execute("inspect","Read-only",()=>api("erasure-recoveries/"+encodeURIComponent(operation.operationId)),
      result=>{
        setPreview(result.preview);setInspectionAt(now());
        return result.preview?.allowed
          ?"Guarded recovery is eligible. Only the inspection evidence changed; no operation, fence, mapping or provider state changed."
          :"Guarded recovery is blocked. Only the inspection evidence changed; no operation, fence, mapping or provider state changed.";
      },error=>{
        const message=typeof error?.message==="string"?error.message:"";
        return error?.status===401||message.includes("Provider request failed: 401 https://api.todoist.com/")
          ?"Todoist authentication failed (HTTP 401). Check the selected profile's token in AWS Parameter Store, then re-inspect. No recovery was applied; any earlier inspection is historical."
          :"Inspection failed: the provider or recovery service could not be verified. Review protected server logs for details. No recovery was applied; any earlier inspection is historical.";
      });
  };
  const inspectPostWrite=()=>{
    if(!operation||busy)return;
    void execute("inspectPostWrite","Read-only",()=>api("erasure-postwrite-recoveries/"+encodeURIComponent(operation.operationId)),
      result=>{
        setPostWriteAssessment(result.assessment);setPostWriteAt(now());
        return result.assessment?.classification==="completed"
          ?"Verified post-write cleanup completed. Original mappings were restored and the 18-day tombstone remains active."
          :result.assessment?.completionEligible
            ?"Exact known-target evidence is complete. The existing watchdog will automatically finish cleanup; no provider delete will be replayed."
            :"Post-write evidence refreshed. The operation remains fenced until every exact completion condition is satisfied.";
      },error=>messageOf(error,"Post-write inspection failed; fence remains protected."));
  };
  const requestConfirmation=(mode:"strict_pre_write"|"calendar_drift_cancel"="strict_pre_write")=>{
    const drift=mode==="calendar_drift_cancel";
    if(!operation||busy||recoveryStatus||confirmation||!(drift
      ?preview?.calendarDriftReview?.candidateForSeparateApproval===true
      :preview?.allowed===true&&preview.classification==="pre_write"))return;
    const key:ActionKey=drift?"confirmDrift":"confirm";
    setApplyReviewReady(false);
    setTyped({phrase:"",operationId:"",profile:""});
    void execute(key,"Creates operator-bound confirmation token (metadata write)",
      ()=>api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+
        (drift?"/confirm-calendar-drift":"/confirm"),{method:"POST",body:"{}"}),
      result=>{
        setPreview(result.preview);setInspectionAt(now());
        setConfirmation({confirmationId:result.confirmationId,expiresAt:result.expiresAt,
          mode:result.mode||mode});
        return (drift?"Single-use Calendar-drift cancellation":"Single-use strict recovery")+
          " confirmation issued after a new read-only inspection. No sync or provider state changed.";
      },error=>{setConfirmation(undefined);return messageOf(error,"Recovery confirmation failed. No recovery applied.");});
  };
  const canConfirm=()=>{
    if(!operation||!confirmation||recoveryStatus)return false;
    if(confirmation.mode!=="calendar_drift_cancel")
      return canApplyRecovery(preview,confirmation,typed,operation);
    return preview?.calendarDriftReview?.candidateForSeparateApproval===true
      &&preview.classification==="partial_or_ambiguous"
      &&typed.phrase==="CANCEL ERASURE AND RESTORE SYNC"
      &&typed.operationId===operation.operationId
      &&typed.profile===operation.profile
      &&typeof confirmation.confirmationId==="string"
      &&Number(confirmation.expiresAt)>Date.now();
  };
  const apply=()=>{
    if(!operation||busy||!canConfirm())return;
    if(!applyReviewReady){setApplyReviewReady(true);return;}
    setApplyReviewReady(false);
    const drift=confirmation.mode==="calendar_drift_cancel";
    void execute(drift?"applyDrift":"apply","Guarded recovery request (mutating)",
      ()=>api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+
        (drift?"/apply-calendar-drift":"/apply"),{
        method:"POST",body:JSON.stringify({...typed,confirmationId:confirmation.confirmationId}),
      }),result=>{
        setRecoveryStatus(result.recovery?.status||"queued");setRecoveryAt(now());
        setConfirmation(undefined);
        return (drift?"Separately reviewed Calendar-drift cancellation":"Strict guarded recovery")+
          " accepted and queued. No provider deletion was started or resumed; track execution separately.";
      },error=>{setConfirmation(undefined);return messageOf(error,"Recovery was rejected; protections remain in place.");});
  };
  const recoveryRead=async(id:string)=>{
    try{return await api("erasure-recoveries/"+encodeURIComponent(id)+"/status");}
    catch(error:any){
      if(error?.status===404&&error?.data?.error==="recovery_not_started")return {notStarted:true};
      throw error;
    }
  };
  const refreshRecovery=()=>{
    if(!operation||busy)return;
    void execute("refreshRecovery","Read-only",()=>recoveryRead(operation.operationId),
      result=>{
        setRecoveryStatus(result.notStarted?undefined:result.recovery?.status);setRecoveryAt(now());
        return result.notStarted?"Recovery has not started. No execution or provider state changed."
          :"Recovery execution status refreshed: "+(result.recovery?.status||"unknown")+
            (result.recovery?.lastError?"; error recorded (inspect operational logs)":"")+". No state changed.";
      },error=>messageOf(error,"Recovery status unavailable. No state changed."));
  };
  const dispatch=()=>{
    if(!operation||busy||!recoveryNeedsDispatch(recoveryStatus))return;
    void execute("dispatch","Redispatches existing recovery (mutating)",
      ()=>api("erasure-recoveries/"+encodeURIComponent(operation.operationId)+"/dispatch",{method:"POST",body:"{}"}),
      ()=>"Existing guarded recovery redispatched. No provider deletion was queued.",
      error=>messageOf(error,"Recovery dispatch failed. Preserve the fence."));
  };
  useEffect(()=>{
    if(!operation||!recoveryNeedsDispatch(recoveryStatus)||busy)return;
    const id=operation.operationId,version=generation.current;
    const timer=setInterval(()=>{
      void recoveryRead(id).then(result=>{
        if(version!==generation.current)return;
        setRecoveryStatus(result.notStarted?undefined:result.recovery?.status);
        setRecoveryAt(now());
      }).catch(()=>{/* A polling failure is not a recovery outcome; use explicit refresh. */});
    },10000);
    return()=>clearInterval(timer);
  },[operation?.operationId,recoveryStatus,busy]);
  const evidenceRows=recoveryDiagnosticRows(preview);
  const comparisonRows=recoveryComparisonRows(preview);
  const tombstone=recoveryTombstoneStatus(preview);
  const unresolvedRows=evidenceRows.filter(item=>!["verified","unchanged","expected_lifecycle_change"].includes(item.status));
  const executionAt=recoveryAt||operationAt;
  return <details className="preview erasure-recovery" aria-label="Existing erasure operation status and recovery">
    <summary>Existing erasure operation status / recovery</summary>
    <p>Read an already-recorded operation, inspect its safety evidence, or request independently guarded recovery. No action here can resume historical provider deletion.</p>
    <section className="recovery-scope" aria-label="Operation lookup">
      <h4>1. Load a recorded operation</h4>
      <label htmlFor="recovery-operation-id">Recorded operation ID
        <input id="recovery-operation-id" autoComplete="off" value={operationId} onChange={event=>changeOperationId(event.target.value)}/>
      </label>
      <button className="secondary" disabled={busy||!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)}
        onClick={lookup}>Load operation status</button>
      {pending==="load"&&<p role="status" aria-live="polite">Loading the operation record (read-only)…</p>}
      <LocalResult result={results.load}/>
    </section>
    {operation&&<div className="recovery-operation">
      <section className="recovery-scope" aria-label="Authoritative state and operation refresh">
        <h4>2. Operation overview</h4>
        <p>Operation <code>{operation.operationId}</code> · profile <strong>{operation.profile}</strong> · lifecycle phase <strong>{operation.phase||"not recorded"}</strong></p>
        <dl className="recovery-summary">
          <dt>Operation status</dt><dd><strong>{operation.status}</strong> <small>Operation record, {formatTime(operationAt)}</small></dd>
          <dt>Guarded inspection</dt><dd><strong>{inspectionAt?(preview?.allowed?"eligible":"blocked"):"not inspected"}</strong>
            <small>{inspectionAt?"Inspection evidence, "+formatTime(inspectionAt):"No inspection source read yet"}</small></dd>
          <dt>Recovery execution</dt><dd><strong>{recoveryExecutionSummary(recoveryStatus,true)}</strong>
            <small>{recoveryAt?"Recovery endpoint, "+formatTime(recoveryAt):"Operation record, "+formatTime(operationAt)}</small></dd>
          <dt>SQS worker mappings</dt><dd><strong>{workerMappingSummary(preview)}</strong>
            <small>{inspectionAt?"Mapping read during inspection, "+formatTime(inspectionAt):"Unknown until guarded inspection"}</small></dd>
        </dl>
        <button className="secondary" disabled={busy} onClick={refresh}>Refresh operation status</button>
        {pending==="refreshOperation"&&<p role="status" aria-live="polite">Refreshing the operation record (read-only)…</p>}
        <LocalResult result={results.refreshOperation}/>
        {operation.operatorRecoveryRequired&&<p className="warning">{operation.message||"Independent recovery may be required. Never clear a fence manually."}</p>}
      </section>
      {operation.status==="review_required"&&<>
        <section className="recovery-scope" aria-label="Guarded pre-write inspection">
          <h4>3. Inspect guarded recovery (read-only)</h4>
          <p>This re-reads provider, state, fence and mapping evidence. It does not unlock sync, issue confirmation or change the operation. A blocked result is not proof that deletion happened.</p>
          <button disabled={busy} onClick={inspect}>{pending==="inspect"?"Inspecting guarded recovery…":"Inspect guarded recovery"}</button>
          {pending==="inspect"&&<p role="status" aria-live="polite">Inspecting provider and fence evidence (read-only). No recovery changes are being made.</p>}
          <LocalResult result={results.inspect}/>
          {preview&&<div className="recovery-evidence">
            <h5>Last successful guarded inspection · <time dateTime={inspectionAt}>{formatTime(inspectionAt)}</time></h5>
            <p><strong>{preview.allowed?"Eligible for guarded confirmation":"Blocked"}</strong> · phase {preview.phase||"unknown"} · profile {preview.profile}</p>
            <p>{recoveryClassificationExplanation(preview)}</p>
            <h5>Original expectation vs current read (no identifiers or contents)</h5>
            {comparisonRows.length>0
              ?<ul className="recovery-diagnostics">{comparisonRows.map(item=>
                <li key={item.key}>
                  <strong>{item.label}</strong> — <strong>{item.result.replaceAll("_"," ")}</strong>
                  <div>Expected: {item.expected}</div>
                  <div>Current read: {item.observed}</div>
                  <div>{item.explanation}</div>
                </li>)}</ul>
              :<p>Comparison details were not returned by this API deployment. Do not infer that differences are safe deletion effects.</p>}
            <h5>Exact recorded Todoist project-comment tombstone</h5>
            <p><strong>{tombstone.status.replaceAll("_"," ")}</strong> · recorded comment found:
              {" "}{tombstone.recordedCommentFound===null?"not checked":tombstone.recordedCommentFound?"yes":"no"}
              {" "}· marker matches operation task and Calendar aliases:
              {" "}{tombstone.markerMatchesTaskAndCalendar===null?"not checked":tombstone.markerMatchesTaskAndCalendar?"yes":"no"}
            </p>
            <p>{tombstone.explanation}</p>
            <p>Tombstones are bounded to 18 days. A present marker is only one safeguard; it cannot override missing provider, state, fence, invocation or rollback evidence.</p>
            <h5>Independent recovery guard</h5>
            <p className="warning">{recoveryIndependentGuard(preview)}</p>
            {preview.calendarDriftReview?.candidateForSeparateApproval&&<p role="status" className="warning">
              Calendar-only provider revision is eligible for a separately confirmed cancellation path. Inspection has made no changes: the Work fence and mapping remain protected. Review all evidence below before requesting the distinct operator-bound cancellation token.
            </p>}
            {!preview.allowed&&<>
              <h5>Why the evidence is insufficient</h5>
              <p>Each status describes the latest read-only check, not permission to override a guard. Expected lifecycle change is an observed, checkpoint-consistent difference, not proof of safe recovery. Missing evidence and unexpected drift remain blocked.</p>
              <ul className="recovery-diagnostics">{unresolvedRows.length?unresolvedRows.map(item=>
                <li key={item.key}><strong>{item.label}</strong> — {item.status.replaceAll("_"," ")}</li>)
                :<li>No individual mismatch was identified in the available checks; inspect the guard blockers below.</li>}</ul>
              <p className="warning"><strong>Next safe action:</strong> {recoveryNextSafeAction(preview)}</p>
            </>}
            <details className="recovery-technical">
              <summary>Technical details and all read-only checks</summary>
              <ul className="recovery-diagnostics">{evidenceRows.map(item=>
                <li key={item.key}><strong>{item.label}</strong> — {item.status}</li>)}</ul>
              <dl className="recovery-summary">
                <dt>Classification</dt><dd>{preview.classification}</dd>
                <dt>Fence owned</dt><dd>{preview.fenceOwned?"yes":"no"}</dd>
                <dt>Active leases</dt><dd>{preview.leaseCount}</dd>
                <dt>Provider items absent</dt><dd>{preview.providerItemsAbsent?"yes":"no"}</dd>
                <dt>Attributable state absent</dt><dd>{preview.stateRowsAbsent?"yes":"no"}</dd>
                <dt>Exact Todoist readback</dt><dd>{preview.knownTargetReadback?.todoist||"unknown"}</dd>
                <dt>Exact Calendar readback</dt><dd>{preview.knownTargetReadback?.calendar||"unknown"}</dd>
              </dl>
              <p>{originalInventoryExplanation}</p>
              {preview.blockers?.length>0&&<><h5>Server safety blockers</h5>
                <ul>{preview.blockers.map((text:string,i:number)=><li key={i} className="warning">{text}</li>)}</ul></>}
            </details>
          </div>}
        </section>
        <section className="recovery-scope" aria-label="Guarded recovery confirmation and execution">
          <h4>4. Request and apply guarded recovery (writes only after verification)</h4>
          <p>Strict RESTORE SYNC requires a verified pre-write inspection. A Calendar-only revision may instead qualify for a <strong>separate, explicitly reviewed erasure cancellation</strong>, with its own token and typed phrase. The backend rechecks all guards before and during recovery.</p>
          {preview?.allowed===true&&preview.classification==="pre_write"&&!recoveryStatus&&!confirmation&&
            <button disabled={busy} onClick={()=>requestConfirmation("strict_pre_write")}>Request recovery confirmation</button>}
          {preview?.calendarDriftReview?.candidateForSeparateApproval===true&&!recoveryStatus&&!confirmation&&<>
            <p><strong>Reviewed Calendar-drift cancellation available.</strong> This cancels the interrupted erasure while keeping both provider items. It does not delete either item; the server must still verify the exact current Calendar revision, unchanged Todoist task, mappings, fence, epoch and state before acceptance and at each worker transition.</p>
            <button disabled={busy} onClick={()=>requestConfirmation("calendar_drift_cancel")}>Request reviewed Calendar-drift cancellation</button>
          </>}
          {(pending==="confirm"||pending==="confirmDrift")&&<p role="status" aria-live="polite">Issuing an operator-bound confirmation token; no sync restoration yet…</p>}
          <LocalResult result={results.confirm}/>
          <LocalResult result={results.confirmDrift}/>
          {confirmation&&!recoveryStatus&&
            (confirmation.mode==="calendar_drift_cancel"
              ?preview?.calendarDriftReview?.candidateForSeparateApproval===true
              :preview?.allowed===true&&preview.classification==="pre_write")&&<>
            <p>Single-use confirmation expires <time dateTime={new Date(confirmation.expiresAt).toISOString()}>{new Date(confirmation.expiresAt).toLocaleString()}</time>.</p>
            <label>Type {confirmation.mode==="calendar_drift_cancel"?"CANCEL ERASURE AND RESTORE SYNC":"RESTORE SYNC"}<input value={typed.phrase} autoComplete="off" onChange={event=>{setTyped(value=>({...value,phrase:event.target.value}));setApplyReviewReady(false);}}/></label>
            <label>Repeat operation ID<input value={typed.operationId} autoComplete="off" onChange={event=>{setTyped(value=>({...value,operationId:event.target.value}));setApplyReviewReady(false);}}/></label>
            <label>Repeat profile<input value={typed.profile} autoComplete="off" onChange={event=>{setTyped(value=>({...value,profile:event.target.value}));setApplyReviewReady(false);}}/></label>
            {applyReviewReady&&<div role="alert" aria-live="assertive" className="warning">
              <strong>Review the final recovery action.</strong>
              <p>{confirmation.mode==="calendar_drift_cancel"
                ?"This cancels the interrupted erasure, keeps the current Calendar event revision and Todoist task, and restores only the originally enabled sync mapping. It never resumes provider deletion. The server will recheck the evidence."
                :"This restores synchronization for exactly this profile. It does not resume or undo provider deletion; the server will recheck every safety condition."}</p>
              <button type="button" disabled={busy} onClick={()=>setApplyReviewReady(false)}>Cancel final confirmation</button>
            </div>}
            <button disabled={busy||!canConfirm()} onClick={apply}>
              {applyReviewReady
                ?confirmation.mode==="calendar_drift_cancel"?"Apply reviewed erasure cancellation":"Apply guarded recovery"
                :confirmation.mode==="calendar_drift_cancel"?"Review erasure cancellation":"Review guarded recovery"}
            </button>
          </>}
          {(pending==="apply"||pending==="applyDrift")&&<p role="status" aria-live="polite">Applying independently verified recovery guards…</p>}
          <LocalResult result={results.apply}/>
          <LocalResult result={results.applyDrift}/>
          {preview&&!preview.allowed&&!preview.calendarDriftReview?.candidateForSeparateApproval&&
            <p>Recovery confirmation is not offered while the independent safety guards are blocked.</p>}
        </section>
        <details className="recovery-scope recovery-postwrite" open={Boolean(postWriteAssessment)}>
          <summary>5. Post-write evidence and automatic completion</summary>
          <p>Inspection is read-only. The existing erasure watchdog automatically completes a fully verified post-write operation: it restores only the originally enabled mappings, then atomically removes the operation-owned fence. It never repeats a Todoist or Calendar delete and does not require a separate per-operation signoff. An active fence by itself does not establish eligibility; inspect the evidence below for eligibility or its concrete blockers.</p>
          <button className="secondary" disabled={busy} onClick={inspectPostWrite}>Inspect post-write evidence</button>
          {pending==="inspectPostWrite"&&<p role="status" aria-live="polite">Reading exact post-write evidence only…</p>}
          <LocalResult result={results.inspectPostWrite}/>
          {postWriteAssessment&&<div className="recovery-evidence">
            <h5>Post-write result · <time dateTime={postWriteAt}>{formatTime(postWriteAt)}</time></h5>
            {postWriteAssessment.classification==="completed"?
              <p role="status">Cleanup completed at {formatTime(postWriteAssessment.completion?.completedAt)}. The original worker mapping states were restored, the operation-owned fence was released, no provider delete was replayed, and the 18-day project-comment tombstone was left untouched for normal expiry cleanup.</p>
              :<>
                <p>Classification: <strong>{postWriteAssessment.classification?.replaceAll("_"," ")}</strong> · profile {postWriteAssessment.profile} · automatic completion: <strong>{postWriteAssessment.stateCleanupPending?"state cleanup pending":postWriteAssessment.completionEligible?"eligible":"blocked"}</strong></p>
                <p>Write evidence recorded: {postWriteAssessment.evidence?.originalProviderWriteIndicated?"yes":"no"} · exact targets recorded: {postWriteAssessment.evidence?.exactTodoistAndCalendarTargetsRecorded?"yes":"no"} · active fence owned: {postWriteAssessment.evidence?.matchingFence?"yes":"no"} · leases drained: {postWriteAssessment.evidence?.leasesDrained?"yes":"no"} · tombstone verified: {postWriteAssessment.evidence?.projectTombstonePresent?"yes":"no"} · deletion checkpoints complete: {postWriteAssessment.evidence?.deletionCheckpointComplete?"yes":"no"}</p>
                {postWriteAssessment.stateCleanupPending?
                  <p role="status">The exact provider targets are already absent. The original DynamoDB state checkpoint is pending for the existing watchdog; this read-only inspection does not confirm that a worker is currently running. The watchdog processes only recorded state entries (including eligible delivery-receipt scrubbing), up to ten per run, and never replays a Todoist or Calendar delete. Re-inspect after the next scheduled watchdog run; uncertain attempts or inventory drift remain fenced.</p>
                  :postWriteAssessment.completionEligible?
                    <p role="status">All operation-scoped evidence is satisfied. The existing scheduled watchdog will finish cleanup automatically; no new queue or per-operation approval is needed.</p>
                    :<p className="warning">The operation remains fenced. The watchdog will not restore sync or release the fence while any completion condition is uncertain.</p>}
                {!postWriteAssessment.stateCleanupPending&&postWriteAssessment.completionBlockers?.length>0&&<details className="recovery-technical">
                  <summary>Post-write completion blockers</summary>
                  <ul>{postWriteAssessment.completionBlockers.map((text:string,i:number)=><li key={i} className="warning">{text}</li>)}</ul>
                </details>}
              </>}
          </div>}
        </details>
        <section className="recovery-scope" aria-label="Recovery execution status">
          <h4>6. Track recovery execution (read-only status)</h4>
          <p>Inspection eligibility is not execution. The execution endpoint reports queued, restoring, verifying, completed or blocked; the operation record may report that no recovery has started.</p>
          <button className="secondary" disabled={busy} onClick={refreshRecovery}>Refresh recovery status</button>
          {pending==="refreshRecovery"&&<p role="status">Refreshing execution state (read-only)…</p>}
          <LocalResult result={results.refreshRecovery}/>
          {recoveryNeedsDispatch(recoveryStatus)&&<button className="secondary" disabled={busy} onClick={dispatch}>Retry existing recovery dispatch</button>}
          {pending==="dispatch"&&<p role="status">Redispatching existing recovery…</p>}
          <LocalResult result={results.dispatch}/>
        </section>
      </>}
    </div>}
  </details>;
}
