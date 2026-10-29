import React, { useEffect, useRef, useState } from "react";
import { createReviewApiClient, createRetryingTask, isAbortError, reconciliationPollDelayMs } from "./api-client.mjs";
import { emptyRepairSelection, reconcileRepairSelection, editRepairSelection, repairPreviewAllowed, repairRecurrenceOwnerRequirement, repairValidationField, missingDispositionReference, operationResumeEligibility } from "./repair-selection.mjs";
import { createRoot } from "react-dom/client";
import { ErasurePanel } from "./erasure-panel";
import { providerIdentity, dispositionOptions, scopeLabel, previewEffect } from "./item-identity.mjs";
import { caseUrl, caseIdentityState, dispositionGuidance, snapshotRelationship, groupAffectedSnapshots } from "./case-url.mjs";

type Case = { id:string; profile:string; title:string; reason:string; status:string; taskId?:string; eventId?:string; createdAt:string; updatedAt?:string; decision?:any; operationId?:string; result?:string; reconciliationGeneration?:string; progressCheckpoint?:any };
type ProviderObject = { id:string; content?:string; summary?:string; description?:string; url?:string; htmlLink?:string; due?:{date?:string;datetime?:string;string?:string;is_recurring?:boolean}; start?:{date?:string;dateTime?:string}; end?:{date?:string;dateTime?:string}; recurrence?:string[]; recurringEventId?:string; status?:string };
type FutureSplitPreview = { originalRule:string; truncatedRule:string; newStart:string; newRule:string; calendarTimeZone?:string; expiredUntil?:string; previousOccurrence?:string; historicalLastOccurrence?:string };
type RepairPreview = { id:string; intent:any; snapshots:any[]; changes:string[]; warnings:string[]; expiresAt:number; itemPlan:Array<{ref:{profile:string;side:"todoist"|"calendar";id:string};operation:string;result:string}>; splitPlan?:FutureSplitPreview };
type RepairOperation = { id:string; attempt:number; status:string; abandoned?:boolean; error?:string; nextAction?:string; notificationText?:string; steps:Record<string,{status:string}>; outcomes?:Array<{entity:string;outcome:string}> };
const profiles = ["all","home","antonio","work"];
const api = createReviewApiClient();
function IdentityDetails({value,scope}:{value:any;scope?:string}) {
  const identity=providerIdentity(value);
  return <div className="item-identity">
    <strong>{identity.title}</strong>
    <span>{identity.profile} · {identity.side} · {identity.status} · {identity.date}</span>
    <span>{identity.recurrence}</span>
    {scope&&<span>Selected recurrence scope: {scopeLabel(scope)}</span>}
    <span className="provider-id">Provider ID: <code>{identity.id||"Unavailable"}</code>{identity.id&&<button type="button" className="secondary copy-id" aria-label={`Copy provider ID ${identity.id}`} onClick={()=>{void navigator.clipboard.writeText(identity.id);}}>Copy ID</button>}</span>
    {!identity.identified&&<span className="warning">Identity not verified. Refresh affected items before assigning a disposition.</span>}
  </div>;
}
function AffectedItem({item,action,taskId,eventId,scope,snapshots,leftovers,updateLeftover,choiceKey,requiredDispositionRef}:{item:any;action:string;taskId:string;eventId:string;scope:string;snapshots:any[];leftovers:Record<string,string>;updateLeftover:(key:string,value:string)=>void;choiceKey:(item:any)=>string;requiredDispositionRef?:string}) {
  const key=choiceKey(item);
  const selectedItem=(item.ref.side==="todoist"?item.ref.id===taskId:item.ref.id===eventId);
  if(action==="calendar-history-only")return <div className="leftover" key={key}><div><IdentityDetails value={item} scope={scope}/><small className="relationship-reasons">Included because: {snapshotRelationship(item).join("; ")}</small></div><p>This item will be retained or detached only as described in the exact repair preview.</p></div>;
  if(selectedItem&&action==="todoist-only"&&item.ref.side==="calendar")return <div className="leftover" key={key}><div><IdentityDetails value={item} scope={scope}/><small className="relationship-reasons">Included because: {snapshotRelationship(item).join("; ")}</small></div><p>Selected as historical Calendar context; this repair will preserve it byte-for-byte and exclude it from future syncing.</p></div>;
  if(selectedItem&&action!=="separate"&&!(action==="todoist-only"&&item.ref.side==="calendar"))return null;
  if(action==="flatten"&&item.ref.side==="calendar"&&(snapshots.find((s:any)=>s.ref.side==="calendar"&&s.ref.id===eventId)?.object?.recurringEventId===item.ref.id||item.mapping&&item.object?.status==="cancelled"))return <div className="leftover" key={key}><div><IdentityDetails value={item} scope={scope}/><small className="relationship-reasons">Included because: {snapshotRelationship(item).join("; ")}</small></div><p>Included in the flatten plan. Preview shows the exact history and association changes.</p></div>;
  const options=dispositionOptions(item,action);
  return <div className="leftover" key={key}><div><IdentityDetails value={item} scope={scope}/><small className="relationship-reasons">Included because: {snapshotRelationship(item).join("; ")}</small></div>
    {!item.object?<p>No live provider object; no disposition is available.</p>:<div><label>Disposition<select aria-label={`Disposition for ${key}`} disabled={options.length===0} value={options.includes(leftovers[key])?leftovers[key]:""} onChange={e=>updateLeftover(key,e.target.value)}><option value="">Choose one</option>{options.includes("create")&&<option value="create">Create a new counterpart</option>}{options.includes("exclude")&&<option value="exclude">Exclude from syncing</option>}{options.includes("unchanged")&&<option value="unchanged">Leave unchanged</option>}{options.includes("retain-unlinked")&&<option value="retain-unlinked">Retain item; detach obsolete mapping</option>}{options.includes("delete")&&<option value="delete">Delete exact one-off and purge its state</option>}</select></label>
      <small>{requiredDispositionRef===key?"Required by repair preview validation.":"Whether a choice is required will be confirmed by the repair preview."}</small>{leftovers[key]&&<small>{dispositionGuidance(leftovers[key])}</small>}{item.object.status==="cancelled"&&<p className="warning">No generic cleanup action is safe for a cancelled recurrence. Leave unchanged preserves it; Exclude guards only this exact ID. Do not treat either choice as deleting the Calendar object or suppressing the whole series.</p>}</div>}
  </div>;
}
function App() {
  const [cases,setCases] = useState<Case[]>([]), [selected,setSelected] = useState<Case>(), [loadedDetails,setDetails] = useState<any>(), [profile,setProfile] = useState("home"), [history,setHistory] = useState(false);
  const [message,setMessage] = useState(""), [busy,setBusy] = useState(false);
  const [action,setAction] = useState("link"), [winner,setWinner] = useState("none"), [owner,setOwner] = useState(""), [scope,setScope] = useState("occurrence");
  const [repairSelection,setRepairSelection] = useState(emptyRepairSelection()), [targetProfile,setTargetProfile] = useState(""), [decisionAction,setDecisionAction] = useState("");
  const [leftovers,setLeftovers] = useState<Record<string,string>>({}), [requiredDispositionRef,setRequiredDispositionRef] = useState<string>();
  const [searchSide,setSearchSide] = useState("todoist"), [searchText,setSearchText] = useState(""), [searchResults,setSearchResults] = useState<any[]>([]);
  const [preview,setPreview] = useState<RepairPreview>(), [operation,setOperation] = useState<RepairOperation>();
  const [submitKey,setSubmitKey] = useState("");
  const [reconcileProfile,setReconcileProfile] = useState("home"), [reconciliation,setReconciliation] = useState<any>();
  const [reconciliationDiagnostics,setReconciliationDiagnostics] = useState<any[]>([]), [diagnosticCursor,setDiagnosticCursor] = useState<string>();
  const [terminalInboxRefreshPending,setTerminalInboxRefreshPending] = useState(false);
  const selectionVersion = useRef(0);
  const [detailState,setDetailState] = useState<{key:string;status:"loading"|"retrying"|"ready"|"error";message?:string}>();
  const [detailRetry,setDetailRetry] = useState(0);
  const [validationError,setValidationError] = useState<{field:string; message:string}>();
  const detailKey=selected ? `${selected.profile}:${selected.id}` : "";
  const currentDetailState=detailState?.key===detailKey ? detailState : undefined;
  const retryDetails=()=>{
    if (!selected) return;
    setDetails(undefined);
    setRepairSelection(emptyRepairSelection(selected));
    setDetailState({key:detailKey,status:"loading"});
    setDetailRetry(value=>value+1);
  };
  const taskId=repairSelection.taskId, eventId=repairSelection.eventId;
  // A detail response from the previously selected case must never be displayed.
  const details=selected?.id===loadedDetails?.item?.id && selected?.profile===loadedDetails?.item?.profile ? loadedDetails : undefined;
  const ownerRequirement=repairRecurrenceOwnerRequirement(repairSelection,details,action);
  const ownerExplanation=ownerRequirement === "calendar-occurrence"
    ? "This occurrence belongs to a recurring Calendar series. Choose which provider owns the recurrence."
    : ownerRequirement === "calendar-series"
      ? "This is a recurring Calendar series. Choose its recurrence owner before previewing."
      : ownerRequirement === "todoist-task"
        ? "This Todoist task repeats. Select Todoist as recurrence owner unless repairing a Calendar-owned series."
        : undefined;
  const canPreview=repairPreviewAllowed(repairSelection,selected,details,action,decisionAction,owner)
    && Object.entries(leftovers).every(([key,disposition]) => (details?.snapshots||[]).some((s:any)=>
      `${s.ref.profile}:${s.ref.side}:${s.ref.id}`===key
      && dispositionOptions(s,action).length>0 && (!disposition || dispositionOptions(s,action).includes(disposition))));
  const validPreview=canPreview && preview?.intent?.caseId===selected?.id && preview?.intent?.profile===selected?.profile
    && preview?.intent?.taskId===(taskId||undefined) && preview?.intent?.eventId===(eventId||undefined)
    && preview?.intent?.action===action ? preview : undefined;
  const invalidatePreview=()=>{selectionVersion.current++;setPreview(undefined);setSubmitKey("");setValidationError(undefined);};
  const selectCase=(item?:Case,options:{syncUrl?:boolean}={})=>{
    invalidatePreview();
    if(item)setProfile(item.profile);
    setSelected(item);setDetails(undefined);setRepairSelection(emptyRepairSelection(item));
    setDetailState(item?{key:`${item.profile}:${item.id}`,status:"loading"}:undefined);
    setLeftovers({});setRequiredDispositionRef(undefined);setSearchResults([]);setSearchText("");setOperation(undefined);setBusy(false);
    setAction("link");setWinner("none");setOwner("");setScope("occurrence");setTargetProfile("");setDecisionAction("");
    if(options.syncUrl!==false){const next=caseUrl(location.href,item?.id);if(item)window.history.pushState(null,"",next);else window.history.replaceState(null,"",next);}
  };
  const editId=(side:"todoist"|"calendar",id:string,verified=false,searchedItem?:ProviderObject)=>{
    invalidatePreview();setRepairSelection(current=>editRepairSelection(current,side,id,verified,searchedItem));
  };
  const setTaskId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("todoist",id,verified,searchedItem);
  const setEventId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("calendar",id,verified,searchedItem);
  const refresh = async () => { const data = await api(`cases?profile=${profile}&history=${history}`); setCases(data.items); };
  const refreshReconciliation = async (forProfile:string) => {
    const data=await api(`reconciliation?profile=${forProfile}`);
    setReconciliation(data);
    const generation=data.reconciliation?.generation;
    if(generation){
      const diagnostics=await api(`reconciliation/diagnostics?profile=${forProfile}&generation=${encodeURIComponent(generation)}`);
      setReconciliationDiagnostics(diagnostics.items||[]);setDiagnosticCursor(diagnostics.next);
    } else {setReconciliationDiagnostics([]);setDiagnosticCursor(undefined);}
    return data;
  };
  const loadMoreReconciliationDiagnostics = async () => {
    const generation=reconciliation?.reconciliation?.generation;
    if(!generation||!diagnosticCursor)return;
    try {
      const next=await api(`reconciliation/diagnostics?profile=${reconcileProfile}&generation=${encodeURIComponent(generation)}&after=${encodeURIComponent(diagnosticCursor)}`);
      setReconciliationDiagnostics(current=>[...current,...(next.items||[])]);setDiagnosticCursor(next.next);
    } catch(error:any) {setMessage(error.message);}
  };
  useEffect(() => {
    const caseId = new URLSearchParams(location.search).get("case");
    if (!caseId) return;
    const controller=new AbortController();
    api(`cases/${encodeURIComponent(caseId)}`,{signal:controller.signal})
      .then(data=>{if(!controller.signal.aborted){setProfile(data.item.profile);selectCase(data.item,{syncUrl:false});}})
      .catch(e=>{if(!isAbortError(e))setMessage(e.message);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    const onPopState=()=>{
      const caseId=new URLSearchParams(location.search).get("case");
      if(!caseId){selectionVersion.current++;selectCase(undefined,{syncUrl:false});return;}
      api(`cases/${encodeURIComponent(caseId)}`).then(data=>{
        selectionVersion.current++;setProfile(data.item.profile);selectCase(data.item,{syncUrl:false});
      }).catch((error:any)=>setMessage(error.message));
    };
    window.addEventListener("popstate",onPopState);
    return()=>window.removeEventListener("popstate",onPopState);
  },[]);
  useEffect(() => { refresh().catch(e=>setMessage(e.message)); },[profile,history]);
  useEffect(() => {
    if (!selected) { setDetails(undefined); setPreview(undefined); setOperation(undefined); return; }
    const controller=new AbortController();
    const key=`${selected.profile}:${selected.id}`;
    setMessage(""); setPreview(undefined); setOperation(undefined); setSubmitKey("");
    setDetails(undefined);setRepairSelection(emptyRepairSelection(selected));
    setLeftovers({}); setReconcileProfile(selected.profile);
    setDetailState({key,status:"loading"});
    api(`cases/${encodeURIComponent(selected.id)}`,{signal:controller.signal},{
      onRetry:()=>{if(!controller.signal.aborted)setDetailState({key,status:"retrying"});},
    }).then(async data=>{
      if(controller.signal.aborted)return;
      if(data.item?.id!==selected.id||data.item?.profile!==selected.profile)throw new Error("Selected conflict changed during refresh");
      // Apply both the visible live data and its verified form IDs as one update.
      setDetails(data);
      setDetailState({key,status:"ready"});
      setRepairSelection(current=>reconcileRepairSelection(data.item,data.snapshots,current));
      const operationId=data.item?.operationId||selected.operationId;
      if(operationId){
        try { const result=await api(`operations/${encodeURIComponent(operationId)}`,{signal:controller.signal}); if(!controller.signal.aborted)setOperation(result.operation); }
        catch(e:any){if(!controller.signal.aborted&&!isAbortError(e))setMessage(e.message);}
      }
    }).catch(e=>{
      if(!controller.signal.aborted&&!isAbortError(e))setDetailState({key,status:"error",message:e.message});
    });
    return ()=>controller.abort();
  },[selected,detailRetry]);
  useEffect(() => {
    refreshReconciliation(reconcileProfile).catch(e=>setMessage(e.message));
  },[reconcileProfile]);
  useEffect(() => {
    const currentRunStatus=reconciliation?.summary?.runStatus||reconciliation?.reconciliation?.status;
    if (!reconciliation?.reconciliation?.pending||["succeeded","needs_review","failed"].includes(currentRunStatus||"")) return;
    let cancelled=false;
    let timer:number;
    let pollFailures=0;
    const poll=async()=>{
      try {
        const data=await refreshReconciliation(reconcileProfile);
        if(cancelled)return;
        pollFailures=0;
        const runStatus=data.summary?.runStatus||data.reconciliation?.status||"unknown";
        const terminal=["succeeded","needs_review","failed"].includes(runStatus);
        if(terminal||!data.reconciliation?.pending) {
          setMessage(`Run ${runStatus}; ${data.summary?.actionableCaseCount??"some"} actionable review case(s) remain.`);
          setTerminalInboxRefreshPending(true);
        } else timer=window.setTimeout(poll,reconciliationPollDelayMs(0));
      } catch(e:any) { if(!cancelled){pollFailures++;setMessage(e.message);timer=window.setTimeout(poll,reconciliationPollDelayMs(pollFailures));} }
    };
    timer=window.setTimeout(poll,reconciliationPollDelayMs(0));
    return ()=>{cancelled=true;window.clearTimeout(timer);};
  },[reconcileProfile,reconciliation?.reconciliation?.generation,reconciliation?.reconciliation?.pending,reconciliation?.summary?.runStatus,reconciliation?.reconciliation?.status]);
  useEffect(() => {
    if (!terminalInboxRefreshPending) return;
    const refreshTask=createRetryingTask({
      run:refresh,
      onSuccess:()=>setTerminalInboxRefreshPending(false),
      onError:(error:any)=>setMessage(`Run is terminal, but the review inbox could not refresh: ${error.message}`),
    });
    refreshTask.start();
    return ()=>refreshTask.stop();
  },[terminalInboxRefreshPending,profile,history]);
  const providerLink=(item:ProviderObject|undefined) => {
    const href=item?.url||item?.htmlLink;
    if (!href) return undefined;
    try { const parsed=new URL(href); return ["https:","http:"].includes(parsed.protocol)?parsed.href:undefined; } catch { return undefined; }
  };
  const displaySnapshot=(sideName:"todoist"|"calendar") => {
    const matches=details?.snapshots?.filter((s:any)=>s.ref.profile===selected?.profile&&s.ref.side===sideName)||[];
    const requestedId=sideName==="todoist"?taskId:eventId;
    const current=matches.find((s:any)=>s.ref.id===requestedId)||(!requestedId&&matches.length===1?matches[0]:undefined);
    const item=current?.object as ProviderObject|undefined;
    if (!item) return <p>{current?`The provider could not find ${sideName} item ${current.ref.id}.`:requestedId?`No live provider snapshot is available for recorded ${sideName} ID ${requestedId}.`:`No ${sideName} item ID is attached to this alert. Search for the item below to continue.`}</p>;
    const start=sideName==="todoist"?(item.due?.datetime||item.due?.date):(item.start?.dateTime||item.start?.date);
    const end=sideName==="calendar"?(item.end?.dateTime||item.end?.date):undefined;
    const recurrence=sideName==="todoist"?(item.due?.is_recurring?item.due.string||"Recurring":"None"):(item.recurrence?.join(" · ")||(item.recurringEventId?"Part of a recurring series":"None"));
    const href=providerLink(item);
    const seriesAssociation=current.recurrence
      ? `Todoist ${current.recurrence.taskId} ↔ Calendar occurrence ${current.recurrence.activeInstanceId||current.recurrence.eventId} · series master ${current.recurrence.masterEventId} (${current.recurrence.owner}-owned)`
      : undefined;
    return <><IdentityDetails value={current} />{current.includedBy?.length>0&&<p className="relationship-reasons">Included because: {current.includedBy.join("; ")}</p>}{href&&<p><a href={href} target="_blank" rel="noreferrer">Open in {sideName==="todoist"?"Todoist":"Google Calendar"}</a></p>}<dl><dt>Date</dt><dd>{start||"Not set"}{end?` → ${end}`:""}</dd><dt>Description</dt><dd>{item.description||"None"}</dd><dt>Recurrence</dt><dd>{recurrence}</dd><dt>Existing counterpart</dt><dd>{current.mapping?`${current.mapping.taskId} ↔ ${current.mapping.eventId}`:seriesAssociation||"No mapping recorded"}</dd></dl><small>Checked {current.checkedAt?new Date(current.checkedAt).toLocaleString():"just now"}</small><details><summary>Provider details</summary><pre>{JSON.stringify(item,null,2)}</pre></details></>;
  };
  const originalMapping=details?.item?.decision?.mappingSnapshot;
  const liveMapping=details?.snapshots?.find((s:any)=>s.ref.profile===selected?.profile&&s.mapping?.profile===selected?.profile)?.mapping;
  const mappedEventIds=[liveMapping?.eventId,liveMapping?.masterEventId,liveMapping?.activeInstanceId].filter((id:any):id is string=>typeof id==="string"&&id.length>0);
  const selectedPairIsStale=action==="verify"&&Boolean(liveMapping)&&(
    taskId!==liveMapping.taskId||!mappedEventIds.includes(eventId)
  );
  const currentMappedEventId=liveMapping?.activeInstanceId||liveMapping?.eventId||liveMapping?.masterEventId;
  const mappingChanges=originalMapping&&liveMapping?["taskId","eventId","masterEventId","activeInstanceId","seriesId","recurrenceOwner"].filter(key=>originalMapping[key]!==liveMapping[key]):[];
  const alertContext=details?.item?.decision?.context||{};
  const hasProviderIds=Boolean(selected?.taskId||selected?.eventId||selected?.decision?.taskId||selected?.decision?.eventId
    ||selected?.decision?.masterEventId||selected?.decision?.activeInstanceId||alertContext.providerTaskId||alertContext.providerEventId
    ||alertContext.masterEventId||alertContext.activeInstanceId||alertContext.candidateTaskIds?.length||alertContext.candidateEventIds?.length);
  const emptyOperationalExplanation=selected?.decision?.type==="operational_dlq"&&!hasProviderIds
    ? alertContext.kind==="reconcile"
      ? "This was a profile-wide reconciliation delivery, so it has no single Todoist task or Calendar event attached. The empty panels are expected; inspect the failure details and request a fresh reconciliation after addressing the cause."
      : "This failure record has no provider item IDs, so the dashboard cannot look up a specific task or event. Search by title or description to find the current items, or request a fresh reconciliation."
    : undefined;
  const liveTask=details?.snapshots?.find((s:any)=>s.ref.profile===selected?.profile&&s.ref.side==="todoist")?.object;
  const liveEvent=details?.snapshots?.find((s:any)=>s.ref.profile===selected?.profile&&s.ref.side==="calendar")?.object;
  const alertChanges=[
    alertContext.taskTitle&&liveTask?.content&&alertContext.taskTitle!==liveTask.content?`Todoist title: “${alertContext.taskTitle}” → “${liveTask.content}”`:undefined,
    alertContext.todoistDue&&liveTask?.due&&(alertContext.todoistDue!==(liveTask.due.datetime||liveTask.due.date||liveTask.due.string))?`Todoist due date changed from ${alertContext.todoistDue}`:undefined,
    alertContext.calendarTitle&&liveEvent?.summary&&alertContext.calendarTitle!==liveEvent.summary?`Calendar title: “${alertContext.calendarTitle}” → “${liveEvent.summary}”`:undefined,
    alertContext.calendarStart&&liveEvent?.start&&(alertContext.calendarStart!==(liveEvent.start.dateTime||liveEvent.start.date))?`Calendar date changed from ${alertContext.calendarStart}`:undefined,
  ].filter(Boolean) as string[];
  const itemTitle=(snapshot:any) => snapshot?.object?.content||snapshot?.object?.summary||snapshot?.ref?.id;
  const updateLeftover=(key:string,value:string) => {invalidatePreview();setLeftovers(current=>({...current,[key]:value}));if(value&&requiredDispositionRef===key)setRequiredDispositionRef(undefined);};
  const search=async () => {
    if (!selected) return;
    setBusy(true);setMessage("");setSearchResults([]);
    const requestVersion=selectionVersion.current;
    try { const q=new URLSearchParams({profile:selected.profile,side:searchSide,q:searchText});const result=await api(`search?${q}`);
      if(requestVersion===selectionVersion.current)setSearchResults(result.items.map((item:any)=>({...item,_caseId:selected.id,_profile:selected.profile,_side:searchSide})));
    }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const refreshAffected=async () => {
    if(!selected)return;
    setBusy(true);setMessage("");invalidatePreview();
    const requestVersion=selectionVersion.current;
    const intent={action,taskId:taskId||undefined,eventId:eventId||undefined,winner:action==="transfer"?"none":winner,owner:owner||undefined,scope,leftovers,
      decisionAction:action==="decision"?decisionAction:undefined,targetProfile:action==="move"?targetProfile:undefined};
    try { const result=await api(`cases/${encodeURIComponent(selected.id)}/affected`,{method:"POST",body:JSON.stringify(intent)});
      if(requestVersion!==selectionVersion.current)return;
      setDetails((current:any)=>current?.item?.id===selected.id?{...current,snapshots:result.snapshots}:current);
      setRepairSelection(current=>reconcileRepairSelection(selected,result.snapshots,current));setLeftovers({});
      if(operationResumeEligibility(operation)==="fresh-preview") {
        const refreshedSelection=reconcileRepairSelection(selected,result.snapshots,emptyRepairSelection(selected));
        setRepairSelection(refreshedSelection);
        setMessage(`Current provider items refreshed. The failed operation ${operation?.id} remains unchanged. Review the current Todoist and Calendar IDs, then create a new preview.`);
      }
    }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const createPreview=async () => {
    if (!selected || !canPreview) return;
    setBusy(true);setMessage("");setValidationError(undefined);setPreview(undefined);setOperation(undefined);setSubmitKey("");
    const requestVersion=selectionVersion.current;
    const intent={action,taskId:taskId||undefined,eventId:eventId||undefined,winner:action==="transfer"?"none":winner,owner:owner||undefined,scope,leftovers,
      decisionAction:action==="decision"?decisionAction:undefined,targetProfile:action==="move"?targetProfile:undefined};
    try { const result=await api(`cases/${encodeURIComponent(selected.id)}/previews`,{method:"POST",body:JSON.stringify(intent)});
      if(requestVersion===selectionVersion.current){setRequiredDispositionRef(undefined);setPreview(result.preview);}
    }
    catch(e:any){
      const missingDisposition=missingDispositionReference(e.message);
      if (missingDisposition) {
        if(requestVersion===selectionVersion.current)setRequiredDispositionRef(missingDisposition);
        // The selected pair can displace an item absent from the initial case detail.
        try {
          const refreshed=await api(`cases/${encodeURIComponent(selected.id)}/affected`,{method:'POST',body:JSON.stringify(intent)});
          if(requestVersion===selectionVersion.current) {
            setDetails((current:any)=>current?.item?.id===selected.id?{...current,snapshots:refreshed.snapshots}:current);
            setRepairSelection(current=>reconcileRepairSelection(selected,refreshed.snapshots,current));
            setMessage('Additional linked items were found. Choose dispositions below for every displaced item, then preview again.');
          }
        } catch(refreshError:any) {setMessage(`Could not refresh affected items: ${refreshError.message}`);}
      } else if(requestVersion===selectionVersion.current) {
        const field=repairValidationField(e.message);
        if(field)setValidationError({field,message:e.message});
        else setMessage(e.message);
      }
    } finally{setBusy(false);}
  };
  const applyPreview=async () => {
    if (!validPreview) return;
    setBusy(true);setMessage("");
    const idempotencyKey=submitKey||crypto.randomUUID();
    setSubmitKey(idempotencyKey);
    try { const result=await api(`previews/${encodeURIComponent(validPreview.id)}/submit`,{method:"POST",headers:{"Idempotency-Key":idempotencyKey},body:"{}"});setOperation(result.operation);setPreview(undefined); }
    catch(e:any){if(e.data?.operation)setOperation(e.data.operation);setMessage(e.message);} finally{setBusy(false);}
  };
  const resume=async () => {
    if (!operation) return;
    setBusy(true);setMessage("");
    try {
      const result=await api(`operations/${encodeURIComponent(operation.id)}/resume`,{method:"POST",body:"{}"});
      setOperation(result.operation);
      setMessage(`Repair attempt ${result.queueDelivery.attempt} accepted by the queue. It will run after earlier work for ${selected?.profile||"this profile"} completes.`);
    }
    catch(e:any){if(e.data?.operation)setOperation(e.data.operation);setMessage(e.message);} finally{setBusy(false);}
  };
  const runReconciliation=async () => {
    const targetProfile=selected?.profile||reconcileProfile;
    if(selected?.decision?.type==="operational_reconciliation_stuck"
      && !window.confirm(`Request reconciliation for ${targetProfile}? This removes quarantined DLQ messages for this profile and reads current provider state. It does not replay the failed delivery.`))return;
    setBusy(true);setMessage("");
    try { const result=await api("reconciliation",{method:"POST",body:JSON.stringify({profile:targetProfile})});setReconciliation({reconciliation:result.run,summary:result.summary});const cleared=result.clearedDlq?.deleted||0;setMessage(`Cleared ${cleared} quarantined ${cleared===1?"delivery":"deliveries"} for ${targetProfile}. Reconciliation requested${result.reconciliation?.created?" with a new generation":"; the active generation was retained"}. ${result.summary?.actionableCaseCount??"Some"} actionable review case(s) remain; run outcome and inbox status are tracked separately.`); }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const dismissAlert=async () => {
    if(!selected||selected.status!=="open")return;
    if(!window.confirm("Dismiss this alert without changing Todoist, Calendar, or their mapping?"))return;
    setBusy(true);setMessage("");
    try { const result=await api(`cases/${encodeURIComponent(selected.id)}/dismiss`,{method:"POST",body:"{}"});selectCase(result.item,{syncUrl:false});await refresh();setMessage("Alert dismissed. Its history remains available for later verification or exclusion."); }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const decisionActions=(selected?.decision?.permittedActions||[]).filter((item:any)=>item.id!=="reconcile_now");
  const snapshots=details?.snapshots||[];
  const affectedGroups=groupAffectedSnapshots(snapshots);
  const choiceKey=(item:any)=>`${item.ref.profile}:${item.ref.side}:${item.ref.id}`;
  const availableSearchResults=searchResults.filter(item=>item._caseId===selected?.id&&item._profile===selected?.profile&&item._side===searchSide);
  const identityEvidence=selected?caseIdentityState(selected,snapshots):undefined;
  const hasLiveIdentity=snapshots.some((snapshot:any)=>snapshot.ref?.profile===selected?.profile&&providerIdentity(snapshot).identified);
  const hasPrimaryProviderIds=Boolean(selected?.taskId||selected?.eventId||selected?.decision?.taskId||selected?.decision?.eventId
    ||alertContext.providerTaskId||alertContext.providerEventId);
  const showProviderPanels=Boolean(hasPrimaryProviderIds||hasLiveIdentity);
  const openCaseCount=cases.filter(item=>item.status==="open"||item.status==="repairing").length;
  const latestRun=reconciliation?.reconciliation;
  const latestRunAt=latestRun?.lastCompletedAt||latestRun?.lastFailedAt||latestRun?.lastStartedAt||latestRun?.requestedAt;
  return <main>
    <header><div><h1>Calendar sync review</h1><p>Review conflicts using current Todoist and Calendar data.</p></div>
      <div className="header-actions"><label>Inbox <select value={profile} onChange={e=>{setProfile(e.target.value);selectCase(undefined);}}>{profiles.map(p=><option key={p} value={p}>{p==="all"?"All accounts":p}</option>)}</select></label>
        <a className="logout" href="https://alf1000.cloudflareaccess.com/cdn-cgi/access/logout">Sign out</a></div>
    </header>
    {message && <p className="notice" role="status">{message}</p>}
    {reconciliation?.summary&&<section className="preview reconciliation-overview" aria-label="Latest reconciliation">
      <h2>Latest reconciliation · {reconcileProfile}</h2>
      <dl className="overview-grid"><dt>Run status</dt><dd>{reconciliation.summary.runStatus.replaceAll("_"," ")}{latestRun?.pending?" · in progress":""}</dd>
        <dt>Generation</dt><dd>{latestRun?.generation||"Not recorded"}</dd>
        <dt>Last run activity</dt><dd>{latestRunAt?new Date(latestRunAt).toLocaleString():"Not recorded"}</dd>
        <dt>Unresolved diagnostic counter</dt><dd>{reconciliation.summary.runUnresolved}</dd>
        <dt>Items counted as blocked</dt><dd>{typeof latestRun?.result?.blocked==="number"?latestRun.result.blocked:"Not recorded"}</dd>
        <dt>Open review alerts</dt><dd>{openCaseCount} in this inbox · {reconciliation.summary.actionableCaseCount} actionable across the profile</dd></dl>
      <p>Run diagnostics describe work deferred, blocked or in conflict during this generation. Open review alerts are persistent decisions in the review inbox; these counts measure different things. An intentional exclusion can still be counted as blocked, and an unchanged item can reappear if its inconsistency remains. Case status and a diagnostic's “review case” status show whether an alert is open, historic, or newly created.</p>
    </section>}
    {reconciliation?.reconciliation?.generation&&<section className="preview reconciliation-items"><h2>Items deferred or blocked during this run</h2>
      <p>Generation {reconciliation.reconciliation.generation} · {latestRunAt?`run activity ${new Date(latestRunAt).toLocaleString()}`:"run timestamp not recorded"}. These are run diagnostics, not a count of open alerts. Provider objects are not changed by this report.</p>
      {reconciliationDiagnostics.length===0?<p>No per-item diagnostics were recorded for this generation.</p>:<ul>
        {reconciliationDiagnostics.map((item:any,index:number)=><li key={`${item.action}:${item.taskId||""}:${item.eventId||""}:${index}`}>
          <strong>{item.outcome.replaceAll("_"," ")} diagnostic</strong> · {item.reason.replaceAll("_"," ")}<br/>
          <span>{item.profile} · task {item.taskId||"unknown"} · event {item.eventId||"unknown"} · series {item.seriesId||"unknown"}</span><br/>
          {item.detail?.candidateTaskIds?.length>0&&<><span>Candidate tasks: {item.detail.candidateTaskIds.join(", ")}</span><br/></>}
          {item.detail?.candidateEventIds?.length>0&&<><span>Candidate Calendar events: {item.detail.candidateEventIds.join(", ")}</span><br/></>}
          {item.detail?.discardedTaskId&&<><span>Discarded task: {item.detail.discardedTaskId}</span><br/></>}
          {item.detail?.retainedTaskId&&<><span>Retained task: {item.detail.retainedTaskId}</span><br/></>}
          {item.detail?.decisionId&&<><span>Decision: {item.detail.decisionId}</span><br/></>}
          <span>Observed {item.observedAt?new Date(item.observedAt).toLocaleString():"at an unrecorded time"} · recurrence owner: {item.recurrenceOwner||"unknown"} · review case: {item.caseStatus||"not created"}{item.caseId?` (${item.caseId})`:""}</span>
        </li>)}
      </ul>}
      {diagnosticCursor&&<button className="secondary" onClick={loadMoreReconciliationDiagnostics}>Load more run diagnostics</button>}
    </section>}
    <ErasurePanel api={api} />
    <div className="layout"><nav aria-label="Open review alerts"><h2>{history?"Review alert history":"Open review alerts"}</h2><p>{openCaseCount} open/actionable case(s) shown in this inbox.</p><label className="history-toggle"><input type="checkbox" checked={history} onChange={e=>{setHistory(e.target.checked);selectCase(undefined);}} /> Show dismissed and resolved cases</label>{cases.map(item=><button className={`case ${selected?.id===item.id?"active":""}`} key={item.id} onClick={()=>selectCase(item)}><strong>{item.title}</strong><span>{item.profile} · {item.status}</span><small>{item.reason}</small></button>)}{cases.length===0&&<p>{history?"No conflict history.":"No open review alerts."}</p>}</nav>
      <section className="detail">{!selected?<><p>Select a conflict to inspect its live provider data.</p><div className="preview"><h3>Reconciliation</h3><label>Account<select value={reconcileProfile} onChange={e=>setReconcileProfile(e.target.value)}>{profiles.filter(p=>p!=="all").map(p=><option key={p}>{p}</option>)}</select></label><button onClick={runReconciliation} disabled={busy}>Run reconciliation</button>{reconciliation&&<details><summary>Current status</summary><pre>{JSON.stringify(reconciliation,null,2)}</pre></details>}</div></>:<>
        <div className="title"><div><h2>{selected.title}</h2><p>{selected.profile} · {selected.reason.replaceAll("_"," ")} · opened {new Date(selected.createdAt).toLocaleString()}</p></div></div>
        <section className="preview alert-evidence"><h3>Why this alert is open</h3>
          <p><strong>Recorded reason:</strong> {selected.reason.replaceAll("_"," ")}. {/(unmapped|identity_conflict|ambiguous)/i.test(`${selected.reason} ${selected.decision?.type||""}`)&&"Here, ‘unmapped’ means the sync identity or durable mapping is missing or ambiguous; it does not prove that the Calendar event is missing."}</p>
          <dl><dt>First seen / opened</dt><dd>{selected.createdAt?new Date(selected.createdAt).toLocaleString():"Not recorded"}</dd>
            <dt>Last recorded observation</dt><dd>{selected.decision?.context?.lastObservedAt||selected.decision?.context?.lastSeenAt||selected.decision?.context?.observedAt?new Date(selected.decision.context.lastObservedAt||selected.decision.context.lastSeenAt||selected.decision.context.observedAt).toLocaleString():"Not recorded; case update time is not treated as a provider observation"}</dd>
            <dt>Case state</dt><dd>{selected.status}{selected.updatedAt?` · case record updated ${new Date(selected.updatedAt).toLocaleString()}`:""}</dd>
            <dt>Earlier dismissal / reopen history</dt><dd>{selected.decision?.context?.reopenedAt||selected.decision?.context?.dismissedAt?`${selected.decision.context.dismissedAt?`dismissed ${new Date(selected.decision.context.dismissedAt).toLocaleString()}`:""}${selected.decision.context.reopenedAt?` · reopened ${new Date(selected.decision.context.reopenedAt).toLocaleString()}`:""}`:"Not recorded on this case"}</dd>
            <dt>Reconciliation generation</dt><dd>{selected.reconciliationGeneration||selected.decision?.context?.reconciliationGeneration||"Not recorded"}</dd>
            <dt>Detection evidence</dt><dd>{selected.decision?.sourceAuditAction||selected.decision?.context?.action||"No source audit action recorded"}{selected.decision?.context?.reason?` · ${String(selected.decision.context.reason).replaceAll("_"," ")}`:""}</dd>
          </dl>
          <p>Historical cause is not inferred from the current live items. The live provider panels below show what could be verified at this check.</p>
          {identityEvidence?.hasAnyRecordedIdentity?<div><strong>Recorded provider identities</strong>
            <p>Todoist IDs: {identityEvidence.taskIds.length?identityEvidence.taskIds.map((id:string)=><span key={`task-${id}`} className="identity-evidence">{id}{identityEvidence.verifiedTaskIds.includes(id)?" · verified live":" · candidate / unverified"}</span>):"none"}</p>
            <p>Calendar IDs: {identityEvidence.eventIds.length?identityEvidence.eventIds.map((id:string)=><span key={`event-${id}`} className="identity-evidence">{id}{identityEvidence.verifiedEventIds.includes(id)?" · verified live":" · candidate / unverified"}</span>):"none"}</p>
            {identityEvidence.seriesIds.length>0&&<p>Series identity (not a provider event ID): {identityEvidence.seriesIds.join(", ")}</p>}
          </div>:<p className="warning">Unable to identify a provider item from the recorded alert. Search or refresh to establish a live identity; repair stays unavailable until a current item is verified.</p>}
          {(selected.decision?.context?.candidateTaskIds?.length||selected.decision?.context?.candidateEventIds?.length||selected.decision?.context?.candidates?.length)&&<div className="candidate-search">
            <p>Recorded candidate identities are not selected automatically. Search by a recorded title, then inspect the live provider identity before choosing one.</p>
            <button className="secondary" onClick={()=>{setSearchSide("todoist");setSearchText(selected.decision?.context?.candidates?.[0]?.content||selected.decision?.context?.taskTitle||selected.title);}}>Search Todoist candidates</button>
            <button className="secondary" onClick={()=>{setSearchSide("calendar");setSearchText(selected.decision?.context?.calendarTitle||selected.title);}}>Search Calendar candidates</button>
          </div>}
          <details><summary>Recorded alert evidence</summary><pre>{JSON.stringify(selected.decision?.context||{},null,2)}</pre></details>
        </section>
        {selected.decision?.type==="operational_reconciliation_stuck"&&<section className="preview"><h3>Reconciliation diagnostics</h3>
          <dl>
            <dt>Generation</dt><dd>{selected.reconciliationGeneration||selected.decision.context?.reconciliationGeneration||"Not recorded"}</dd>
            <dt>Profile</dt><dd>{selected.profile}</dd>
            <dt>Incident classification</dt><dd>{(selected.decision.context?.incidentClassification||"legacy monitor alert").replaceAll("_"," ")}</dd>
            {selected.decision.context?.reconciliationStatus&&<><dt>Status at alert</dt><dd>{selected.decision.context.reconciliationStatus}</dd></>}
            {selected.decision.context?.failureCategory&&<><dt>Failure category</dt><dd>{selected.decision.context.failureCategory.replaceAll("_"," ")}</dd></>}
            {selected.decision.context?.failureSummary&&<><dt>Observed failure</dt><dd>{selected.decision.context.failureSummary}</dd></>}
            {selected.decision.context?.lastProgressAt&&<><dt>Last progress</dt><dd>{new Date(selected.decision.context.lastProgressAt).toLocaleString()}</dd></>}
            {selected.decision.context?.lastStartedAt&&<><dt>Started</dt><dd>{new Date(selected.decision.context.lastStartedAt).toLocaleString()}</dd></>}
            {(selected.progressCheckpoint||selected.decision.context?.progressCheckpoint)&&<><dt>Last checkpoint</dt><dd>{[selected.progressCheckpoint?.phase||selected.decision.context.progressCheckpoint.phase,
              `sequence ${selected.progressCheckpoint?.sequence??selected.decision.context.progressCheckpoint.sequence??0}`].filter(Boolean).join(" · ")}</dd>
              {(selected.progressCheckpoint?.afterTaskId||selected.decision.context.progressCheckpoint.afterTaskId)&&<><dt>Todoist cursor</dt><dd>{selected.progressCheckpoint?.afterTaskId||selected.decision.context.progressCheckpoint.afterTaskId}</dd></>}
              {(selected.progressCheckpoint?.afterEventId||selected.decision.context.progressCheckpoint.afterEventId)&&<><dt>Calendar cursor</dt><dd>{selected.progressCheckpoint?.afterEventId||selected.decision.context.progressCheckpoint.afterEventId}</dd></>}
            </>}
            {selected.decision.context?.lastStartedDeliveryId&&<><dt>Last started delivery</dt><dd>{selected.decision.context.lastStartedDeliveryId}</dd></>}
            {selected.decision.context?.lastDeliveryId&&<><dt>Latest accepted delivery</dt><dd>{selected.decision.context.lastDeliveryId}</dd></>}
            {selected.decision.context?.nextContinuation&&<><dt>Expected continuation</dt><dd>{selected.decision.context.nextContinuation.deliveryId} · {selected.decision.context.nextContinuation.phase} sequence {selected.decision.context.nextContinuation.sequence}</dd>
              {selected.decision.context.nextContinuation.afterTaskId&&<><dt>Next Todoist cursor</dt><dd>{selected.decision.context.nextContinuation.afterTaskId}</dd></>}
              {selected.decision.context.nextContinuation.afterEventId&&<><dt>Next Calendar cursor</dt><dd>{selected.decision.context.nextContinuation.afterEventId}</dd></>}
            </>}
            {selected.decision.context?.failureContext?.stage&&<><dt>Failure stage</dt><dd>{selected.decision.context.failureContext.stage}</dd></>}
            {selected.decision.context?.failureContext?.status&&<><dt>Provider status</dt><dd>HTTP {selected.decision.context.failureContext.status}</dd></>}
            {selected.decision.context?.failureContext?.taskId&&<><dt>Failing task ID</dt><dd>{selected.decision.context.failureContext.taskId}</dd></>}
            {selected.decision.context?.failureContext?.eventId&&<><dt>Failing event ID</dt><dd>{selected.decision.context.failureContext.eventId}</dd></>}
            {selected.decision.context?.reconciliationResult&&<><dt>Recorded progress counts</dt><dd>{Object.entries(selected.decision.context.reconciliationResult).map(([key,value])=>`${key}: ${value}`).join(" · ")}</dd></>}
            <dt>Queue state</dt><dd>{selected.decision.context?.queueState||"Unknown"}. {selected.decision.context?.queueStateNote||"Current SQS/DLQ state was not recorded."}</dd>
          </dl>
          {details?.reconciliation?.relationToAlert==="different_generation"&&<p className="notice">A different generation is current. This alert refers to an older run.</p>}
          {details?.reconciliation?.relationToAlert==="progressed_since_alert"&&<p className="notice">This generation recorded progress after the alert. Check its latest checkpoint before deciding whether another run is needed.</p>}
          {details?.reconciliation?.relationToAlert==="completed_since_alert"&&<p className="notice">This generation has a recorded terminal completion since the alert.</p>}
          {details?.reconciliation?.relationToAlert==="failed_since_alert"&&<p className="notice">This generation recorded a worker failure after the alert. The failure category below is diagnostic context, not proof of the cause of the original stall.</p>}
          {!selected.decision.context?.progressCheckpoint&&!details?.reconciliation?.run?.progressCheckpoint&&<p className="notice">No persisted progress checkpoint is available for this run.</p>}
          {details?.reconciliation?.relationToAlert==="same_generation"&&details?.reconciliation?.run&&<p className="notice">Live run status: {details.reconciliation.run.status||"unknown"}; {details.reconciliation.run.pending?"still pending":"terminal"}. Dismissal of this alert is not evidence of recovery.</p>}
          {details?.reconciliation?.run?.lastProgressAt&&<p>Latest live progress: {new Date(details.reconciliation.run.lastProgressAt).toLocaleString()}</p>}
          {details?.reconciliation?.run?.progressCheckpoint&&<p>Latest live checkpoint: {details.reconciliation.run.progressCheckpoint.phase||"unknown phase"} sequence {details.reconciliation.run.progressCheckpoint.sequence??0}
            {details.reconciliation.run.progressCheckpoint.afterTaskId?` · after task ${details.reconciliation.run.progressCheckpoint.afterTaskId}`:""}
            {details.reconciliation.run.progressCheckpoint.afterEventId?` · after event ${details.reconciliation.run.progressCheckpoint.afterEventId}`:""}</p>}
          {details?.reconciliation?.run?.nextContinuation&&<p>Current expected continuation: {details.reconciliation.run.nextContinuation.deliveryId} · {details.reconciliation.run.nextContinuation.phase} sequence {details.reconciliation.run.nextContinuation.sequence}</p>}
          <p>These fields are diagnostics from persisted state. A monitor stall does not establish why progress stopped. A queue acceptance record does not confirm current queue or DLQ state.</p>
        </section>}
        {selected.decision?.type?.startsWith("operational_")&&selected.decision?.type!=="operational_reconciliation_stuck"&&<details className="preview"><summary>Delivery failure details</summary><dl>
          {selected.decision.context?.kind&&<><dt>Delivery type</dt><dd>{selected.decision.context.kind}</dd></>}
          {selected.decision.context?.status&&<><dt>Provider response</dt><dd>HTTP {selected.decision.context.status}</dd></>}
          {selected.decision.context?.failure&&<><dt>Failure</dt><dd>{selected.decision.context.failure}</dd></>}
          {selected.decision.context?.deliveryId&&<><dt>Delivery ID</dt><dd>{selected.decision.context.deliveryId}</dd></>}
          {selected.decision.context?.providerErrorTag&&<><dt>Provider error</dt><dd>{selected.decision.context.providerErrorTag}</dd></>}
          {selected.decision.context?.reconcileStage&&<><dt>Reconciliation stage</dt><dd>{selected.decision.context.reconcileStage}</dd></>}
          {selected.decision.context?.providerTaskId&&<><dt>Failing task ID</dt><dd>{selected.decision.context.providerTaskId}</dd></>}
          {selected.decision.context?.providerEventId&&<><dt>Failing event ID</dt><dd>{selected.decision.context.providerEventId}</dd></>}
        </dl><p>A failed delivery is not replayed. Search for current items and preview a guarded repair, or request a fresh reconciliation.</p></details>}
        {emptyOperationalExplanation&&<p className="notice">{emptyOperationalExplanation}</p>}
        {!details?<div className="notice detail-load" role="status">
          {currentDetailState?.status==="error"?<><p>Could not load live provider details: {currentDetailState.message}</p><button className="secondary" onClick={retryDetails}>Retry case details</button></>:
            <p>{currentDetailState?.status==="retrying"?"Review API is busy (HTTP 429). Retrying case details…":"Loading live Todoist and Calendar details…"}</p>}
        </div>:showProviderPanels?<div className="columns"><article><h3>Todoist</h3>{displaySnapshot("todoist")}</article><article><h3>Calendar</h3>{displaySnapshot("calendar")}</article></div>:<p className="notice">No live Todoist or Calendar object could be verified from the identities attached to this case. Recorded candidate or series IDs above are evidence only; search and verify an exact live item before repairing.</p>}
        {["resolved","excluded"].includes(selected.status)&&<p className="notice">To change a previous decision, select the exact current provider IDs and create a fresh preview. Exclude the Todoist task to keep it Todoist-only; Leave unchanged permits normal syncing.</p>}
        {selected.status==="dismissed"&&<p className="notice">This alert was dismissed separately from a verified repair. It remains in history until the live relationship is verified or the affected items are explicitly excluded.</p>}
        <p className="change-summary">{alertChanges.length?<>Changed since the alert:<ul>{alertChanges.map((change,i)=><li key={i}>{change}</li>)}</ul></>:originalMapping?mappingChanges.length?`Association changed since the alert: ${mappingChanges.join(", ")}.`:"Association matches the alert snapshot.":"The original alert did not capture comparable provider fields; compare the live provider details above."}</p>
        {selected.result&&<p className="notice">Latest case outcome: {selected.result}</p>}
        <div className="preview">
          <h3>Repair this conflict</h3>
          <p>Repair changes provider or mapping state only after you verify the exact IDs and review a preview. Selecting a candidate by title alone never applies a repair.</p>
          <div className="formgrid">
            <label>Action<select value={action} onChange={e=>{invalidatePreview();setAction(e.target.value);if(e.target.value==="flatten"||e.target.value==="todoist-only"||e.target.value==="todoist-only-delete-calendar"||e.target.value==="calendar-history-only"){setLeftovers({});setWinner("none");setOwner("");setScope("future");}if(e.target.value==="transfer"){setWinner("none");setOwner("calendar");setScope("future");}}}>{[
              ["flatten","Flatten the selected recurring occurrence to a one-off pair"],["todoist-only","Make Todoist one-off; keep Calendar history without a counterpart"],["todoist-only-delete-calendar","Keep Todoist task; delete only its exact Calendar projection"],["calendar-history-only","Keep elapsed Calendar event; detach only its Todoist identity"],["link","Link or replace an association"],["transfer","Transfer an existing Calendar series to a recurring Todoist task"],["separate","Keep items separate (choose future syncing per item)"],["create","Create the missing counterpart"],["exclude","Keep selected items only in their current provider (exclude syncing)"],["decision","Apply an existing Slack decision"],["verify","Verify an existing association"],["move","Move task to another account"],
            ].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label>Todoist task ID<input value={taskId} onChange={e=>setTaskId(e.target.value)} placeholder="Select or search for a task" aria-invalid={validationError?.field==="taskId"} />{validationError?.field==="taskId"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>
            <label>Calendar event ID<input value={eventId} onChange={e=>setEventId(e.target.value)} placeholder="Select or search for an event" aria-invalid={validationError?.field==="eventId"} />{validationError?.field==="eventId"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>
            {selectedPairIsStale&&<p className="warning">The selected IDs do not match the live mapping. Current pair: Todoist {liveMapping.taskId} ↔ Calendar {mappedEventIds.join(", ")}. Refresh affected items, then use the current mapped pair or search for the correct event.</p>}
            {action==="verify"&&liveMapping&&currentMappedEventId&&<button className="secondary" onClick={()=>{
              invalidatePreview();
              setRepairSelection(reconcileRepairSelection(
                {...selected,taskId:liveMapping.taskId,eventId:currentMappedEventId},details.snapshots,emptyRepairSelection(selected)
              ));
            }}>Use current mapped pair</button>}
            {action==="flatten"&&<label>Occurrence to retain<select value={eventId} onChange={e=>{const item=snapshots.find((s:any)=>s.ref.side==="calendar"&&s.ref.id===e.target.value);setEventId(e.target.value,true,item?.object);setLeftovers({});}}><option value="">Choose the exact active occurrence</option>{snapshots.filter((s:any)=>s.ref.profile===selected.profile&&s.ref.side==="calendar"&&s.object?.recurringEventId&&s.object?.status==="confirmed").map((s:any)=><option key={s.ref.id} value={s.ref.id}>{s.object.start?.date || s.object.start?.dateTime} — {s.object.summary} ({s.ref.id})</option>)}</select><small>Supports the next active all-day yearly occurrence. Preview shows the retained one-off date and preserved history before applying.</small></label>}
            {action==="todoist-only"&&<p className="notice">Choose the exact recurring Todoist task and a confirmed standalone Calendar item that is historical to it. The task keeps its due date as a one-off and is excluded from projection. The Calendar item is preserved byte-for-byte and excluded from future syncing.</p>}
            {action==="todoist-only-delete-calendar"&&<p className="warning">Choose the exact active one-off Todoist task and its mapped Calendar projection. Applying this repair deletes only that Calendar projection, keeps the Todoist task unchanged, removes the stale mapping, and excludes both exact IDs from future syncing. Closed cases may use a fresh preview against current IDs.</p>}
            {action==="calendar-history-only"&&<p className="warning">Choose one confirmed, elapsed standalone Calendar event. Preview will show its exact date range and mapping rows, along with any current/future counterpart that will remain linked. Applying changes only the selected event metadata and its exact event mapping.</p>}
            {action==="create"&&<div className="source-choice"><span>Choose which item should get a new counterpart:</span><div><button className="secondary" onClick={()=>setEventId("")}>Create Calendar event from this Todoist task</button><button className="secondary" onClick={()=>setTaskId("")}>Create Todoist task from this Calendar event</button></div></div>}
            {["link","transfer"].includes(action)&&<label>Fields to use<select value={action==="transfer"?"none":winner} disabled={action==="transfer"} onChange={e=>{invalidatePreview();setWinner(e.target.value);}} aria-invalid={validationError?.field==="winner"}><option value="none">Keep current fields</option><option value="todoist">Use Todoist fields</option><option value="calendar">Use Calendar fields</option></select>{action==="transfer"&&<small>The transfer preserves the Todoist task's existing recurrence and fields.</small>}{validationError?.field==="winner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {["link","transfer","create"].includes(action)&&<label>Recurrence owner {ownerRequirement&&<strong>(required)</strong>}<select value={owner} onChange={e=>{invalidatePreview();setOwner(e.target.value);}} required={Boolean(ownerRequirement)} aria-invalid={validationError?.field==="owner" || Boolean(ownerRequirement&&!owner)} aria-describedby={ownerRequirement?"recurrence-owner-help":undefined}><option value="">{ownerRequirement?"Choose a recurrence owner":"No recurrence / leave unchanged"}</option><option value="todoist">Todoist</option><option value="calendar">Calendar</option></select>{ownerExplanation&&<small id="recurrence-owner-help">{ownerExplanation}</small>}{validationError?.field==="owner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {["flatten","todoist-only","todoist-only-delete-calendar","link","transfer","separate","create","exclude","verify"].includes(action)&&<label>Recurrence scope<select value={scope} onChange={e=>{invalidatePreview();setScope(e.target.value);}} aria-invalid={validationError?.field==="scope"}><option value="occurrence">This occurrence</option><option value="series">Entire series</option><option value="future">Future occurrences (preserve history)</option></select>{validationError?.field==="scope"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {action==="move"&&<label>Destination account<select value={targetProfile} onChange={e=>{invalidatePreview();setTargetProfile(e.target.value);}}><option value="">Choose account</option>{profiles.filter(p=>p!=="all"&&p!==selected.profile).map(p=><option key={p}>{p}</option>)}</select></label>}
            {action==="decision"&&<label>Slack decision<select value={decisionAction} onChange={e=>{invalidatePreview();setDecisionAction(e.target.value);}}><option value="">Choose an allowed action</option>{decisionActions.map((item:any)=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
          </div>
          <div className="search"><label>Find counterpart<select value={searchSide} onChange={e=>{setSearchSide(e.target.value);setSearchResults([]);}}><option value="todoist">Todoist task</option><option value="calendar">Calendar event</option></select></label><input value={searchText} onChange={e=>setSearchText(e.target.value)} placeholder="Search titles or descriptions" onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void search();}}} /><button className="secondary" onClick={search} disabled={busy||searchText.trim().length<2}>Search</button></div>
          {availableSearchResults.length>0&&<ul className="results">{availableSearchResults.map(item=><li key={item.id}><IdentityDetails value={item} scope={scope} /><button className="secondary" disabled={!providerIdentity(item).selectable} onClick={()=>searchSide==="todoist"?setTaskId(item.id,true,item):setEventId(item.id,true,item)}>Use this item</button></li>)}</ul>}
          <button className="secondary" onClick={refreshAffected} disabled={busy||!details}>Refresh affected items</button>
          {snapshots.length>0&&<div><h4>{action==="separate"?"Separate these items":"Disposition for other affected items"}</h4><p>Each row identifies the exact provider object, the recorded relationship that included it, and whether a disposition is required for this repair.</p>{action==="transfer"&&<p className="warning">Delete is limited to exact standalone one-off duplicates with no retained completion history. Recurrences, occurrences, incomplete mappings, and historical items will be rejected by the preview.</p>}{affectedGroups.map((group:any)=><section className="affected-group" key={group.key}>{group.seriesId||group.masterId?<h5>Recurring series group · {group.seriesId?`series ${group.seriesId}`:`master ${group.masterId}`}{group.masterId?` · Calendar master ${group.masterId}`:""}</h5>:null}{group.items.map((item:any)=><AffectedItem key={choiceKey(item)} item={item} action={action} taskId={taskId} eventId={eventId} scope={scope} snapshots={snapshots} leftovers={leftovers} updateLeftover={updateLeftover} choiceKey={choiceKey} requiredDispositionRef={requiredDispositionRef}/>)}</section>)}</div>}
          {!canPreview&&details&&<p className="warning" role="status">{ownerRequirement&&!owner?"Preview disabled: choose a recurrence owner above.":"Preview disabled: select the current provider item IDs or refresh affected items to verify edited IDs. Ambiguous or missing IDs are never carried over from another conflict."}</p>}
          <button onClick={createPreview} disabled={busy||!canPreview}>{busy?"Working…":"Preview repair"}</button>
          <button className="secondary reconcile-button" onClick={runReconciliation} disabled={busy}>{selected.decision?.type==="operational_reconciliation_stuck"?`Request fresh reconciliation for ${selected.profile}`:`Run reconciliation for ${selected.profile}`}</button>
          <p className="action-explanation">Run reconciliation scans the whole profile; it does not apply this one-case repair. Dismissing an alert hides the notification only and does not fix provider data or mappings.</p>
          {selected.status==="open"&&<button className="secondary dismiss-button" onClick={dismissAlert} disabled={busy}>Dismiss alert only</button>}
          {reconciliation&&<details><summary>Reconciliation status</summary><pre>{JSON.stringify(reconciliation,null,2)}</pre></details>}
        </div>
        {validPreview&&<section className="preview"><h3>Review planned changes</h3><p>This preview expires at {new Date(validPreview.expiresAt*1000).toLocaleString()}.</p><p>Selected recurrence scope: <strong>{scopeLabel(validPreview.intent.scope)}</strong></p><h4>Affected provider items and their outcomes</h4><ul className="preview-items">{validPreview.snapshots.map((item:any)=>{const plan=previewEffect(item,validPreview.intent,validPreview.itemPlan?.find((entry:any)=>choiceKey(entry)===choiceKey(item)));return <li key={choiceKey(item)}><IdentityDetails value={item} scope={validPreview.intent.scope} />{item.includedBy?.length>0&&<p className="relationship-reasons">Included because: {item.includedBy.join("; ")}</p>}<div><strong>Operation:</strong> {plan.operation}</div><div><strong>Resulting disposition / mapping:</strong> {plan.result}</div>{item.mapping&&<div>Existing mapping: Todoist {item.mapping.taskId} ↔ Calendar {item.mapping.eventId}{item.mapping.masterEventId&&` · master ${item.mapping.masterEventId}`}</div>}{item.control?.excluded&&<div>Currently excluded</div>}{item.checkedAt&&<small>Checked {new Date(item.checkedAt).toLocaleString()}</small>}</li>;})}</ul><h4>Planned changes</h4><ul>{validPreview.changes.map((change,i)=><li key={i}>{change}</li>)}</ul>{validPreview.splitPlan&&<dl><dt>Historical Calendar rule</dt><dd>{validPreview.splitPlan.originalRule}</dd><dt>Rule after repair</dt><dd>{validPreview.splitPlan.truncatedRule}</dd><dt>Future recurrence starts</dt><dd>{validPreview.splitPlan.newStart}</dd><dt>Future RRULE</dt><dd>{validPreview.splitPlan.newRule}</dd><dt>Calendar timezone</dt><dd>{validPreview.splitPlan.calendarTimeZone}</dd>{validPreview.splitPlan.expiredUntil&&<><dt>Existing series expired</dt><dd>{validPreview.splitPlan.expiredUntil}; historical rule will not be extended</dd></>}</dl>}<h4>Warnings</h4><ul>{validPreview.warnings.map((warning,i)=><li className="warning" key={i}>{warning}</li>)}</ul><button onClick={applyPreview} disabled={busy||!canPreview}>{busy?"Submitting…":"Apply repair"}</button><button className="secondary" onClick={()=>setPreview(undefined)}>Cancel</button></section>}
        {operation&&<section className="preview"><h3>Repair status: {operation.status.replaceAll("_"," ")}</h3><p>Operation {operation.id} · attempt {operation.attempt}</p>{operation.error&&<p className="warning">{operation.error}</p>}{operation.nextAction&&<p>{operation.nextAction}</p>}{operation.notificationText&&<p>{operation.notificationText}</p>}{operation.status==="queued"&&<p>This repair is serialized with other work for {selected?.profile||"this profile"}. Retrying creates a fresh queue delivery; completed repair steps remain checkpointed.</p>}{operation.steps&&<ul>{Object.entries(operation.steps).map(([name,step])=><li key={name}>{name}: {step.status}</li>)}</ul>}{operation.outcomes&&<ul>{operation.outcomes.map(item=><li key={item.entity}>{item.entity}: {item.outcome}</li>)}</ul>}{operationResumeEligibility(operation)==="fresh-preview"?<><p>This failed operation has no recorded provider write. Refresh affected items and create a new preview; the old operation will remain available for audit.</p><button className="secondary" onClick={refreshAffected} disabled={busy}>Refresh and create new preview</button></>:operationResumeEligibility(operation)==="resume"&&<button onClick={resume} disabled={busy}>{operation.status==="queued"?"Retry queue delivery":"Resume operation"}</button>}</section>}
      </>}</section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
