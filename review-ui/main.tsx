import React, { useEffect, useRef, useState } from "react";
import { createReviewApiClient, createRetryingTask, isAbortError, reconciliationPollDelayMs } from "./api-client.mjs";
import { SYNC_PROFILES, reviewScopeLabel, reconciliationScopes, manualReconciliationTarget, createScopedRequestGate } from "./reconciliation-scope.mjs";
import { emptyRepairSelection, reconcileRepairSelection, editRepairSelection, repairPreviewAllowed, repairRecurrenceOwnerRequirement, repairValidationField, missingDispositionReference, operationResumeEligibility, revalidateRepairAction } from "./repair-selection.mjs";
import { createRoot } from "react-dom/client";
import { availableRepairActions, actionFormFields } from "./repair-action-capabilities.mjs";
import { ErasurePanel } from "./erasure-panel";
import { providerIdentity, providerLink, dispositionOptions, scopeLabel, previewEffect } from "./item-identity.mjs";
import { caseUrl, recordedPrimaryProviderIds, recordedProviderState, dispositionGuidance, snapshotRelationship, groupAffectedSnapshots } from "./case-url.mjs";

type Case = { id:string; profile:string; title:string; reason:string; status:string; taskId?:string; eventId?:string; createdAt:string; updatedAt?:string; decision?:any; operationId?:string; result?:string; reconciliationGeneration?:string; progressCheckpoint?:any };
type ProviderObject = { id:string; content?:string; summary?:string; description?:string; url?:string; htmlLink?:string; due?:{date?:string;datetime?:string;string?:string;is_recurring?:boolean}; start?:{date?:string;dateTime?:string}; end?:{date?:string;dateTime?:string}; recurrence?:string[]; recurringEventId?:string; status?:string };
type FutureSplitPreview = { originalRule:string; truncatedRule:string; newStart:string; newRule:string; calendarTimeZone?:string; expiredUntil?:string; previousOccurrence?:string; historicalLastOccurrence?:string };
type RepairPreview = { id:string; intent:any; snapshots:any[]; changes:string[]; warnings:string[]; expiresAt:number; itemPlan:Array<{ref:{profile:string;side:"todoist"|"calendar";id:string};operation:string;result:string}>; splitPlan?:FutureSplitPreview };
type RepairOperation = { id:string; attempt:number; status:string; abandoned?:boolean; error?:string; nextAction?:string; notificationText?:string; steps:Record<string,{status:string}>; outcomes?:Array<{entity:string;outcome:string}> };
const profiles = ["all",...SYNC_PROFILES];
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
function AffectedItem({item,action,taskId,eventId,scope,snapshots,leftovers,updateLeftover,choiceKey,requiredDispositionRef}:{item:any;action:string;taskId:string;eventId:string;scope?:string;snapshots:any[];leftovers:Record<string,string>;updateLeftover:(key:string,value:string)=>void;choiceKey:(item:any)=>string;requiredDispositionRef?:string}) {
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
  const [inboxStatus,setInboxStatus]=useState<"loading"|"ready"|"error">("loading");
  const requestGate=useRef(createScopedRequestGate("home")).current;
  const navigationSequence=useRef(0);
  const [message,setMessage] = useState(""), [busy,setBusy] = useState(false);
  const [action,setAction] = useState(""), [winner,setWinner] = useState("none"), [owner,setOwner] = useState(""), [scope,setScope] = useState("occurrence");
  const [repairSelection,setRepairSelection] = useState(emptyRepairSelection()), [targetProfile,setTargetProfile] = useState(""), [decisionAction,setDecisionAction] = useState("");
  const [leftovers,setLeftovers] = useState<Record<string,string>>({}), [requiredDispositionRef,setRequiredDispositionRef] = useState<string>();
  const [searchSide,setSearchSide] = useState("todoist"), [searchText,setSearchText] = useState(""), [searchResults,setSearchResults] = useState<any[]>([]);
  const [preview,setPreview] = useState<RepairPreview>(), [operation,setOperation] = useState<RepairOperation>();
  const [submitKey,setSubmitKey] = useState("");
  const [reconcileProfile,setReconcileProfile] = useState("home");
  type RunView={status:"loading"|"ready"|"error"; data?:any; diagnostics:any[]; cursor?:string; error?:string};
  const [runViews,setRunViews]=useState<Record<string,RunView>>({});
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
  const overviewProfiles=reconciliationScopes(profile);
  const manualTarget=manualReconciliationTarget({filter:profile,selectedProfile:selected?.profile,chosenProfile:reconcileProfile});
  // A detail response from the previously selected case must never be displayed.
  const details=selected?.id===loadedDetails?.item?.id && selected?.profile===loadedDetails?.item?.profile ? loadedDetails : undefined;
  const capabilities=availableRepairActions({caseItem:details?.item,snapshots:details?.snapshots||[],
    selection:repairSelection,decision:details?.item?.decision,operation,profiles});
  const ownerRequirement=repairRecurrenceOwnerRequirement(repairSelection,details,action);
  const formFields=actionFormFields(action,{hasRecurrence:capabilities.summary.hasRecurrence,ownerRequired:Boolean(ownerRequirement)});
  const currentAction=capabilities.actions.find((item:any)=>item.id===action);
  const capabilitySignature=capabilities.actions.map((item:any)=>item.id).join("|");
  const ownerExplanation=ownerRequirement === "calendar-occurrence"
    ? "This occurrence belongs to a recurring Calendar series. Choose which provider owns the recurrence."
    : ownerRequirement === "calendar-series"
      ? "This is a recurring Calendar series. Choose its recurrence owner before previewing."
      : ownerRequirement === "todoist-task"
        ? "This Todoist task repeats. Select Todoist as recurrence owner unless repairing a Calendar-owned series."
        : undefined;
  const canPreview=Boolean(currentAction)&&repairPreviewAllowed(repairSelection,selected,details,action,decisionAction,owner)
    && Object.entries(leftovers).every(([key,disposition]) => (details?.snapshots||[]).some((s:any)=>
      `${s.ref.profile}:${s.ref.side}:${s.ref.id}`===key
      && dispositionOptions(s,action).length>0 && (!disposition || dispositionOptions(s,action).includes(disposition))));
  const validPreview=canPreview && preview?.intent?.caseId===selected?.id && preview?.intent?.profile===selected?.profile
    && preview?.intent?.taskId===(taskId||undefined) && preview?.intent?.eventId===(eventId||undefined)
    && preview?.intent?.action===action ? preview : undefined;
  const invalidatePreview=()=>{selectionVersion.current++;setPreview(undefined);setSubmitKey("");setValidationError(undefined);};
  // A newly missing, cancelled, completed, reassigned or unverified provider
  // immediately revokes the chosen action. Never substitute another mutation.
  useEffect(()=>{
    if(!revalidateRepairAction(action,capabilities).revoked)return;
    invalidatePreview();setAction("");setOwner("");setWinner("none");setScope("occurrence");
    setLeftovers({});setRequiredDispositionRef(undefined);setDecisionAction("");setTargetProfile("");
    setMessage("The selected repair action is no longer supported by current provider evidence. Recheck and choose an action again.");
  },[action,capabilitySignature,selected?.id,selected?.profile,repairSelection.taskId,
    repairSelection.eventId,repairSelection.verifiedTaskId,repairSelection.verifiedEventId,
    details,operation?.status]);
  const chooseRepairAction=(next:string)=>{
    invalidatePreview();setAction(next);setOwner(next==="transfer"?"calendar":"");
    setWinner("none");setScope(["flatten","transfer","todoist-only","todoist-only-delete-calendar","calendar-history-only"].includes(next)?"future":"occurrence");
    setLeftovers({});setRequiredDispositionRef(undefined);setTargetProfile("");setDecisionAction("");
  };
  const selectCase=(item?:Case,options:{syncUrl?:boolean}={})=>{
    navigationSequence.current++;
    invalidatePreview();
    if(item){
      requestGate.switchScope(item.profile);
      if(item.profile!==profile){setProfile(item.profile);setCases([]);setInboxStatus("loading");setRunViews({});}
      setReconcileProfile(item.profile);
    }
    setSelected(item);setDetails(undefined);setRepairSelection(emptyRepairSelection(item));
    setDetailState(item?{key:`${item.profile}:${item.id}`,status:"loading"}:undefined);
    setLeftovers({});setRequiredDispositionRef(undefined);setSearchResults([]);setSearchText("");setOperation(undefined);setBusy(false);
    setAction("");setWinner("none");setOwner("");setScope("occurrence");setTargetProfile("");setDecisionAction("");
    if(options.syncUrl!==false){const next=caseUrl(location.href,item?.id);if(item)window.history.pushState(null,"",next);else window.history.replaceState(null,"",next);}
  };
  const changeReviewProfile=(next:string)=>{
    if(!profiles.includes(next))return;
    navigationSequence.current++;
    requestGate.switchScope(next);
    setProfile(next);setReconcileProfile(next==="all"?"":next);
    setCases([]);setInboxStatus("loading");setRunViews({});
    selectCase(undefined);
  };
  const editId=(side:"todoist"|"calendar",id:string,verified=false,searchedItem?:ProviderObject)=>{
    invalidatePreview();setRepairSelection(current=>editRepairSelection(current,side,id,verified,searchedItem));
  };
  const setTaskId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("todoist",id,verified,searchedItem);
  const setEventId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("calendar",id,verified,searchedItem);
  const refresh=async (signal?:AbortSignal)=>{
    const ticket=requestGate.begin("inbox",profile);
    if(!ticket)return;
    setInboxStatus("loading");
    try {
      const data=await api(`cases?profile=${profile}&history=${history}`,signal?{signal}:undefined);
      if(requestGate.current(ticket)){setCases(data.items||[]);setInboxStatus("ready");}
    } catch(error:any) {
      if(requestGate.current(ticket)&&!isAbortError(error)){setCases([]);setInboxStatus("error");}
      throw error;
    }
  };
  const refreshReconciliation=async(forProfile:string,options:{signal?:AbortSignal;quiet?:boolean}={})=>{
    if(!SYNC_PROFILES.includes(forProfile))return undefined;
    const ticket=requestGate.begin(`reconcile:${forProfile}`,profile);
    if(!ticket)return undefined;
    if(!options.quiet)setRunViews(current=>({...current,[forProfile]:{status:"loading",diagnostics:[]}}));
    try {
      const data=await api(`reconciliation?profile=${forProfile}`,options.signal?{signal:options.signal}:undefined);
      if(!requestGate.current(ticket))return undefined;
      const generation=data.reconciliation?.generation;
      const diagnostics=generation?await api(
        `reconciliation/diagnostics?profile=${forProfile}&generation=${encodeURIComponent(generation)}`,
        options.signal?{signal:options.signal}:undefined):undefined;
      if(requestGate.current(ticket)){
        setRunViews(current=>({...current,[forProfile]:{
          status:"ready",data,diagnostics:diagnostics?.items||[],cursor:diagnostics?.next,
        }}));
        return data;
      }
      return undefined;
    } catch(error:any) {
      if(!isAbortError(error)&&requestGate.current(ticket)){
        setRunViews(current=>({...current,[forProfile]:{
          status:"error",diagnostics:[],error:error.message,
        }}));
      }
      throw error;
    }
  };
  const loadMoreReconciliationDiagnostics=async(forProfile:string)=>{
    const view=runViews[forProfile],generation=view?.data?.reconciliation?.generation,cursor=view?.cursor;
    if(!generation||!cursor)return;
    const ticket=requestGate.begin(`more:${forProfile}`,profile);
    if(!ticket)return;
    try {
      const next=await api(`reconciliation/diagnostics?profile=${forProfile}&generation=${encodeURIComponent(generation)}&after=${encodeURIComponent(cursor)}`);
      if(!requestGate.current(ticket))return;
      setRunViews(current=>{
        const existing=current[forProfile];
        if(existing?.data?.reconciliation?.generation!==generation||existing.cursor!==cursor)return current;
        return {...current,[forProfile]:{...existing,diagnostics:[...existing.diagnostics,...(next.items||[])],cursor:next.next}};
      });
    } catch(error:any) {if(requestGate.current(ticket)&&!isAbortError(error))setMessage(error.message);}
  };
  useEffect(() => {
    const caseId = new URLSearchParams(location.search).get("case");
    if (!caseId) return;
    const controller=new AbortController();
    const navigationId=++navigationSequence.current;
    api(`cases/${encodeURIComponent(caseId)}`,{signal:controller.signal})
      .then(data=>{if(!controller.signal.aborted&&navigationId===navigationSequence.current)selectCase(data.item,{syncUrl:false});})
      .catch(e=>{if(!controller.signal.aborted&&navigationId===navigationSequence.current&&!isAbortError(e))setMessage(e.message);});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    const onPopState=()=>{
      const caseId=new URLSearchParams(location.search).get("case");
      if(!caseId){selectionVersion.current++;selectCase(undefined,{syncUrl:false});return;}
      const navigationId=++navigationSequence.current;
      api(`cases/${encodeURIComponent(caseId)}`).then(data=>{
        if(navigationId!==navigationSequence.current)return;
        selectionVersion.current++;selectCase(data.item,{syncUrl:false});
      }).catch((error:any)=>{if(navigationId===navigationSequence.current)setMessage(error.message);});
    };
    window.addEventListener("popstate",onPopState);
    return()=>window.removeEventListener("popstate",onPopState);
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    setCases([]);setInboxStatus("loading");
    refresh(controller.signal).catch(e=>{if(!controller.signal.aborted&&!isAbortError(e))setMessage(e.message);});
    return ()=>controller.abort();
  },[profile,history]);
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
  useEffect(()=>{
    // Switching filters invalidates every older profile response, including
    // the home -> work -> home race. Never render the previous scope as current.
    requestGate.switchScope(profile);
    setRunViews({});
    const controller=new AbortController();
    for(const target of reconciliationScopes(profile)) {
      refreshReconciliation(target,{signal:controller.signal}).catch(e=>{
        if(!controller.signal.aborted&&!isAbortError(e))setMessage(`Could not load reconciliation for ${target}: ${e.message}`);
      });
    }
    return ()=>controller.abort();
  },[profile]);
  const pollingProfiles=overviewProfiles.filter(target=>{
    const data=runViews[target]?.data;
    const status=data?.summary?.runStatus||data?.reconciliation?.status;
    return Boolean(data?.reconciliation?.pending&&!["succeeded","needs_review","failed"].includes(status||""));
  });
  const pollingKey=pollingProfiles.map(target=>`${target}:${runViews[target]?.data?.reconciliation?.generation}:${runViews[target]?.data?.reconciliation?.status}`).join("|");
  useEffect(()=>{
    if(!pollingKey)return;
    let cancelled=false,timer:number,pollFailures=0;
    const targets=[...pollingProfiles];
    const poll=async()=>{
      try{
        const updates=await Promise.all(targets.map(target=>refreshReconciliation(target,{quiet:true})));
        if(cancelled)return;
        pollFailures=0;
        let keepPolling=false;
        updates.forEach((data,index)=>{
          if(!data)return;
          const status=data.summary?.runStatus||data.reconciliation?.status||"unknown";
          if(["succeeded","needs_review","failed"].includes(status)||!data.reconciliation?.pending){
            setMessage(`Run for ${targets[index]}: ${status}. ${data.summary?.actionableCaseCount??"Some"} actionable profile alerts remain.`);
            setTerminalInboxRefreshPending(true);
          }else keepPolling=true;
        });
        if(keepPolling)timer=window.setTimeout(poll,reconciliationPollDelayMs(0));
      }catch(e:any){
        if(!cancelled&&!isAbortError(e)){pollFailures++;setMessage(e.message);timer=window.setTimeout(poll,reconciliationPollDelayMs(pollFailures));}
      }
    };
    timer=window.setTimeout(poll,reconciliationPollDelayMs(0));
    return ()=>{cancelled=true;window.clearTimeout(timer);};
  },[profile,pollingKey]);
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
  const displaySnapshot=(sideName:"todoist"|"calendar") => {
    const matches=details?.snapshots?.filter((s:any)=>s.ref.profile===selected?.profile&&s.ref.side===sideName)||[];
    const requestedId=sideName==="todoist"?taskId:eventId;
    const current=matches.find((s:any)=>s.ref.id===requestedId)||(!requestedId&&matches.length===1?matches[0]:undefined);
    const item=current?.object as ProviderObject|undefined;
    if (!item) return <p>{current?`The provider could not find ${sideName} item ${current.ref.id}.`:requestedId?`No live provider snapshot is available for recorded ${sideName} ID ${requestedId}.`:`No ${sideName} item ID is attached to this alert. Search for the item below to continue.`}</p>;
    const start=sideName==="todoist"?(item.due?.datetime||item.due?.date):(item.start?.dateTime||item.start?.date);
    const end=sideName==="calendar"?(item.end?.dateTime||item.end?.date):undefined;
    const recurrence=sideName==="todoist"?(item.due?.is_recurring?item.due.string||"Recurring":"None"):(item.recurrence?.join(" · ")||(item.recurringEventId?"Part of a recurring series":"None"));
    const href=providerLink(item,sideName);
    const seriesAssociation=current.recurrence
      ? `Todoist ${current.recurrence.taskId} ↔ Calendar occurrence ${current.recurrence.activeInstanceId||current.recurrence.eventId} · series master ${current.recurrence.masterEventId} (${current.recurrence.owner}-owned)`
      : undefined;
    return <><IdentityDetails value={current} />{current.includedBy?.length>0&&<p className="relationship-reasons">Included because: {current.includedBy.join("; ")}</p>}{sideName==="calendar"&&item.status==="cancelled"&&<p className="warning">Cancelled / deleted in Google Calendar. Its retained URL is not an active event link.</p>}{href&&<p><a href={href} target="_blank" rel="noreferrer">Open in {sideName==="todoist"?"Todoist":"Google Calendar"}</a></p>}<dl><dt>Date</dt><dd>{start||"Not set"}{end?` → ${end}`:""}</dd><dt>Description</dt><dd>{item.description||"None"}</dd><dt>Recurrence</dt><dd>{recurrence}</dd><dt>Existing counterpart</dt><dd>{current.mapping?`${current.mapping.taskId} ↔ ${current.mapping.eventId}`:seriesAssociation||"No mapping recorded"}</dd></dl><small>Checked {current.checkedAt?new Date(current.checkedAt).toLocaleString():"just now"}</small><details><summary>Provider details</summary><pre>{JSON.stringify(item,null,2)}</pre></details></>;
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
    try {
      // Rechecking provider objects never needs a chosen mutation. Read-only
      // GET can hydrate searched IDs and links without a fabricated action.
      const query=new URLSearchParams({taskId:taskId||"",eventId:eventId||""});
      const result=await api(`cases/${encodeURIComponent(selected.id)}/affected?${query}`);
      if(requestVersion!==selectionVersion.current)return;
      if(result.item?.id!==selected.id||result.item?.profile!==selected.profile)throw new Error("Case changed during recheck");
      setDetails((current:any)=>current?.item?.id===selected.id?{...current,item:result.item,snapshots:result.snapshots}:current);
      setRepairSelection(current=>reconcileRepairSelection(result.item,result.snapshots,current));setLeftovers({});
      if(operationResumeEligibility(operation)==="fresh-preview") {
        const refreshedSelection=reconcileRepairSelection(result.item,result.snapshots,emptyRepairSelection(result.item));
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
  const runReconciliation=async()=>{
    // The rendered target and the POST body are derived from one value. There
    // is deliberately no "all" target or automatic multi-profile fan-out.
    const target=manualTarget;
    if(!target){setMessage("Choose one sync profile before requesting reconciliation.");return;}
    if(selected?.decision?.type==="operational_reconciliation_stuck"
      && !window.confirm(`Request reconciliation for ${target}? This removes quarantined DLQ messages for this profile and reads current provider state. It does not replay the failed delivery.`))return;
    const ticket=requestGate.begin(`manual:${target}`,profile);
    if(!ticket)return;
    setBusy(true);setMessage("");
    try{
      const result=await api("reconciliation",{method:"POST",body:JSON.stringify({profile:target})});
      if(!requestGate.current(ticket))return;
      setRunViews(current=>({...current,[target]:{
        status:"ready",data:{reconciliation:result.run,summary:result.summary},diagnostics:[],
      }}));
      const cleared=result.clearedDlq?.deleted||0;
      setMessage(`Cleared ${cleared} quarantined ${cleared===1?"delivery":"deliveries"} for ${target}. Reconciliation requested${result.reconciliation?.created?" with a new generation":"; the active generation was retained"}. ${result.summary?.actionableCaseCount??"Some"} actionable review case(s) remain for this profile; run diagnostics and inbox counts are tracked separately.`);
      refreshReconciliation(target,{quiet:true}).catch(e=>{
        if(requestGate.current(ticket)&&!isAbortError(e))setMessage(`Reconciliation requested for ${target}, but status refresh failed: ${e.message}`);
      });
    }catch(error:any){
      if(requestGate.current(ticket))setMessage(error.message);
    }finally{if(requestGate.current(ticket))setBusy(false);}
  };
  const dismissAlert=async () => {
    if(!selected||selected.status!=="open")return;
    const dismissedCaseId=selected.id;
    const selectedVersion=selectionVersion.current;
    setBusy(true);setMessage("");
    try {
      await api(`cases/${encodeURIComponent(dismissedCaseId)}/dismiss`,{method:"POST",body:"{}"});
      // Do not discard another case that the operator selected while the request was pending.
      if(selectedVersion===selectionVersion.current)selectCase(undefined);
      await refresh();
      setMessage("Alert dismissed. Select another alert, or show history to revisit it.");
    }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const decisionActions=capabilities.summary.decisionActions||[];
  const recordedIds=recordedPrimaryProviderIds(selected);
  const recordedTaskId=recordedIds.taskId, recordedEventId=recordedIds.eventId;
  const verifiedRepairTarget=Boolean((taskId&&repairSelection.verifiedTaskId===taskId)
    ||(eventId&&repairSelection.verifiedEventId===eventId));
  const snapshots=details?.snapshots||[];
  const affectedGroups=groupAffectedSnapshots(snapshots);
  const showDispositions=Boolean(formFields.dispositions&&(action==="separate"||requiredDispositionRef
    ||snapshots.some((item:any)=>item?.object
      && (item.ref.side==="todoist"?item.ref.id!==taskId:item.ref.id!==eventId))));
  const choiceKey=(item:any)=>`${item.ref.profile}:${item.ref.side}:${item.ref.id}`;
  const availableSearchResults=searchResults.filter(item=>item._caseId===selected?.id&&item._profile===selected?.profile&&item._side===searchSide);
  const hasLiveIdentity=snapshots.some((snapshot:any)=>snapshot.ref?.profile===selected?.profile&&providerIdentity(snapshot).identified);
  const hasPrimaryProviderIds=Boolean(selected?.taskId||selected?.eventId||selected?.decision?.taskId||selected?.decision?.eventId
    ||alertContext.providerTaskId||alertContext.providerEventId);
  const showProviderPanels=Boolean(hasPrimaryProviderIds||hasLiveIdentity);
  const openCaseCount=cases.filter(item=>item.status==="open"||item.status==="repairing").length;
  return <main>
    <header><div><h1>Calendar sync review</h1><p>Review conflicts using current Todoist and Calendar data.</p></div>
      <div className="header-actions"><label>Review alerts — profile <select aria-label="Review alerts — profile" value={profile} onChange={e=>changeReviewProfile(e.target.value)}>{profiles.map(p=><option key={p} value={p}>{p==="all"?"All profiles":p}</option>)}</select></label>
        <a className="logout" href="https://alf1000.cloudflareaccess.com/cdn-cgi/access/logout">Sign out</a></div>
    </header>
    {message&&<p className="notice" role="status">{message}</p>}
    {profile==="all"&&<p className="notice">All profiles shows separate reconciliation runs for home, antonio and work. The combined review-alert list is not a reconciliation run and does not trigger any provider actions.</p>}
    {overviewProfiles.map(runProfile=>{
      const view=runViews[runProfile];
      const reconciliation=view?.data;
      const latestRun=reconciliation?.reconciliation;
      const summary=reconciliation?.summary;
      const latestRunAt=latestRun?.lastCompletedAt||latestRun?.lastFailedAt||latestRun?.lastStartedAt||latestRun?.requestedAt;
      return <React.Fragment key={runProfile}>
        <section className="preview reconciliation-overview" aria-label={`Latest reconciliation for ${runProfile}`}>
          <h2>Latest reconciliation · {runProfile}</h2>
          {(!view||view.status==="loading")&&<p role="status">Loading reconciliation state for {runProfile}…</p>}
          {view?.status==="error"&&<p className="warning" role="status">Could not load reconciliation for {runProfile}: {view.error}. This is not evidence of a successful or failed run.</p>}
          {view?.status==="ready"&&!summary&&<p>No recorded reconciliation summary for {runProfile}.</p>}
          {view?.status==="ready"&&summary&&<>
            <dl className="overview-grid">
              <dt>Run status</dt><dd>{(summary.runStatus||"unknown").replaceAll("_"," ")}{latestRun?.pending?" · in progress":""}</dd>
              <dt>Generation</dt><dd>{latestRun?.generation||"Not recorded"}</dd>
              <dt>Last run activity</dt><dd>{latestRunAt?new Date(latestRunAt).toLocaleString():"Not recorded"}</dd>
              <dt>Unresolved diagnostic counter for {runProfile}</dt><dd>{summary.runUnresolved??"Not recorded"}</dd>
              <dt>Items counted as blocked in this run</dt><dd>{typeof latestRun?.result?.blocked==="number"?latestRun.result.blocked:"Not recorded"}</dd>
              <dt>Actionable review cases for {runProfile}</dt><dd>{summary.actionableCaseCount??"Not recorded"}</dd>
            </dl>
            <p>These are {runProfile}-only reconciliation results. The unresolved and blocked figures describe run diagnostics, not the number of open alerts in the review filter. Actionable cases are counted separately from run results and from the inbox list.</p>
          </>}
        </section>
        {view?.status==="ready"&&latestRun?.generation&&<section className="preview reconciliation-items" aria-label={`Run diagnostics for ${runProfile}`}>
          <h3>Run diagnostics · {runProfile}</h3>
          <p>Generation {latestRun.generation} · {latestRunAt?`activity ${new Date(latestRunAt).toLocaleString()}`:"run timestamp not recorded"}. These per-run diagnostics are not open-alert counts and this report does not change provider data.</p>
          {view.diagnostics.length===0?<p>No per-item diagnostics were recorded for this generation.</p>:<ul>
            {view.diagnostics.map((item:any,index:number)=><li key={`${item.action}:${item.taskId||""}:${item.eventId||""}:${index}`}>
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
          {view.cursor&&<button className="secondary" onClick={()=>loadMoreReconciliationDiagnostics(runProfile)}>Load more diagnostics for {runProfile}</button>}
        </section>}
      </React.Fragment>;
    })}
    <ErasurePanel api={api} />
    <div className="layout"><nav aria-label="Open review alerts"><h2>{history?"Review alert history":"Open review alerts"}</h2><p>{inboxStatus==="loading"?`Loading review alerts for ${reviewScopeLabel(profile)}…`:inboxStatus==="error"?`Unable to load review alerts for ${reviewScopeLabel(profile)}.`:`${openCaseCount} open or repairing review alerts in ${reviewScopeLabel(profile)}${history?` · ${cases.length} total history entries shown`:""}.`}</p><label className="history-toggle"><input type="checkbox" checked={history} onChange={e=>{setCases([]);setInboxStatus("loading");setHistory(e.target.checked);selectCase(undefined);}} /> Show dismissed and resolved cases</label>{cases.map(item=><button className={`case ${selected?.id===item.id?"active":""}`} key={item.id} onClick={()=>selectCase(item)}><strong>{item.title}</strong><span>{item.profile} · {item.status}</span><small>{item.reason}</small></button>)}{inboxStatus==="ready"&&cases.length===0&&<p>{history?"No conflict history.":"No open review alerts."}</p>}</nav>
      <section className="detail">{!selected?<><p>Select a conflict to inspect its live provider data.</p><div className="preview"><h3>Manual reconciliation · single profile</h3>
          {profile==="all"&&<label>Choose reconciliation target<select aria-label="Manual reconciliation target" value={reconcileProfile} onChange={e=>setReconcileProfile(e.target.value)}>
            <option value="">Select a profile — no reconciliation requested</option>
            {SYNC_PROFILES.map(p=><option key={p} value={p}>{p}</option>)}
          </select></label>}
          <p>Target sync profile: <strong>{manualTarget||"Choose one profile above"}</strong>. This action runs only for the indicated profile; changing the review-alert filter never starts reconciliation.</p>
          <button onClick={runReconciliation} disabled={busy||!manualTarget}>Run reconciliation {manualTarget?`for ${manualTarget}`:"(select profile)"}</button>
          {manualTarget&&runViews[manualTarget]?.data&&<details><summary>Latest status for {manualTarget}</summary><pre>{JSON.stringify(runViews[manualTarget].data,null,2)}</pre></details>}
        </div></>:<>
        <div className="title"><div><h2>{selected.title}</h2><p>{selected.profile} · {selected.reason.replaceAll("_"," ")} · opened {new Date(selected.createdAt).toLocaleString()}</p></div></div>
        <section className="preview alert-evidence">
          <details><summary>Recorded alert evidence</summary>
            <pre>{JSON.stringify(selected.decision?.context||{},null,2)}</pre>
            {selected.decision?.type?.startsWith("operational_")&&selected.decision?.type!=="operational_reconciliation_stuck"&&<p>A failed delivery is not replayed. Search for current items and preview a guarded repair, or request a fresh reconciliation.</p>}
          </details>
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
            {recordedTaskId&&<label>Todoist ID recorded on alert
              <input value={recordedTaskId} readOnly aria-label="Recorded Todoist task ID" />
              <small>Provider status: {recordedProviderState("todoist",recordedTaskId,snapshots,selected?.profile)}. Historical evidence; not automatically an actionable repair target.</small>
            </label>}
            {recordedEventId&&<label>Calendar ID recorded on alert
              <input value={recordedEventId} readOnly aria-label="Recorded Calendar event ID" />
              <small>Provider status: {recordedProviderState("calendar",recordedEventId,snapshots,selected?.profile)}. Historical evidence; not automatically an actionable repair target.</small>
            </label>}
            <div className="item-identity" role="status" aria-live="polite">
              <strong>Current repair context</strong>
              <span>Todoist: {capabilities.summary.task}{capabilities.summary.verifiedTaskId&&` · ${capabilities.summary.verifiedTaskId}`}</span>
              <span>Calendar: {capabilities.summary.event}{capabilities.summary.verifiedEventId&&` · ${capabilities.summary.verifiedEventId}`}</span>
              <span>Association: {capabilities.summary.mapping} · recurrence: {capabilities.summary.recurrence}</span>
              <small>{capabilities.summary.reason} Historical alert evidence is shown separately above.</small>
            </div>
            {!capabilities.actions.length&&<p className="notice" role="status">No currently eligible repair action. Recurrence cannot be inferred from a missing item. Recheck items (no changes), find an existing live item, run profile reconciliation, or dismiss the alert only.</p>}
            {capabilities.actions.length>0&&<>
              <label>What would you like to do?
                <select aria-label="Recommended repair action" value={currentAction?.tier==="common"?action:""} onChange={e=>chooseRepairAction(e.target.value)}>
                  <option value="">Choose an action (no changes)</option>
                  {capabilities.actions.filter((item:any)=>item.tier==="common").map((item:any)=><option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              {currentAction&&<p className="action-explanation">{currentAction.explanation} A backend-validated preview and separate Apply step are still required.</p>}
              {capabilities.actions.some((item:any)=>item.tier==="advanced")&&<details>
                <summary>Advanced repairs — specialised operations</summary>
                <label>Advanced repair action
                  <select aria-label="Advanced repair action" value={currentAction?.tier==="advanced"?action:""} onChange={e=>chooseRepairAction(e.target.value)}>
                    <option value="">Choose a specialised action</option>
                    {capabilities.actions.filter((item:any)=>item.tier==="advanced").map((item:any)=><option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              </details>}
            </>}
            <details><summary>Why aren't other actions shown?</summary>
              <p>Only options with verified current provider evidence are selectable. Backend preview and apply checks still decide whether they are safe.</p>
              <ul>{capabilities.unavailable.map((item:any)=><li key={item.id}><strong>{item.label}:</strong> {item.reason}</li>)}</ul>
            </details>
            {Boolean(action&&taskId)&&(!recordedTaskId||Boolean(taskId&&taskId!==recordedTaskId))&&<label>Todoist task for repair<input value={taskId} readOnly placeholder="Find a verified Todoist task" aria-invalid={validationError?.field==="taskId"} /><small>Exact verified ID. Use Find existing item to choose another.</small>{validationError?.field==="taskId"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {Boolean(action&&eventId&&action!=="move")&&(!recordedEventId||Boolean(eventId&&eventId!==recordedEventId))&&<label>Calendar event for repair<input value={eventId} readOnly placeholder="Find a verified Calendar event" aria-invalid={validationError?.field==="eventId"} /><small>Exact verified ID. Use Find existing item to choose another.</small>{validationError?.field==="eventId"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
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
            {action==="create"&&<p className="notice">Verified source: {taskId?`Todoist task ${taskId}`:`Calendar event ${eventId}`}. The other side will be created only after an explicit preview and Apply repair.</p>}
            {formFields.winner&&<label>Fields to use<select value={action==="transfer"?"none":winner} disabled={action==="transfer"} onChange={e=>{invalidatePreview();setWinner(e.target.value);}} aria-invalid={validationError?.field==="winner"}><option value="none">Keep current fields</option><option value="todoist">Use Todoist fields</option><option value="calendar">Use Calendar fields</option></select>{action==="transfer"&&<small>The transfer preserves the Todoist task's existing recurrence and fields.</small>}{validationError?.field==="winner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {formFields.owner&&<label>Recurrence owner {ownerRequirement&&<strong>(required)</strong>}<select value={owner} onChange={e=>{invalidatePreview();setOwner(e.target.value);}} required={Boolean(ownerRequirement)} aria-invalid={validationError?.field==="owner" || Boolean(ownerRequirement&&!owner)} aria-describedby={ownerRequirement?"recurrence-owner-help":undefined}><option value="">{ownerRequirement?"Choose a recurrence owner":"No recurrence / leave unchanged"}</option><option value="todoist">Todoist</option><option value="calendar">Calendar</option></select>{ownerExplanation&&<small id="recurrence-owner-help">{ownerExplanation}</small>}{validationError?.field==="owner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {formFields.scope&&<label>Recurrence scope<select value={scope} onChange={e=>{invalidatePreview();setScope(e.target.value);}} aria-invalid={validationError?.field==="scope"}><option value="occurrence">This occurrence</option><option value="series">Entire series</option><option value="future">Future occurrences (preserve history)</option></select>{validationError?.field==="scope"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {action==="move"&&<label>Destination account<select value={targetProfile} onChange={e=>{invalidatePreview();setTargetProfile(e.target.value);}}><option value="">Choose account</option>{profiles.filter(p=>p!=="all"&&p!==selected.profile).map(p=><option key={p}>{p}</option>)}</select></label>}
            {action==="decision"&&<label>Slack decision<select value={decisionAction} onChange={e=>{invalidatePreview();setDecisionAction(e.target.value);}}><option value="">Choose an allowed action</option>{decisionActions.map((item:any)=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
          </div>
          {(!verifiedRepairTarget||!action||formFields.counterpartSearch)&&<details open={!verifiedRepairTarget}><summary>Find existing item / choose a different verified counterpart</summary>
          <div className="search"><label>Find counterpart<select value={searchSide} onChange={e=>{setSearchSide(e.target.value);setSearchResults([]);}}><option value="todoist">Todoist task</option><option value="calendar">Calendar event</option></select></label><input value={searchText} onChange={e=>setSearchText(e.target.value)} placeholder="Search titles or descriptions" onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void search();}}} /><button className="secondary" onClick={search} disabled={busy||searchText.trim().length<2}>Search</button></div>
          {availableSearchResults.length>0&&<ul className="results">{availableSearchResults.map(item=><li key={item.id}><IdentityDetails value={item} scope={scope} /><button className="secondary" disabled={!providerIdentity(item).selectable} onClick={()=>searchSide==="todoist"?setTaskId(item.id,true,item):setEventId(item.id,true,item)}>Use this item</button></li>)}</ul>}
          </details>}
          <button className="secondary" onClick={refreshAffected} disabled={busy||!details}>Recheck items (no changes)</button>
          {showDispositions&&<div><h4>{action==="separate"?"Separate these items":"Disposition for other affected items"}</h4><p>Each row identifies the exact provider object, the recorded relationship that included it, and whether a disposition is required for this repair.</p>{action==="transfer"&&<p className="warning">Delete is limited to exact standalone one-off duplicates with no retained completion history. Recurrences, occurrences, incomplete mappings, and historical items will be rejected by the preview.</p>}{affectedGroups.map((group:any)=><section className="affected-group" key={group.key}>{group.seriesId||group.masterId?<h5>Recurring series group · {group.seriesId?`series ${group.seriesId}`:`master ${group.masterId}`}{group.masterId?` · Calendar master ${group.masterId}`:""}</h5>:null}{group.items.map((item:any)=><AffectedItem key={choiceKey(item)} item={item} action={action} taskId={taskId} eventId={eventId} scope={formFields.scope?scope:undefined} snapshots={snapshots} leftovers={leftovers} updateLeftover={updateLeftover} choiceKey={choiceKey} requiredDispositionRef={requiredDispositionRef}/>)}</section>)}</div>}
          {!canPreview&&Boolean(action)&&details&&<p className="warning" role="status">{ownerRequirement&&!owner?"Preview disabled: choose a recurrence owner above.":"Preview disabled: the selected live identities no longer satisfy this action. Recheck provider state and choose again."}</p>}
          {Boolean(currentAction)&&<button onClick={createPreview} disabled={busy||!canPreview}>{busy?"Working…":"Preview repair (no changes)"}</button>}
          <button className="secondary reconcile-button" onClick={runReconciliation} disabled={busy}>{selected.decision?.type==="operational_reconciliation_stuck"?`Request fresh reconciliation for ${selected.profile}`:`Run reconciliation for ${selected.profile}`}</button>
          <p className="action-explanation">Run reconciliation scans the whole profile; it does not apply this one-case repair. Dismissing an alert hides the notification only and does not fix provider data or mappings.</p>
          {selected.status==="open"&&<button className="secondary dismiss-button" onClick={dismissAlert} disabled={busy}>Dismiss alert only</button>}
          {selected&&runViews[selected.profile]?.data&&<details><summary>Reconciliation status · {selected.profile}</summary><pre>{JSON.stringify(runViews[selected.profile].data,null,2)}</pre></details>}
        </div>
        {validPreview&&<section className="preview"><h3>Review planned changes</h3><p>This preview expires at {new Date(validPreview.expiresAt*1000).toLocaleString()}.</p>{formFields.scope&&<p>Selected recurrence scope: <strong>{scopeLabel(validPreview.intent.scope)}</strong></p>}<h4>Affected provider items and their outcomes</h4><ul className="preview-items">{validPreview.snapshots.map((item:any)=>{const plan=previewEffect(item,validPreview.intent,validPreview.itemPlan?.find((entry:any)=>choiceKey(entry)===choiceKey(item)));return <li key={choiceKey(item)}><IdentityDetails value={item} scope={formFields.scope?validPreview.intent.scope:undefined} />{item.includedBy?.length>0&&<p className="relationship-reasons">Included because: {item.includedBy.join("; ")}</p>}<div><strong>Operation:</strong> {plan.operation}</div><div><strong>Resulting disposition / mapping:</strong> {plan.result}</div>{item.mapping&&<div>Existing mapping: Todoist {item.mapping.taskId} ↔ Calendar {item.mapping.eventId}{item.mapping.masterEventId&&` · master ${item.mapping.masterEventId}`}</div>}{item.control?.excluded&&<div>Currently excluded</div>}{item.checkedAt&&<small>Checked {new Date(item.checkedAt).toLocaleString()}</small>}</li>;})}</ul><h4>Planned changes</h4><ul>{validPreview.changes.map((change,i)=><li key={i}>{change}</li>)}</ul>{validPreview.splitPlan&&<dl><dt>Historical Calendar rule</dt><dd>{validPreview.splitPlan.originalRule}</dd><dt>Rule after repair</dt><dd>{validPreview.splitPlan.truncatedRule}</dd><dt>Future recurrence starts</dt><dd>{validPreview.splitPlan.newStart}</dd><dt>Future RRULE</dt><dd>{validPreview.splitPlan.newRule}</dd><dt>Calendar timezone</dt><dd>{validPreview.splitPlan.calendarTimeZone}</dd>{validPreview.splitPlan.expiredUntil&&<><dt>Existing series expired</dt><dd>{validPreview.splitPlan.expiredUntil}; historical rule will not be extended</dd></>}</dl>}<h4>Warnings</h4><ul>{validPreview.warnings.map((warning,i)=><li className="warning" key={i}>{warning}</li>)}</ul><button onClick={applyPreview} disabled={busy||!canPreview}>{busy?"Submitting…":"Apply repair"}</button><button className="secondary" onClick={()=>setPreview(undefined)}>Cancel</button></section>}
        {operation&&<section className="preview"><h3>Repair status: {operation.status.replaceAll("_"," ")}</h3><p>Operation {operation.id} · attempt {operation.attempt}</p>{operation.error&&<p className="warning">{operation.error}</p>}{operation.nextAction&&<p>{operation.nextAction}</p>}{operation.notificationText&&<p>{operation.notificationText}</p>}{operation.status==="queued"&&<p>This repair is serialized with other work for {selected?.profile||"this profile"}. Retrying creates a fresh queue delivery; completed repair steps remain checkpointed.</p>}{operation.steps&&<ul>{Object.entries(operation.steps).map(([name,step])=><li key={name}>{name}: {step.status}</li>)}</ul>}{operation.outcomes&&<ul>{operation.outcomes.map(item=><li key={item.entity}>{item.entity}: {item.outcome}</li>)}</ul>}{operationResumeEligibility(operation)==="fresh-preview"?<><p>This failed operation has no recorded provider write. Refresh affected items and create a new preview; the old operation will remain available for audit.</p><button className="secondary" onClick={refreshAffected} disabled={busy}>Refresh and create new preview</button></>:operationResumeEligibility(operation)==="resume"&&<button onClick={resume} disabled={busy}>{operation.status==="queued"?"Retry queue delivery":"Resume operation"}</button>}</section>}
      </>}</section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
