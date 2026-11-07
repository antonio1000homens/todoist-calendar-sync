import React, { useEffect, useRef, useState } from "react";

type Diagnostic = {
  profile: string; generation?:string; taskId?:string; eventId?:string;
  seriesId?:string; action:string; reason:string;
};
type Inspection = {
  target:{profile:string;generation:string;taskId:string;eventId:string;seriesId:string};
  checkedAt:string; task:{status:string;value?:any;source:string};
  calendar:{master?:any;occurrence?:any;instances:any[];source:string};
  mapping?:any; recurrenceLink?:any; completionHistory:any[]; terminalSeries?:any;
  indexKeys:string[]; historicalRowCounts:Record<string,number>;
  otherProfileReferences:Array<{profile:string;key:string}>;
  blockers:string[]; eligibleForFutureApproval:boolean; previewFingerprint:string;
  retirementEvidenceMode?:"verified_completion"|"past_due_active_task_operator_override";
  providerWrites:false;
};
type PlannedRecord = {pk:string;sk:string;recordFingerprint:string;rationale:string};
type Preview = {
  scope:"whole_ended_calendar_series"; mode:"keep_provider_items";
  inspectedAt:string;inspectionFingerprint:string;planFingerprint:string;
  evidenceMode?:"verified_completion"|"past_due_active_task_operator_override";
  status:"reviewable"|"blocked";blockers:string[];
  indexRemovalCandidates:PlannedRecord[];
  conditionalCleanupCandidates:PlannedRecord[];
  incidentEvidenceForSeparateReview:PlannedRecord[];
  protectedRecords:PlannedRecord[];
  futureSuppressionIdentityKeys:string[];
  providerMetadataHazards:string[];
  providerWrites:false;stateWrites:false;applyAvailable:false;
};
type Api = (path:string,options?:any)=>Promise<any>;
type RetirementStatus = {
  operationId:string; profile:string;status:string;createdAt:string;
  retiredAt?:string;cleanupStatus?:string;
  target:{taskId:string;eventId:string;seriesId:string};
  planFingerprint:string;profileFenceActive?:boolean;
};
type RetirementApproval = {operation:RetirementStatus;confirmationId:string;phrase:string};
type UndoInspection = {
  eligible:boolean;blockers:string[];fingerprint:string;operationId:string;profile:string;
  markerKeys:string[];providerWrites:false;
};
type UndoApproval = {operationId:string;confirmationId:string;phrase:string;inspection:UndoInspection};

/**
 * Non-actionable diagnostics have no ReviewCase. Inspect their exact recorded
 * identity in-place, with independent provider reads. There is intentionally
 * Approval and Undo are independent, typed operator actions. No provider
 * objects are created, modified or deleted on either path.
 */
