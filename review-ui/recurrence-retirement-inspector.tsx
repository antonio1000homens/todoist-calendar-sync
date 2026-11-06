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
  providerWrites:false;
};
type PlannedRecord = {pk:string;sk:string;recordFingerprint:string;rationale:string};
type Preview = {
  scope:"whole_ended_calendar_series"; mode:"keep_provider_items";
  inspectedAt:string;inspectionFingerprint:string;planFingerprint:string;
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

/**
 * Non-actionable diagnostics have no ReviewCase. Inspect their exact recorded
 * identity in-place, with independent provider reads. There is intentionally
 * NO apply control: the transactional exclusion/undo worker is not implemented.
 */
export function RecurrenceRetirementInspector({
  api,item,generation,profile,
}:{api:Api;item:Diagnostic;generation:string;profile:string}) {
  const [opened,setOpened]=useState(false);
  const [busy,setBusy]=useState(false);
  const [inspection,setInspection]=useState<Inspection>();
  const [preview,setPreview]=useState<Preview>();
  const [error,setError]=useState("");
  const sequence=useRef(0);
  useEffect(()=>()=>{sequence.current++;},[]);
  const inspect=async()=>{
    const request=++sequence.current;
    setOpened(true);setBusy(true);setError("");setInspection(undefined);setPreview(undefined);
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
      {busy&&<p role="status">Verifying exact recurrence, completion, ownership and audit references…</p>}
      {error&&<p className="warning" role="alert">{error}. No retirement operation was authorized.</p>}
      {inspection&&<>
        <dl className="overview-grid">
          <dt>Profile / scope</dt><dd>{profile} · whole series inspection (not an individual occurrence action)</dd>
          <dt>Todoist</dt><dd><code>{item.taskId}</code> · {inspection.task.status}
            {inspection.task.value?.content&&<> · {inspection.task.value.content}</>}</dd>
          <dt>Calendar master</dt><dd><code>{inspection.calendar.master?.id||"Not verified"}</code> · {inspection.calendar.master?.summary||"No title"}</dd>
          <dt>Calendar occurrence</dt><dd><code>{item.eventId}</code> · {inspection.calendar.occurrence?.status||"Not verified"}</dd>
          <dt>Series</dt><dd><code>{item.seriesId}</code></dd>
          <dt>Recurrence rule</dt><dd>{inspection.calendar.master?.recurrence?.join(", ")||"Unverified"}</dd>
          <dt>Instance count</dt><dd>{inspection.calendar.instances.length} (including cancelled exceptions)</dd>
          <dt>Completed task evidence</dt><dd>{inspection.task.value?.completed_at||"Not verified"} · {inspection.task.source}</dd>
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
        </section>}
        <p className="notice">This preview never changes state or providers and is not an approval token. Apply and Undo are unavailable until conditional atomic retirement, durable replay suppression and scoped cleanup are implemented and tested.</p>
      </>}
    </section>}
  </div>;
}
