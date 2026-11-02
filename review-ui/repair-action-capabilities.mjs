// Read-only presentation hints for the 12 existing repair intents. These are
// deliberately conservative, NOT authorization; ReviewEngine.preview/apply
// must validate current provider versions, ownership and recurrence again.
export const REPAIR_ACTION_IDS = Object.freeze([
  "verify", "link", "create", "exclude", "separate", "flatten", "transfer",
  "todoist-only", "todoist-only-delete-calendar", "calendar-history-only",
  "decision", "move",
]);

const definitions = [
  ["verify","Verify existing link","common","Read-only verification of the current mapped pair."],
  ["link","Link these existing items","common","Link or rebind these exact existing provider items after reviewing the preview."],
  ["create","Create missing counterpart","common","Create a new counterpart only for the single verified, unmapped source."],
  ["exclude","Keep separate / exclude","common","Exclude selected provider identities from future syncing; do not delete them."],
  ["separate","Separate linked items","advanced","Choose how existing affected provider items remain separate."],
  ["flatten","Flatten recurring occurrence","advanced","Convert the selected current Calendar occurrence into a guarded standalone pair."],
  ["transfer","Transfer existing Calendar series","advanced","Transfer an eligible Calendar recurring master to an existing recurring Todoist task."],
  ["todoist-only","Make Todoist one-off; preserve history","advanced","Remove Todoist recurrence while leaving exact elapsed standalone Calendar history unchanged."],
  ["todoist-only-delete-calendar","Keep Todoist; remove Calendar projection","advanced","Delete only the exact standalone mapped Calendar projection."],
  ["calendar-history-only","Detach elapsed Calendar history","advanced","Retain the elapsed Calendar event while removing obsolete Todoist identity."],
  ["decision","Apply pending Slack decision","advanced","Apply a currently permitted unresolved manual decision."],
  ["move","Move task to another account","advanced","Move this verified Todoist task to a different configured profile."],
];

const validId=(s)=>typeof s==="string"&&s.length>0;
const unique=values=>[...new Set(values.filter(validId))];
const dateTime=value=>value?.dateTime||value?.date;
const recurringTask=task=>task?.due?.is_recurring===true&&validId(task?.due?.string);
const eventRole=(event,mapping,recurrence)=>{
  if(!event)return "unknown";
  if(event.recurringEventId)return "occurrence";
  if(Array.isArray(event.recurrence)&&event.recurrence.length)return "master";
  if(mapping?.recurrenceOwner||mapping?.masterEventId||recurrence?.owner)return "unknown";
  return event.status==="confirmed"&&dateTime(event.start)&&dateTime(event.end)?"standalone":"unknown";
};
const taskRole=(task,mapping,recurrence)=>{
  if(!task)return "unknown";
  if(task.due?.is_recurring===true)return validId(task.due.string)?"recurring":"unknown";
  if(mapping?.recurrenceOwner||recurrence?.owner)return "unknown";
  return task.due?.is_recurring===false||!task.due?"standalone":"unknown";
};
const live=(s,side,profile,id)=>{
  if(!validId(id))return undefined;
  if(s?.ref?.profile!==profile||s.ref.side!==side||s.ref.id!==id||s.object?.id!==id)return undefined;
  if(side==="todoist")return s.object.is_deleted||s.object.is_completed?undefined:s;
  return s.object.status==="confirmed"&&dateTime(s.object.start)&&dateTime(s.object.end)?s:undefined;
};
function verifiedSelection({caseItem, snapshots=[], selection}) {
  if(!caseItem||!selection||selection.caseId!==caseItem.id||selection.profile!==caseItem.profile)return {};
  const pick=(side,id,verifiedId,searched)=>{
    if(!id||id!==verifiedId)return undefined;
    const snapshot=snapshots.find(s=>s.ref?.side===side&&s.ref?.id===id&&s.ref?.profile===caseItem.profile);
    const inSnapshot=live(snapshot,side,caseItem.profile,id);
    if(inSnapshot)return inSnapshot;
    if(snapshot)return undefined; // an explicit 404/cancelled observation overrides search
    if(searched?.id!==id||searched.caseId!==caseItem.id||searched.profile!==caseItem.profile)return undefined;
    return live({ref:{side,profile:caseItem.profile,id},object:searched},side,caseItem.profile,id);
  };
  return {
    task:pick("todoist",selection.taskId,selection.verifiedTaskId,selection.searchedTask),
    event:pick("calendar",selection.eventId,selection.verifiedEventId,selection.searchedEvent),
  };
}
const sameMapping=(mapping,profile,taskId,eventId)=>Boolean(mapping?.profile===profile&&mapping.taskId===taskId
  && [mapping.eventId,mapping.masterEventId,mapping.activeInstanceId].includes(eventId));
