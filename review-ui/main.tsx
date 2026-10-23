import React, { useEffect, useRef, useState } from "react";
import { createReviewApiClient, isAbortError } from "./api-client.mjs";
import { emptyRepairSelection, reconcileRepairSelection, editRepairSelection, repairPreviewAllowed, repairRecurrenceOwnerRequirement, repairValidationField, missingDispositionReference, operationResumeEligibility } from "./repair-selection.mjs";
import { createRoot } from "react-dom/client";
import { providerIdentity, dispositionOptions, scopeLabel, previewEffect } from "./item-identity.mjs";

type Case = { id:string; profile:string; title:string; reason:string; status:string; taskId?:string; eventId?:string; createdAt:string; decision?:any; operationId?:string; result?:string; reconciliationGeneration?:string; progressCheckpoint?:any };
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
function App() {
  const [cases,setCases] = useState<Case[]>([]), [selected,setSelected] = useState<Case>(), [loadedDetails,setDetails] = useState<any>(), [profile,setProfile] = useState("home"), [history,setHistory] = useState(false);
  const [message,setMessage] = useState(""), [busy,setBusy] = useState(false);
  const [action,setAction] = useState("link"), [winner,setWinner] = useState("none"), [owner,setOwner] = useState(""), [scope,setScope] = useState("occurrence");
  const [repairSelection,setRepairSelection] = useState(emptyRepairSelection()), [targetProfile,setTargetProfile] = useState(""), [decisionAction,setDecisionAction] = useState("");
  const [leftovers,setLeftovers] = useState<Record<string,string>>({});
  const [searchSide,setSearchSide] = useState("todoist"), [searchText,setSearchText] = useState(""), [searchResults,setSearchResults] = useState<any[]>([]);
  const [preview,setPreview] = useState<RepairPreview>(), [operation,setOperation] = useState<RepairOperation>();
  const [submitKey,setSubmitKey] = useState("");
  const [reconcileProfile,setReconcileProfile] = useState("home"), [reconciliation,setReconciliation] = useState<any>();
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
      && dispositionOptions(s).length>0 && (!disposition || dispositionOptions(s).includes(disposition))));
  const validPreview=canPreview && preview?.intent?.caseId===selected?.id && preview?.intent?.profile===selected?.profile
    && preview?.intent?.taskId===(taskId||undefined) && preview?.intent?.eventId===(eventId||undefined)
    && preview?.intent?.action===action ? preview : undefined;
  const invalidatePreview=()=>{selectionVersion.current++;setPreview(undefined);setSubmitKey("");setValidationError(undefined);};
  const selectCase=(item?:Case)=>{
    invalidatePreview();
    setSelected(item);setDetails(undefined);setRepairSelection(emptyRepairSelection(item));
    setDetailState(item?{key:`${item.profile}:${item.id}`,status:"loading"}:undefined);
    setLeftovers({});setSearchResults([]);setSearchText("");setOperation(undefined);setBusy(false);
    setAction("link");setWinner("none");setOwner("");setScope("occurrence");setTargetProfile("");setDecisionAction("");
  };
  const editId=(side:"todoist"|"calendar",id:string,verified=false,searchedItem?:ProviderObject)=>{
    invalidatePreview();setRepairSelection(current=>editRepairSelection(current,side,id,verified,searchedItem));
  };
  const setTaskId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("todoist",id,verified,searchedItem);
  const setEventId=(id:string,verified=false,searchedItem?:ProviderObject)=>editId("calendar",id,verified,searchedItem);
  const refresh = async () => { const data = await api(`cases?profile=${profile}&history=${history}`); setCases(data.items); };
  const refreshReconciliation = async (forProfile:string) => { const data=await api(`reconciliation?profile=${forProfile}`); setReconciliation(data); return data; };
  useEffect(() => {
    const caseId = new URLSearchParams(location.search).get("case");
    if (!caseId) return;
    const controller=new AbortController();
    api(`cases/${encodeURIComponent(caseId)}`,{signal:controller.signal})
      .then(data=>{if(!controller.signal.aborted){setProfile(data.item.profile);selectCase(data.item);}})
      .catch(e=>{if(!isAbortError(e))setMessage(e.message);});
    return ()=>controller.abort();
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
    const poll=async()=>{
      try {
        const data=await refreshReconciliation(reconcileProfile);
        await refresh();
        if(cancelled)return;
        const runStatus=data.summary?.runStatus||data.reconciliation?.status||"unknown";
        const terminal=["succeeded","needs_review","failed"].includes(runStatus);
        if(terminal||!data.reconciliation?.pending) setMessage(`Run ${runStatus}; ${data.summary?.actionableCaseCount??"some"} actionable review case(s) remain.`);
        else timer=window.setTimeout(poll,1500);
      } catch(e:any) { if(!cancelled){setMessage(e.message);timer=window.setTimeout(poll,3000);} }
    };
    timer=window.setTimeout(poll,1500);
    return ()=>{cancelled=true;window.clearTimeout(timer);};
  },[reconcileProfile,reconciliation?.reconciliation?.generation,reconciliation?.reconciliation?.pending,reconciliation?.summary?.runStatus,reconciliation?.reconciliation?.status]);
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
    if (!item) return <p>{current?`The provider could not find ${sideName} item ${current.ref.id}.`:`No ${sideName} item ID is attached to this alert. Search for the item below to continue.`}</p>;
    const start=sideName==="todoist"?(item.due?.datetime||item.due?.date):(item.start?.dateTime||item.start?.date);
    const end=sideName==="calendar"?(item.end?.dateTime||item.end?.date):undefined;
    const recurrence=sideName==="todoist"?(item.due?.is_recurring?item.due.string||"Recurring":"None"):(item.recurrence?.join(" · ")||(item.recurringEventId?"Part of a recurring series":"None"));
    const href=providerLink(item);
    return <><IdentityDetails value={current} />{href&&<p><a href={href} target="_blank" rel="noreferrer">Open in {sideName==="todoist"?"Todoist":"Google Calendar"}</a></p>}<dl><dt>Date</dt><dd>{start||"Not set"}{end?` → ${end}`:""}</dd><dt>Description</dt><dd>{item.description||"None"}</dd><dt>Recurrence</dt><dd>{recurrence}</dd><dt>Existing counterpart</dt><dd>{current.mapping?`${current.mapping.taskId} ↔ ${current.mapping.eventId}`:"No mapping recorded"}</dd></dl><small>Checked {current.checkedAt?new Date(current.checkedAt).toLocaleString():"just now"}</small><details><summary>Provider details</summary><pre>{JSON.stringify(item,null,2)}</pre></details></>;
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
  const hasProviderIds=Boolean(selected?.taskId||selected?.eventId||alertContext.providerTaskId||alertContext.providerEventId);
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
  const updateLeftover=(key:string,value:string) => {invalidatePreview();setLeftovers(current=>({...current,[key]:value}));};
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
    const intent={action,taskId:taskId||undefined,eventId:eventId||undefined,winner,owner:owner||undefined,scope,leftovers,
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
    const intent={action,taskId:taskId||undefined,eventId:eventId||undefined,winner,owner:owner||undefined,scope,leftovers,
      decisionAction:action==="decision"?decisionAction:undefined,targetProfile:action==="move"?targetProfile:undefined};
    try { const result=await api(`cases/${encodeURIComponent(selected.id)}/previews`,{method:"POST",body:JSON.stringify(intent)});
      if(requestVersion===selectionVersion.current)setPreview(result.preview);
    }
    catch(e:any){
      if (missingDispositionReference(e.message)) {
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
    try { const result=await api(`cases/${encodeURIComponent(selected.id)}/dismiss`,{method:"POST",body:"{}"});selectCase(result.item);await refresh();setMessage("Alert dismissed. Its history remains available for later verification or exclusion."); }
    catch(e:any){setMessage(e.message);} finally{setBusy(false);}
  };
  const decisionActions=(selected?.decision?.permittedActions||[]).filter((item:any)=>item.id!=="reconcile_now");
  const snapshots=details?.snapshots||[];
  const choiceKey=(item:any)=>`${item.ref.profile}:${item.ref.side}:${item.ref.id}`;
  const availableSearchResults=searchResults.filter(item=>item._caseId===selected?.id&&item._profile===selected?.profile&&item._side===searchSide);
  return <main>
    <header><div><h1>Calendar sync review</h1><p>Review conflicts using current Todoist and Calendar data.</p></div>
      <div className="header-actions"><label>Inbox <select value={profile} onChange={e=>{setProfile(e.target.value);selectCase(undefined);}}>{profiles.map(p=><option key={p} value={p}>{p==="all"?"All accounts":p}</option>)}</select></label>
        <a className="logout" href="https://alf1000.cloudflareaccess.com/cdn-cgi/access/logout">Sign out</a></div>
    </header>
    {message && <p className="notice" role="status">{message}</p>}
    {reconciliation?.summary&&<p className="notice" role="status">Run: {reconciliation.summary.runStatus}; unresolved in this run: {reconciliation.summary.runUnresolved}. Actionable review cases remaining: {reconciliation.summary.actionableCaseCount}.</p>}
    <div className="layout"><nav aria-label="Conflicts"><h2>Conflicts</h2><label className="history-toggle"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)} /> Show dismissed and resolved cases</label>{cases.map(item=><button className={`case ${selected?.id===item.id?"active":""}`} key={item.id} onClick={()=>selectCase(item)}><strong>{item.title}</strong><span>{item.profile} · {item.status}</span><small>{item.reason}</small></button>)}{cases.length===0&&<p>{history?"No conflict history.":"No open conflicts."}</p>}</nav>
      <section className="detail">{!selected?<><p>Select a conflict to inspect its live provider data.</p><div className="preview"><h3>Reconciliation</h3><label>Account<select value={reconcileProfile} onChange={e=>setReconcileProfile(e.target.value)}>{profiles.filter(p=>p!=="all").map(p=><option key={p}>{p}</option>)}</select></label><button onClick={runReconciliation} disabled={busy}>Run reconciliation</button>{reconciliation&&<details><summary>Current status</summary><pre>{JSON.stringify(reconciliation,null,2)}</pre></details>}</div></>:<>
        <div className="title"><div><h2>{selected.title}</h2><p>{selected.profile} · {selected.reason.replaceAll("_"," ")} · opened {new Date(selected.createdAt).toLocaleString()}</p></div></div>
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
        </div>:<div className="columns"><article><h3>Todoist</h3>{displaySnapshot("todoist")}</article><article><h3>Calendar</h3>{displaySnapshot("calendar")}</article></div>}
        {selected.status==="dismissed"&&<p className="notice">This alert was dismissed separately from a verified repair. It remains in history until the live relationship is verified or the affected items are explicitly excluded.</p>}
        <p className="change-summary">{alertChanges.length?<>Changed since the alert:<ul>{alertChanges.map((change,i)=><li key={i}>{change}</li>)}</ul></>:originalMapping?mappingChanges.length?`Association changed since the alert: ${mappingChanges.join(", ")}.`:"Association matches the alert snapshot.":"The original alert did not capture comparable provider fields; compare the live provider details above."}</p>
        {selected.result&&<p className="notice">Latest case outcome: {selected.result}</p>}
        {selected.status==="open"&&<button className="secondary" onClick={dismissAlert} disabled={busy}>Dismiss alert only</button>}
        <div className="preview">
          <h3>Repair this conflict</h3>
          <div className="formgrid">
            <label>Action<select value={action} onChange={e=>{invalidatePreview();setAction(e.target.value);}}>{[
              ["link","Link or replace an association"],["separate","Keep items separate"],["create","Create the missing counterpart"],["exclude","Exclude selected items from syncing"],["decision","Apply an existing Slack decision"],["verify","Verify an existing association"],["move","Move task to another account"],
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
            {action==="create"&&<div className="source-choice"><span>Choose which item should get a new counterpart:</span><div><button className="secondary" onClick={()=>setEventId("")}>Create Calendar event from this Todoist task</button><button className="secondary" onClick={()=>setTaskId("")}>Create Todoist task from this Calendar event</button></div></div>}
            {action==="link"&&<label>Fields to use<select value={winner} onChange={e=>{invalidatePreview();setWinner(e.target.value);}} aria-invalid={validationError?.field==="winner"}><option value="none">Keep current fields</option><option value="todoist">Use Todoist fields</option><option value="calendar">Use Calendar fields</option></select>{validationError?.field==="winner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {["link","create"].includes(action)&&<label>Recurrence owner {ownerRequirement&&<strong>(required)</strong>}<select value={owner} onChange={e=>{invalidatePreview();setOwner(e.target.value);}} required={Boolean(ownerRequirement)} aria-invalid={validationError?.field==="owner" || Boolean(ownerRequirement&&!owner)} aria-describedby={ownerRequirement?"recurrence-owner-help":undefined}><option value="">{ownerRequirement?"Choose a recurrence owner":"No recurrence / leave unchanged"}</option><option value="todoist">Todoist</option><option value="calendar">Calendar</option></select>{ownerExplanation&&<small id="recurrence-owner-help">{ownerExplanation}</small>}{validationError?.field==="owner"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {["link","separate","create","exclude","verify"].includes(action)&&<label>Recurrence scope<select value={scope} onChange={e=>{invalidatePreview();setScope(e.target.value);}} aria-invalid={validationError?.field==="scope"}><option value="occurrence">This occurrence</option><option value="series">Entire series</option><option value="future">Future occurrences (preserve history)</option></select>{validationError?.field==="scope"&&<small className="field-error" role="alert">{validationError.message}</small>}</label>}
            {action==="move"&&<label>Destination account<select value={targetProfile} onChange={e=>{invalidatePreview();setTargetProfile(e.target.value);}}><option value="">Choose account</option>{profiles.filter(p=>p!=="all"&&p!==selected.profile).map(p=><option key={p}>{p}</option>)}</select></label>}
            {action==="decision"&&<label>Slack decision<select value={decisionAction} onChange={e=>{invalidatePreview();setDecisionAction(e.target.value);}}><option value="">Choose an allowed action</option>{decisionActions.map((item:any)=><option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
          </div>
          <div className="search"><label>Find counterpart<select value={searchSide} onChange={e=>{setSearchSide(e.target.value);setSearchResults([]);}}><option value="todoist">Todoist task</option><option value="calendar">Calendar event</option></select></label><input value={searchText} onChange={e=>setSearchText(e.target.value)} placeholder="Search titles or descriptions" onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void search();}}} /><button className="secondary" onClick={search} disabled={busy||searchText.trim().length<2}>Search</button></div>
          {availableSearchResults.length>0&&<ul className="results">{availableSearchResults.map(item=><li key={item.id}><IdentityDetails value={item} scope={scope} /><button className="secondary" disabled={!providerIdentity(item).selectable} onClick={()=>searchSide==="todoist"?setTaskId(item.id,true,item):setEventId(item.id,true,item)}>Use this item</button></li>)}</ul>}
          <button className="secondary" onClick={refreshAffected} disabled={busy||!details}>Refresh affected items</button>
          {snapshots.length>0&&<div><h4>{action==="separate"?"Separate these items":"Disposition for other affected items"}</h4><p>Each row identifies the exact provider object. Check its date, recurrence, status and ID before assigning a disposition.</p>{snapshots.map((item:any)=>{const key=choiceKey(item);const selectedItem=(item.ref.side==="todoist"?item.ref.id===taskId:item.ref.id===eventId);if(selectedItem&&action!=="separate")return null;const options=dispositionOptions(item);return <div className="leftover" key={key}><IdentityDetails value={item} scope={scope} />{!item.object?<p>No live provider object; no disposition is available.</p>:<label>Disposition<select aria-label={`Disposition for ${key}`} disabled={options.length===0} value={options.includes(leftovers[key])?leftovers[key]:""} onChange={e=>updateLeftover(key,e.target.value)}><option value="">Choose one</option>{options.includes("create")&&<option value="create">Create a new counterpart</option>}{options.includes("exclude")&&<option value="exclude">Exclude from syncing</option>}</select></label>}</div>;})}</div>}
          {!canPreview&&details&&<p className="warning" role="status">{ownerRequirement&&!owner?"Preview disabled: choose a recurrence owner above.":"Preview disabled: select the current provider item IDs or refresh affected items to verify edited IDs. Ambiguous or missing IDs are never carried over from another conflict."}</p>}
          <button onClick={createPreview} disabled={busy||!canPreview}>{busy?"Working…":"Preview repair"}</button>
          <button className="secondary reconcile-button" onClick={runReconciliation} disabled={busy}>{selected.decision?.type==="operational_reconciliation_stuck"?`Request fresh reconciliation for ${selected.profile}`:`Run reconciliation for ${selected.profile}`}</button>
          {reconciliation&&<details><summary>Reconciliation status</summary><pre>{JSON.stringify(reconciliation,null,2)}</pre></details>}
        </div>
        {validPreview&&<section className="preview"><h3>Review planned changes</h3><p>This preview expires at {new Date(validPreview.expiresAt*1000).toLocaleString()}.</p><p>Selected recurrence scope: <strong>{scopeLabel(validPreview.intent.scope)}</strong></p><h4>Affected provider items and their outcomes</h4><ul className="preview-items">{validPreview.snapshots.map((item:any)=>{const plan=previewEffect(item,validPreview.intent,validPreview.itemPlan?.find((entry:any)=>choiceKey(entry)===choiceKey(item)));return <li key={choiceKey(item)}><IdentityDetails value={item} scope={validPreview.intent.scope} /><div><strong>Operation:</strong> {plan.operation}</div><div><strong>Resulting disposition / mapping:</strong> {plan.result}</div>{item.mapping&&<div>Existing mapping: Todoist {item.mapping.taskId} ↔ Calendar {item.mapping.eventId}{item.mapping.masterEventId&&` · master ${item.mapping.masterEventId}`}</div>}{item.control?.excluded&&<div>Currently excluded</div>}{item.checkedAt&&<small>Checked {new Date(item.checkedAt).toLocaleString()}</small>}</li>;})}</ul><h4>Planned changes</h4><ul>{validPreview.changes.map((change,i)=><li key={i}>{change}</li>)}</ul>{validPreview.splitPlan&&<dl><dt>Historical Calendar rule</dt><dd>{validPreview.splitPlan.originalRule}</dd><dt>Rule after repair</dt><dd>{validPreview.splitPlan.truncatedRule}</dd><dt>Future recurrence starts</dt><dd>{validPreview.splitPlan.newStart}</dd><dt>Future RRULE</dt><dd>{validPreview.splitPlan.newRule}</dd><dt>Calendar timezone</dt><dd>{validPreview.splitPlan.calendarTimeZone}</dd>{validPreview.splitPlan.expiredUntil&&<><dt>Existing series expired</dt><dd>{validPreview.splitPlan.expiredUntil}; historical rule will not be extended</dd></>}</dl>}<h4>Warnings</h4><ul>{validPreview.warnings.map((warning,i)=><li className="warning" key={i}>{warning}</li>)}</ul><button onClick={applyPreview} disabled={busy||!canPreview}>{busy?"Submitting…":"Apply repair"}</button><button className="secondary" onClick={()=>setPreview(undefined)}>Cancel</button></section>}
        {operation&&<section className="preview"><h3>Repair status: {operation.status.replaceAll("_"," ")}</h3><p>Operation {operation.id} · attempt {operation.attempt}</p>{operation.error&&<p className="warning">{operation.error}</p>}{operation.nextAction&&<p>{operation.nextAction}</p>}{operation.notificationText&&<p>{operation.notificationText}</p>}{operation.status==="queued"&&<p>This repair is serialized with other work for {selected?.profile||"this profile"}. Retrying creates a fresh queue delivery; completed repair steps remain checkpointed.</p>}{operation.steps&&<ul>{Object.entries(operation.steps).map(([name,step])=><li key={name}>{name}: {step.status}</li>)}</ul>}{operation.outcomes&&<ul>{operation.outcomes.map(item=><li key={item.entity}>{item.entity}: {item.outcome}</li>)}</ul>}{operationResumeEligibility(operation)==="fresh-preview"?<><p>This failed operation has no recorded provider write. Refresh affected items and create a new preview; the old operation will remain available for audit.</p><button className="secondary" onClick={refreshAffected} disabled={busy}>Refresh and create new preview</button></>:operationResumeEligibility(operation)==="resume"&&<button onClick={resume} disabled={busy}>{operation.status==="queued"?"Retry queue delivery":"Resume operation"}</button>}</section>}
      </>}</section>
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