export function RecurrenceRetirementInspector({
  api,item,generation,profile,
}:{api:Api;item:Diagnostic;generation:string;profile:string}) {
  const [opened,setOpened]=useState(false);
  const [busy,setBusy]=useState(false);
  const [inspection,setInspection]=useState<Inspection>();
  const [preview,setPreview]=useState<Preview>();
  const [approval,setApproval]=useState<RetirementApproval>();
  const [retirementStatus,setRetirementStatus]=useState<RetirementStatus>();
  const [confirmPhrase,setConfirmPhrase]=useState("");
  const [undoInspection,setUndoInspection]=useState<UndoInspection>();
  const [undoApproval,setUndoApproval]=useState<UndoApproval>();
  const [undoPhrase,setUndoPhrase]=useState("");
  const [cleanupStatus,setCleanupStatus]=useState("");
  const [error,setError]=useState("");
  const sequence=useRef(0);
  useEffect(()=>()=>{sequence.current++;},[]);
  const inspect=async()=>{
    const request=++sequence.current;
    setOpened(true);setBusy(true);setError("");setInspection(undefined);setPreview(undefined);
    setApproval(undefined);setRetirementStatus(undefined);setUndoInspection(undefined);setUndoApproval(undefined);
    try {
      const query=new URLSearchParams({
        profile,generation,taskId:item.taskId||"",eventId:item.eventId||"",seriesId:item.seriesId||"",
      });
      const data=await api("reconciliation/retirement-inspection?"+query.toString());
      if(request===sequence.current)setInspection(data.inspection);
    } catch(e:any) {
      if(request===sequence.current)setError(e?.message||"Inspection failed");
    } finally {if(request===sequence.current)setBusy(false);}
  };
  const showPreview=async()=>{
    const request=++sequence.current;
    setBusy(true);setError("");setPreview(undefined);
    setApproval(undefined);setUndoInspection(undefined);setUndoApproval(undefined);
    try {
      const query=new URLSearchParams({
        profile,generation,taskId:item.taskId||"",eventId:item.eventId||"",seriesId:item.seriesId||"",
      });
      // Independent fresh readback: never re-use the earlier inspection as an
      // approval, even when the same ID and unchanged timestamp are displayed.
      const data=await api("reconciliation/retirement-preview?"+query.toString());
      if(request===sequence.current) {
        setInspection(data.inspection);
        setPreview(data.preview);
      }
    } catch(e:any) {
      if(request===sequence.current)setError(e?.message||"Retirement preview failed");
    } finally {if(request===sequence.current)setBusy(false);}
  };
  const requestRetirementApproval=async()=>{
    if(!preview||preview.status!=="reviewable")return;
    setBusy(true);setError("");setApproval(undefined);
    try{
      const body={profile,generation,taskId:item.taskId,eventId:item.eventId,
        seriesId:item.seriesId,planFingerprint:preview.planFingerprint};
      const result=await api("reconciliation/retirement-approvals",
        {method:"POST",body:JSON.stringify(body)});
      setApproval(result);setRetirementStatus(result.operation);setConfirmPhrase("");
    }catch(e:any){setError(e.message||"Retirement approval failed");}
    finally{setBusy(false);}
  };
  const applyRetirement=async()=>{
    if(!approval||confirmPhrase!==approval.phrase)return;
    setBusy(true);setError("");
    try{
      const body={profile,operationId:approval.operation.operationId,
        confirmationId:approval.confirmationId,phrase:confirmPhrase};
      const result=await api("reconciliation/retirement-apply",
        {method:"POST",body:JSON.stringify(body)});
      setRetirementStatus(result.operation);
      if(result.operation.status==="retired")setApproval(undefined);
    }catch(e:any){setError(e.message||"Retirement Apply failed");}
    finally{setBusy(false);}
  };
  const inspectUndo=async()=>{
    if(!retirementStatus)return;
    setBusy(true);setError("");setUndoApproval(undefined);setUndoInspection(undefined);
    try {
      const result=await api("reconciliation/retirement-undo-inspection?"+
        new URLSearchParams({operationId:retirementStatus.operationId}).toString());
      setUndoInspection(result.inspection);
    }catch(e:any){setError(e.message||"Re-enable inspection failed");}
    finally{setBusy(false);}
  };
  const approveUndo=async()=>{
    if(!retirementStatus||!undoInspection?.eligible)return;
    setBusy(true);setError("");
    try{
      const body={operationId:retirementStatus.operationId,profile,
        fingerprint:undoInspection.fingerprint};
      const result=await api("reconciliation/retirement-undo-approvals",
        {method:"POST",body:JSON.stringify(body)});
      setUndoApproval(result);setUndoPhrase("");
    }catch(e:any){setError(e.message||"Re-enable approval failed");}
    finally{setBusy(false);}
  };
  const applyUndo=async()=>{
    if(!undoApproval||!retirementStatus||undoPhrase!==undoApproval.phrase)return;
    setBusy(true);setError("");
    try{
      const body={operationId:retirementStatus.operationId,profile,
        confirmationId:undoApproval.confirmationId,phrase:undoPhrase};
      const result=await api("reconciliation/retirement-undo-apply",
        {method:"POST",body:JSON.stringify(body)});
      setRetirementStatus(current=>current?{...current,status:result.operation.status}:current);
      if(result.operation.status==="re_enabled")setUndoApproval(undefined);
    }catch(e:any){setError(e.message||"Re-enable Apply failed");}
    finally{setBusy(false);}
  };
  const cleanupIncidents=async()=>{
    if(!retirementStatus||retirementStatus.status!=="retired")return;
    setBusy(true);setError("");
    try{
      const result=await api("reconciliation/retirement-cleanup",{method:"POST",
        body:JSON.stringify({profile,operationId:retirementStatus.operationId})});
      setCleanupStatus("Removed "+result.cleanup.deletedAudits+" exclusively attributable audit entries; "+
        result.cleanup.protectedRecords+" protected rows retained.");
      setRetirementStatus(current=>current?{...current,cleanupStatus:result.cleanup.status}:current);
    }catch(e:any){setError(e.message||"Cleanup was blocked; no partial cleanup recorded");}
    finally{setBusy(false);}
  };
  const records=(title:string,items:PlannedRecord[])=> <details>
    <summary>{title} ({items.length})</summary>
    {items.length?<ul>{items.map(item=><li key={item.pk+"|"+item.sk}>
      <code>{item.pk}/{item.sk}</code> — {item.rationale}
      <small> · state revision <code>{item.recordFingerprint.slice(0,12)}…</code></small>
    </li>)}</ul>:<p>No matching records found in this inventory.</p>}
  </details>;
  if(item.action!=="todoist_snapshot_reconcile_recurring_deferred"
    ||item.reason!=="recurrence_owned_mapping_deferred"
    ||!item.taskId||!item.eventId||!item.seriesId)return null;
  return <div className="retirement-inspection">
    <button type="button" className="secondary" onClick={inspect} disabled={busy}>
      {busy?"Inspecting provider and state evidence…":inspection?"Refresh mapping inspection":"Inspect mapping"}
    </button>
    {opened&&<section className="preview" aria-label="Operator recurrence retirement inspection">
      <h4>Retire association (keep provider items) — safety inspection</h4>
      <p>This diagnostic has no actionable review case. Inspection uses fresh Todoist and Google Calendar reads and a strongly consistent state inventory. It does not modify either provider or DynamoDB.</p>
      {busy&&<p role="status">Verifying exact recurrence, provider state, ownership and audit references…</p>}
      {error&&<p className="warning" role="alert">{error}. No retirement operation was authorized.</p>}
      {inspection&&<>
        <dl className="overview-grid">
          <dt>Profile / scope</dt><dd>{profile} · whole series inspection (not an individual occurrence action)</dd>
          <dt>Todoist</dt><dd><code>{item.taskId}</code> · {inspection.task.status}
            {inspection.task.value?.content&&<> · {inspection.task.value.content}</>}</dd>
          <dt>Todoist due / version</dt><dd>{inspection.task.value?.due?.datetime||inspection.task.value?.due?.date||"No due date"}
            {inspection.task.value?.updated_at&&<> · updated {inspection.task.value.updated_at}</>}</dd>
          <dt>Calendar master</dt><dd><code>{inspection.calendar.master?.id||"Not verified"}</code> · {inspection.calendar.master?.summary||"No title"}</dd>
          <dt>Calendar occurrence</dt><dd><code>{item.eventId}</code> · {inspection.calendar.occurrence?.status||"Not verified"}</dd>
          <dt>Series</dt><dd><code>{item.seriesId}</code></dd>
          <dt>Recurrence rule</dt><dd>{inspection.calendar.master?.recurrence?.join(", ")||"Unverified"}</dd>
          <dt>Instance count</dt><dd>{inspection.calendar.instances.length} (including cancelled exceptions)</dd>
          <dt>Provider task evidence</dt><dd>{inspection.task.value?.completed_at||inspection.task.value?.updated_at||"Not verified"} · {inspection.task.source}</dd>
          <dt>Terminal-series marker</dt><dd>{inspection.terminalSeries?.terminalCompletedAt||"Absent or unverified"}</dd>
          <dt>Mapping revision</dt><dd>{inspection.mapping?.updatedAt||"Missing"}</dd>
          <dt>Recurrence link revision</dt><dd>{inspection.recurrenceLink?.updatedAt||"Missing"}</dd>
          <dt>Assessment time</dt><dd>{new Date(inspection.checkedAt).toLocaleString()}</dd>
        </dl>
        {inspection.blockers.length?
          <div className="warning" role="status"><strong>Retirement not eligible</strong>
            <ul>{inspection.blockers.map((reason,i)=><li key={i}>{reason}</li>)}</ul>
          </div>
          :<p className="notice">No safety blockers detected by this inspection. This is NOT authorization or a durable approval to retire a mapping.</p>}
        <details><summary>Exact mappings, recurrence history and references</summary>
          <p><strong>Current mapping</strong></p><pre>{JSON.stringify(inspection.mapping||null,null,2)}</pre>
          <p><strong>Recurrence link</strong></p><pre>{JSON.stringify(inspection.recurrenceLink||null,null,2)}</pre>
          <p><strong>Historical completion records (preserved)</strong></p><pre>{JSON.stringify(inspection.completionHistory,null,2)}</pre>
          <p><strong>State keys potentially attributable to this relationship</strong></p>
          <ul>{inspection.indexKeys.map(key=><li key={key}><code>{key}</code></li>)}</ul>
          <p><strong>Other-profile or successor ownership references</strong></p>
          <pre>{JSON.stringify(inspection.otherProfileReferences,null,2)}</pre>
          <p><strong>Related record categories (not a deletion plan)</strong></p><pre>{JSON.stringify(inspection.historicalRowCounts,null,2)}</pre>
          <p>Version fingerprint: <code>{inspection.previewFingerprint}</code></p>
        </details>
        <div className="actions">
          <button type="button" className="secondary" onClick={showPreview} disabled={busy}>
            {busy?"Rechecking full provider/state inventory…":"Preview retirement effect"}
          </button>
        </div>
        {preview&&<section aria-label="Retirement effect preview">
          <h4>Whole-series association retirement preview</h4>
          <p>Action: <strong>Retire mapping, keep provider items</strong>. No Todoist or Calendar objects, content, due dates, recurrence rules or shared metadata are modified.</p>
          <p>Fresh assessment: <strong>{preview.status==="reviewable"?"Reviewable (not approved)":"Blocked"}</strong> · {new Date(preview.inspectedAt).toLocaleString()}</p>
          {preview.blockers.length>0&&<div className="warning" role="status">
            <strong>Retirement blocked</strong><ul>{preview.blockers.map((value,i)=><li key={i}>{value}</li>)}</ul>
          </div>}
          {records("Mapping and recurrence link proposed for conditional retirement",preview.indexRemovalCandidates)}
          {records("Task baseline and canonical rows that need exact revision checks",preview.conditionalCleanupCandidates)}
          {records("Audit, conflict and repair evidence requiring separate ownership review",preview.incidentEvidenceForSeparateReview)}
          {records("Protected history and other state that must be retained",preview.protectedRecords)}
          <details><summary>Required future re-sync suppression and provider metadata hazards</summary>
            <p>Future Apply must create durable scope-specific exclusion keys:</p>
            <ul>{preview.futureSuppressionIdentityKeys.map(value=><li key={value}><code>{value}</code></li>)}</ul>
            <ul>{preview.providerMetadataHazards.map((value,i)=><li key={i}>{value}</li>)}</ul>
          </details>
          <p>Preview version: <code>{preview.planFingerprint}</code></p>
          {preview.status==="reviewable"&&!retirementStatus&&<div>
            <p><strong>Operator approval required.</strong> This retires only the whole-series mapping and prevents future syncing of those exact identities. {preview.evidenceMode==="past_due_active_task_operator_override"
              ?<>The Todoist task is still active. Its exact provider record says it is non-recurring and due more than seven days ago, and the complete Calendar series has ended. Apply will leave the task open and disconnect only this association; check the task identity and due date above before approving.</>
              :<>When the legacy terminal-series certificate is absent, approval is available only with direct proof that this exact Todoist task completed over seven days ago, matching immutable occurrence history, and a complete Calendar series with no future instances.</>} Both provider objects are retained without editing their metadata.</p>
            <button type="button" disabled={busy} onClick={requestRetirementApproval}>Request retirement approval token</button>
          </div>}
        </section>}
        {approval&&<section className="preview" aria-label="Confirm whole-series retirement">
          <h4>Confirm retirement — keep both provider items</h4>
          <p>The current mapping and selected history will be removed conditionally. {approval.phrase.includes("ACTIVE TASK")
            ?<>This approval explicitly retires an active Todoist task association because the exact task is non-recurring and its due date is over seven days past, and the complete Calendar series has ended. The task will stay open.</>
            :<>This approval acknowledges that a legacy terminal-series certificate may be absent; fresh Todoist completion, immutable occurrence history and a complete ended Calendar series are required before Apply.</>} Todoist task <code>{item.taskId}</code> and Calendar series <code>{item.seriesId}</code> will <strong>not</strong> be deleted, rescheduled, completed or edited. Further sync of these identities is disabled until a separate re-enable operation.</p>
          <label>Type this exact phrase to authorise retirement: <code>{approval.phrase}</code>
            <input aria-label="Retirement confirmation phrase" value={confirmPhrase}
              onChange={e=>setConfirmPhrase(e.target.value)} />
          </label>
          <button type="button" onClick={applyRetirement}
            disabled={busy||confirmPhrase!==approval.phrase}>
            {retirementStatus?.status==="fencing"?"Retry fenced Apply":"Apply retirement"}
          </button>
          <button type="button" className="secondary" onClick={()=>setApproval(undefined)} disabled={busy}>Cancel</button>
        </section>}
        {retirementStatus&&<section className="preview" aria-label="Retirement operation status">
          <h4>{retirementStatus.status==="retired"?"Association retired by operator":
            retirementStatus.status==="re_enabled"?"Association syncing re-enabled":
              "Retirement operation: "+retirementStatus.status.replaceAll("_"," ")}</h4>
          <p>Operation <code>{retirementStatus.operationId}</code>; provider items remain unchanged.</p>
          {retirementStatus.status==="fencing"&&<p className="notice">Waiting for prior profile workers to finish. Retry Apply using the same approval; no provider writes are performed.</p>}
          {retirementStatus.cleanupStatus==="pending"&&<p className="notice">Attributable incident cleanup is pending. Historical completion/replay evidence remains protected.</p>}
          {retirementStatus.status==="retired"&&retirementStatus.cleanupStatus!=="completed"&&
            <button type="button" className="secondary" disabled={busy} onClick={cleanupIncidents}>
              Clean exclusively attributable incident evidence
            </button>}
          {cleanupStatus&&<p role="status">{cleanupStatus}</p>}
          {retirementStatus.status==="retired"&&<button className="secondary" disabled={busy} type="button" onClick={inspectUndo}>
            Inspect re-enable syncing
          </button>}
          {undoInspection&&<div>
            <h5>Re-enable verification</h5>
            {undoInspection.blockers.length>0?
              <ul>{undoInspection.blockers.map((reason,i)=><li key={i} className="warning">{reason}</li>)}</ul>
              :<p>Provider identity and exclusion markers were freshly verified. Undo will remove only this retirement’s suppression, not restore a mapping.</p>}
            {undoInspection.eligible&&!undoApproval&&<button type="button" disabled={busy} onClick={approveUndo}>Request re-enable approval token</button>}
          </div>}
          {undoApproval&&<div>
            <label>Type this phrase to re-enable syncing without restoring old mapping: <code>{undoApproval.phrase}</code>
              <input aria-label="Re-enable confirmation phrase" value={undoPhrase}
                onChange={e=>setUndoPhrase(e.target.value)} />
            </label>
            <button type="button" disabled={busy||undoPhrase!==undoApproval.phrase} onClick={applyUndo}>Confirm re-enable syncing</button>
          </div>}
        </section>}
        <p className="notice">Inspection and Preview never mutate state or providers. Apply and re-enable require separate, version-bound operator approvals; both preserve the original Todoist and Google Calendar items.</p>
      </>}
    </section>}
  </div>;
}
