import assert from "node:assert/strict";
import test from "node:test";
import { planPhaseBNativeFutureOnlyMove } from "../dist/todoist-phase-b-native-move.js";

function nextDay(iso){const d=new Date(iso+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}
function fixture({name="quarterly",start="2027-01-10",due="2027-04-10",
  phrase="every quarter",rule="RRULE:FREQ=MONTHLY;INTERVAL=3",previous=["2027-01-10"]}={}) {
  const task={id:"task-native-"+name,project_id:"destination-project",content:"Native series",
    description:"hello",updated_at:"2027-02-15T10:00:00Z",
    due:{date:due,string:phrase,is_recurring:true}};
  const master={id:"original-master",etag:"source-v1",status:"confirmed",
    summary:task.content,description:task.description,start:{date:start},end:{date:nextDay(start)},
    recurrence:[rule],extendedProperties:{shared:{
      taskId:task.id,syncRecurrenceOwner:"todoist",todoistPhaseBVersion:"1",
      todoistRecurrence:phrase.toLowerCase(),todoistAnchorStart:start,todoistAnchorEnd:nextDay(start),
      todoistAnchorTimeZone:"Europe/London",
    }}};
  const mapping={profile:"home",taskId:task.id,eventId:master.id,seriesId:task.id,
    masterEventId:master.id,recurrenceOwner:"todoist",todoistPhaseBVersion:1,
    activeInstanceId:"instance-1",originalStart:due,activeEffectiveStart:due,updatedAt:"2027-02-15T10:00:00Z"};
  const historicalInstances=previous.map((d,i)=>({
    id:"instance-"+i,recurringEventId:master.id,status:"confirmed",
    originalStartTime:{date:d},start:{date:d},end:{date:nextDay(d)},
    summary:master.summary,description:master.description,
  }));
  return {task,mapping,sourceMaster:master,sourceProfile:"home",destinationProfile:"work",
    destinationProjectId:"destination-project",
    sourceTimeZone:"Europe/London",destinationTimeZone:"Europe/London",
    todoistTimeZone:"Europe/London",today:"2027-02-15",historicalInstances,
    historyInventoryComplete:true,exceptionInventoryComplete:true,explicitExceptions:[],
    destinationHasLinkedEvent:false,destinationHasMapping:false,
    destinationHasTombstone:false,activeRepairOrErasure:false};
}
const variants=[
  {name:"quarterly", start:"2027-01-10",due:"2027-04-10",
    phrase:"every quarter",rule:"RRULE:FREQ=MONTHLY;INTERVAL=3",
    previous:["2027-01-10"],future:["2027-04-10","2027-07-10","2027-10-10"]},
  {name:"monthly-days",start:"2027-01-02",due:"2027-01-15",
    phrase:"every 2, 15, 27",rule:"RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27",
    previous:["2027-01-02"],future:["2027-01-15","2027-01-27","2027-02-02"]},
  {name:"alternate-friday",start:"2027-01-08",due:"2027-01-22",
    phrase:"every other Friday",rule:"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
    previous:["2027-01-08"],future:["2027-01-22","2027-02-05","2027-02-19"]},
];
for(const v of variants){
  test(`admit history-preserving native move: ${v.name}`,()=>{
    const e=fixture(v);e.today="2027-01-01";
    const decision=planPhaseBNativeFutureOnlyMove(e);
    assert.equal(decision.accepted,true,decision.reason);
    assert.equal(decision.plan.sourceRule,v.rule);
    assert.equal(decision.plan.historyRule,v.rule+";UNTIL="+v.previous.at(-1).replaceAll("-",""));
    assert.equal(decision.plan.historicalLastOccurrence,v.previous.at(-1));
    assert.equal(decision.plan.destinationStart,v.due);
    assert.deepEqual(decision.plan.firstThreeDestinationOccurrences,v.future);
    assert.equal(decision.plan.originalAnchor,v.start);
    assert.match(decision.plan.successorMasterId,/^[a-f\d]{32}$/);
    assert.equal(planPhaseBNativeFutureOnlyMove(e).plan.successorMasterId,decision.plan.successorMasterId,
      "idempotent retries must address one deterministic destination master");
  });
}
test("reject provider history loss or altered instance without rewriting source",()=>{
  const e=fixture();
  const faultCases=[
    {historicalInstances:[]},
    {historyInventoryComplete:false},
    {exceptionInventoryComplete:false},
    {explicitExceptions:[{id:"cancelled",status:"cancelled",recurringEventId:e.sourceMaster.id}]},
    {historicalInstances:[{...e.historicalInstances[0],start:{date:"2027-01-11"}}]},
    {historicalInstances:[{...e.historicalInstances[0],status:"cancelled"}]},
    {historicalInstances:[{...e.historicalInstances[0],summary:"edited"}]},
    {historicalInstances:[{...e.historicalInstances[0],originalStartTime:undefined}]},
  ];
  for(const change of faultCases)
    assert.equal(planPhaseBNativeFutureOnlyMove({...e,...change}).accepted,false,JSON.stringify(change));
});
test("reject unsafe ownership or pending repair before any Calendar write",()=>{
  const e=fixture();
  for(const change of [
    {destinationHasLinkedEvent:true},{destinationHasMapping:true},
    {destinationHasTombstone:true},{activeRepairOrErasure:true},
    {destinationProjectId:"another-project"},
    {mapping:{...e.mapping,originalStart:"2027-01-10"}},
    {sourceProfile:"work"}, {destinationProfile:"home"},
    {sourceTimeZone:"UTC"},{todoistTimeZone:"UTC"},{destinationTimeZone:"UTC"},
    {today:"2027-05-01"}, {task:{...e.task,project_id:undefined}},
    {task:{...e.task,due:{...e.task.due,date:"2027-04-11"}}},
    {mapping:{...e.mapping,todoistPhaseBVersion:undefined}},
    {mapping:{...e.mapping,recurrenceOwner:"calendar"}},
    {sourceMaster:{...e.sourceMaster,etag:undefined}},
    {sourceMaster:{...e.sourceMaster,recurrence:["RRULE:FREQ=MONTHLY;INTERVAL=3;COUNT=3"]}},
    {sourceMaster:{...e.sourceMaster,extendedProperties:{
      shared:{...e.sourceMaster.extendedProperties.shared,todoistPhaseBVersion:undefined}}}},
    {sourceMaster:{...e.sourceMaster,extendedProperties:{
      shared:{...e.sourceMaster.extendedProperties.shared,taskId:"another-task"}}}},
  ])assert.equal(planPhaseBNativeFutureOnlyMove({...e,...change}).accepted,false,JSON.stringify(change));
});
test("cannot split before the first recurrence or beyond bounded evidence",()=>{
  const e=fixture();
  const first={...e,task:{...e.task,due:{...e.task.due,date:"2027-01-10"}},
    today:"2027-01-01",historicalInstances:[]};
  assert.equal(planPhaseBNativeFutureOnlyMove(first).accepted,false);
  const long={...e,task:{...e.task,due:{...e.task.due,date:"2070-04-10"}},
    today:"2070-01-01"};
  assert.equal(planPhaseBNativeFutureOnlyMove(long).accepted,false);
});
test("month-end Todoist quarterly drift remains excluded from native migration",()=>{
  const e=fixture({name:"bad-month-end",start:"2027-01-31",due:"2027-04-30",
    phrase:"every quarter",rule:"RRULE:FREQ=MONTHLY;INTERVAL=3",previous:["2027-01-31"]});
  e.today="2027-02-15";
  assert.equal(planPhaseBNativeFutureOnlyMove(e).accepted,false);
});