const elapsedEvent=event=>Boolean(dateTime(event?.end)&&Date.parse(String(dateTime(event.end)).slice(0,10).length===10
  && !String(dateTime(event.end)).includes("T") ? String(dateTime(event.end))+"T00:00:00Z":dateTime(event.end))<Date.now());
// Only a hint, not a substitute for provider-local timezone checks in the backend.
export function actionFormFields(action, {hasRecurrence=false, ownerRequired=false}={}) {
  const active=validId(action);
  return {
    winner:action==="link",
    owner:(["link","transfer","create"].includes(action))&&(hasRecurrence||ownerRequired),
    scope:["flatten","transfer"].includes(action)||(hasRecurrence&&["link","create","separate","exclude"].includes(action)),
    destination:action==="move",
    decision:action==="decision",
    occurrence:action==="flatten",
    dispositions:active&&["separate","link","transfer","create","exclude"].includes(action),
    sourceChoice:false, // a create intent has exactly one verified source
    counterpartSearch:active&&["link","transfer","flatten","verify","separate","todoist-only"].includes(action),
  };
}
export function availableRepairActions({caseItem,case:legacyCase,snapshots=[],selectedPair,selection=selectedPair,decision,operation,profiles=["home","antonio","work"]}={}) {
  const item=caseItem||legacyCase;
  const empty={actions:[],unavailable:[],summary:{task:"unknown",event:"unknown",mapping:"unknown",recurrence:"unknown",verifiedTaskId:"",verifiedEventId:"",hasRecurrence:false,reason:"No current case selected"}};
  if(!item)return empty;
  const {task,event}=verifiedSelection({caseItem:item,snapshots,selection});
  const taskObj=task?.object,eventObj=event?.object;
  const taskId=task?.ref.id,eventId=event?.ref.id;
  const mapT=task?.mapping,mapE=event?.mapping;
  const map=mapT||mapE;
  const taskRec=taskRole(taskObj,mapT,task?.recurrence);
  const calRec=eventRole(eventObj,mapE,event?.recurrence);
  const recurrent=taskRec==="recurring"||["master","occurrence"].includes(calRec);
  const controlled=[task,event].some(s=>s?.control?.activeRepair||s?.control?.excluded);
  const mismatchedMapping=Boolean(mapT&&mapE&&(mapT.taskId!==mapE.taskId||mapT.eventId!==mapE.eventId
    ||mapT.profile!==mapE.profile));
  const mappedPair=Boolean(taskId&&eventId&&sameMapping(map,item.profile,taskId,eventId)
    &&(!mapT||sameMapping(mapT,item.profile,taskId,eventId))
    &&(!mapE||sameMapping(mapE,item.profile,taskId,eventId)));
  const unknownOwner=Boolean(map&&map.profile!==item.profile||task?.recurrence&&task.recurrence.profile!==item.profile
    ||event?.recurrence&&event.recurrence.profile!==item.profile);
  const competing=Boolean(unknownOwner||mismatchedMapping
    ||mapT&&taskId&&mapT.taskId!==taskId
    ||mapE&&eventId&&![mapE.eventId,mapE.masterEventId,mapE.activeInstanceId].includes(eventId));
  const otherLiveTasks=unique(snapshots.filter(s=>live(s,"todoist",item.profile,s.ref?.id)).map(s=>s.ref.id));
  const otherLiveEvents=unique(snapshots.filter(s=>live(s,"calendar",item.profile,s.ref?.id)).map(s=>s.ref.id));
  const single=Boolean(taskId)!==Boolean(eventId);
  const validSource=task||event;
  const hasOtherSide=taskId?otherLiveEvents.length>0:otherLiveTasks.length>0;
  const unknownCounterpart=Boolean(validSource?.mapping||validSource?.recurrence||validSource?.destination
    ||hasOtherSide||competing||otherLiveTasks.length>1||otherLiveEvents.length>1);
  const pending=decision||item.decision;
  const pendingActions=(pending?.permittedActions||[]).filter(a=>a?.id&&a.id!=="reconcile_now");
  const open=item.status==="open"&&!operation?.status?.match(/^(queued|running|needs_review)$/);
  const pair=Boolean(taskId&&eventId);
  const noRecurrence=taskRec==="standalone"&&calRec==="standalone";
  const currentEventMapped=Boolean(event?.mapping?.eventId===eventId&&event.mapping.taskId===taskId);
  const taskDue=taskObj?.due?.date;
  const rule=taskObj?.due?.string||"";
  const history=Boolean(taskObj&&eventObj&&taskRec==="recurring"&&calRec==="standalone"
    &&/^every year$|^every 1 year$/i.test(rule)&&/^\d{4}-\d{2}-\d{2}$/.test(taskDue||"")
    &&dateTime(eventObj.start)<taskDue&&elapsedEvent(eventObj)
    &&!mapT&&!mapE&&!task?.recurrence&&!event?.recurrence);
  const eligible={
    verify:pair&&mappedPair&&!competing&&!controlled,
    link:pair&&!competing&&!controlled,
    create:single&&!unknownCounterpart&&!controlled&&(taskRec!=="unknown"||calRec!=="unknown"),
    exclude:Boolean(validSource)&&!controlled,
    separate:Boolean(validSource)&&(mappedPair||competing||Boolean(map))&&!controlled,
    flatten:pair&&calRec==="occurrence"&&Boolean(snapshots.find(s=>s.ref?.profile===item.profile&&s.ref.side==="calendar"
      &&s.ref.id===eventObj?.recurringEventId&&live(s,"calendar",item.profile,s.ref.id)&&s.object?.recurrence?.length))
      &&!controlled&&!competing,
    transfer:pair&&taskRec==="recurring"&&calRec==="master"&&Boolean(event?.calendarProjectionId)
      &&Boolean(snapshots.find(s=>s.ref?.id===event.calendarProjectionId&&s.ref?.side==="calendar"
        &&live(s,"calendar",item.profile,s.ref.id)&&s.object?.recurringEventId===eventId))
      &&!competing&&!controlled,
    "todoist-only":pair&&history&&!controlled,
    "todoist-only-delete-calendar":pair&&noRecurrence&&Boolean(taskDue||taskObj?.due?.datetime)&&mappedPair
      &&currentEventMapped&&Boolean(eventObj?.etag)&&!controlled,
    "calendar-history-only":Boolean(eventId)&&calRec==="standalone"&&elapsedEvent(eventObj)
      &&Boolean(eventObj?.etag)&&Boolean(eventObj?.extendedProperties?.shared?.taskId||event?.mapping?.taskId)
      &&!controlled,
    decision:Boolean(validSource)&&pending?.status==="pending"&&pendingActions.length>0
      &&pendingActions.some(a=>a.id===pending?.choice||a.id===pending?.action||true)&&!controlled,
    move:Boolean(taskId)&&profiles.some(p=>p!==item.profile&&p!=="all")&&!controlled,
  };
  const why={
    verify:"Verify association requires two verified live items with the same current mapping.",
    link:"Link requires two verified live items and no unresolved competing ownership.",
    create:"Create counterpart requires exactly one verified, unmapped source without an existing counterpart.",
    exclude:"Exclude requires an exact verified live identity with no active repair or exclusion.",
    separate:"Separate requires current link or conflict context for a live item.",
    flatten:"Flatten requires a verified current Calendar occurrence, its recurring master and an eligible Todoist counterpart.",
    transfer:"Series transfer requires an existing Calendar recurring master, its active occurrence and a recurring Todoist task.",
    "todoist-only":"This repair needs an active recurring Todoist task and unmapped historical standalone Calendar context.",
    "todoist-only-delete-calendar":"Calendar-only deletion requires a one-off Todoist task and its exact active mapped standalone projection.",
    "calendar-history-only":"Historical detachment requires a verified elapsed standalone Calendar item with current Todoist identity.",
    decision:"Apply Slack decision requires a pending permitted decision and its verified live target.",
    move:"Move needs a verified live Todoist task and a different configured profile.",
  };
  const actions=definitions.map(([id,label,tier,explanation])=>{
    const allowed=Boolean(open&&eligible[id]);
    return {id,label,tier,explanation,eligible:allowed,
      reason:!open?"Open an actionable case and obtain a fresh preview before repairing."
        :allowed?"":!validSource?"No verified live provider target. Refresh or select an existing item.":why[id]};
  });
  const selectedFacts=taskObj||eventObj;
  const taskState=taskObj?taskObj.is_completed?"completed":"active"
    :selection?.taskId?"missing or unverified":"not selected";
  const eventState=eventObj?"confirmed":selection?.eventId?"missing, cancelled or unverified":"not selected";
  return {actions:actions.filter(a=>a.eligible),unavailable:actions.filter(a=>!a.eligible),
    summary:{
      task:taskState,event:eventState,mapping:competing?"conflicting/unknown"
        :mappedPair?"mapped":map?"mapped to another identity":"unmapped or unknown",
      recurrence:taskRec==="recurring"?"Recurring Todoist task"
        :calRec==="master"?"Calendar master":calRec==="occurrence"?"Calendar occurrence"
        :taskRec==="standalone"||calRec==="standalone"?"Standalone":"Unknown / unverifiable",
      taskRole:taskRec,eventRole:calRec,hasRecurrence:recurrent,
      verifiedTaskId:taskId||"",verifiedEventId:eventId||"",
      reason:!validSource?"No verified live item. Historical IDs do not establish recurrence or a repairable pair."
        :competing?"Competing mapping evidence requires investigation; no mutation is selected automatically."
        :unknownCounterpart?"Current mapping or additional candidates require explicit review.":"Current provider identities verified.",
      title:selectedFacts?.content||selectedFacts?.summary||item.title,
      decisionActions:pendingActions.map(a=>({id:a.id,label:a.label})),
    }};
}
