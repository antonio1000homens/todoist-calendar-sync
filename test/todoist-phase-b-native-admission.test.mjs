import assert from "node:assert/strict";
import test from "node:test";
import { admitNewTodoistPhaseBNative, verifyInitialPhaseBCalendarWrite } from "../dist/todoist-phase-b-native-admission.js";
import { todoistPhaseBCandidate, verifyTodoistPhaseBReadback } from "../dist/todoist-calendar-phase-b.js";
import { GoogleCalendar } from "../dist/providers.js";

const at = "2026-11-08T09:20:00Z";
const project = "profile-project-id";
function task(due="2027-01-02", phrase="every 2, 15, 27", overrides={}) {
  return { id:"task-290", content:"test", project_id:project,
    updated_at:"2026-11-08T09:19:00Z",
    due:{date:due, string:phrase, is_recurring:true}, ...overrides };
}
function evidence(source, current=source) {
  return { source, providerReadback:current, eventName:"item:added",
    receivedAt:at, projectId:project, calendarTimeZone:"Europe/London",
    todoistTimeZone:"Europe/London", hasMapping:false,
    hasCalendarAlias:false, hasPendingRecovery:false };
}
test("fresh Todoist monthly-list creates an anchored candidate with explicit source identity", () => {
  const admitted=admitNewTodoistPhaseBNative(evidence(task()));
  assert.equal(admitted.admitted,true);
  assert.equal(admitted.rule,"RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27");
  assert.equal(admitted.anchor.start,"2027-01-02");
  assert.equal(admitted.family,"multi_month_day");
});
test("alternate Friday and normalized quarterly aliases use anchored exact rules", () => {
  const fri=admitNewTodoistPhaseBNative(evidence(task("2027-01-08","every other Friday")));
  assert.equal(fri.admitted,true);
  assert.equal(fri.rule,"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
  for(const alias of ["every quarter","quarterly","every 3 months"]){
    const quarter=admitNewTodoistPhaseBNative(evidence(task("2027-01-10",alias)));
    assert.equal(quarter.admitted,true,alias);
    assert.equal(quarter.rule,"RRULE:FREQ=MONTHLY;INTERVAL=3");
  }
});
test("existing mapping, provider alias, recovery, edits, stale replay and task switch never infer DTSTART",()=>{
  const base=evidence(task());
  const faults=[
    {hasMapping:true}, {hasCalendarAlias:true}, {hasPendingRecovery:true},
    {eventName:"item:updated"}, {receivedAt:"2026-11-09T09:20:00Z"},
    {source:task(undefined,undefined,{id:"another"})},
    {providerReadback:task("2027-01-15")},
    {providerReadback:task(undefined,undefined,{project_id:"other-profile"})},
    {providerReadback:task(undefined,undefined,{updated_at:undefined})},
    {source:task(undefined,undefined,{updated_at:undefined})},
    {calendarTimeZone:"UTC"}, {todoistTimeZone:"UTC"},
    {source:task(undefined,undefined,{is_completed:true})},
    {source:task(undefined,undefined,{completed_at:"2026-11-07T10:00:00Z"})},
  ];
  for(const change of faults) assert.equal(admitNewTodoistPhaseBNative({...base,...change}).admitted,false,JSON.stringify(change));
});
test("refuse overdue, timed, completion-relative, unsupported finite and month-end drift",()=>{
  for(const source of [
    task("2026-01-02"),
    task("2027-01-02T09:00:00"),
    task("2027-01-02","every! 2 days"),
    task("2027-01-02","every 2,15,27 until 31 Dec 2027"),
    task("2027-01-29","every 29, 30, 31"),
    task("2027-01-31","every quarter"),
    task("2027-01-31","every 3 months"),
  ]) assert.equal(admitNewTodoistPhaseBNative(evidence(source)).admitted,false,source.due?.string);
});
test("phase B candidate rejects real-provider 29/30/31 and quarterly 31st divergence",()=>{
  const anchor=start=>({start,source:"verified_original_schedule"});
  assert.equal(todoistPhaseBCandidate(task("2027-01-29","every 29, 30, 31"),
    anchor("2027-01-29")).reason,"month_end_provider_drift");
  assert.equal(todoistPhaseBCandidate(task("2027-01-31","every 3 months"),
    anchor("2027-01-31")).reason,"month_end_provider_drift");
  const good=todoistPhaseBCandidate(task("2027-01-10","every 3 months"),anchor("2027-01-10"));
  assert.equal(good.reason,"provider_readback_required");
});
test("Todoist due.date timed values are parsed as instants, even when due.datetime is absent",()=>{
  const anchor={start:"2027-03-26T09:00:00Z",timeZone:"Europe/London",
    source:"verified_original_schedule"};
  const timed=task(undefined,"every other Friday at 9am",{
    due:{ date:"2027-03-26T09:00:00Z", timezone:"Europe/London",
      string:"every other Friday at 9am",is_recurring:true },
  });
  assert.equal(todoistPhaseBCandidate(timed,anchor).reason,"provider_readback_required");
  const moved={...timed,due:{...timed.due,date:"2027-04-09T08:00:00Z"}};
  assert.equal(todoistPhaseBCandidate(moved,anchor).reason,"provider_readback_required");
  assert.equal(todoistPhaseBCandidate({...timed,due:{...timed.due,date:"2027-04-09T09:00:00Z"}},anchor)
    .reason,"anchor_or_occurrence_mismatch");
  // A floating local timestamp without independent timezone proof is not admissible.
  const floating={...timed,due:{...timed.due,date:"2027-03-26T09:00:00"}};
  assert.equal(todoistPhaseBCandidate(floating,{start:anchor.start,
    source:"verified_original_schedule"}).reason,"invalid_or_unverified_due");
});

test("strict Phase B Calendar provider admission requires exact master and instances",()=>{
  const source=task();
  const plan=admitNewTodoistPhaseBNative(evidence(source));
  assert.equal(plan.admitted,true);
  const master={
    id:"master-290",etag:"observed-etag",status:"confirmed",
    summary:source.content, start:{date:"2027-01-02"},end:{date:"2027-01-03"},
    recurrence:[plan.rule],
    extendedProperties:{shared:{
      taskId:source.id,syncRecurrenceOwner:"todoist",
      todoistRecurrence:source.due.string,
      todoistAnchorStart:"2027-01-02",todoistAnchorEnd:"2027-01-03",
    }},
  };
  const instances=["2027-01-02","2027-01-15","2027-01-27"].map((date,i)=>({
    id:"i-"+i, status:"confirmed",recurringEventId:"master-290",
    originalStartTime:{date},start:{date},end:{date:"2027-01-03"},
  }));
  const clean={master,instances,calendarTimeZone:"Europe/London",
    explicitExceptions:[],exceptionInventoryComplete:true};
  const good=verifyInitialPhaseBCalendarWrite(plan,source,clean);
  assert.deepEqual(good,{accepted:true,reason:"calendar_provider_readback_verified"});
  const bad=[
    {master:{...master,etag:undefined}},
    {master:{...master,extendedProperties:{shared:{...master.extendedProperties.shared,taskId:"other"}}}},
    {master:{...master,recurrence:["RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15"]}},
    {master:{...master,start:{date:"2027-01-15"}}},
    {instances:instances.slice(0,2)},
    {instances:[instances[0],{...instances[1],start:{date:"2027-01-16"}},instances[2]]},
    {instances:[instances[0],{...instances[1],recurringEventId:"other"},instances[2]]},
    {instances:[instances[0],{...instances[2]},instances[1]]},
    {explicitExceptions:[{id:"exception",recurringEventId:master.id,status:"cancelled"}]},
    {exceptionInventoryComplete:false},
    {calendarTimeZone:"UTC"},
  ];
  for(const change of bad)
    assert.equal(verifyInitialPhaseBCalendarWrite(plan,source,{...clean,...change}).accepted,false,
      JSON.stringify(change));
});

test("Phase B master create uses its deterministic Calendar identity and never creates a duplicate on retry", async()=>{
  const taskId="task-290", eventId="ab".repeat(16);
  const event={id:eventId,status:"confirmed",start:{date:"2027-01-02"},end:{date:"2027-01-03"},
    recurrence:["RRULE:FREQ=MONTHLY;BYMONTHDAY=2,15,27"],extendedProperties:{shared:{
      taskId,syncRecurrenceOwner:"todoist",todoistAnchorStart:"2027-01-02",todoistPhaseBVersion:"1",
    }}};
  const calls=[];
  const previous=globalThis.fetch;
  globalThis.fetch=async (input,init={})=>{
    const url=String(input); calls.push({url,init});
    if(url==="https://oauth2.googleapis.com/token")
      return new Response(JSON.stringify({access_token:"test-token"}),{status:200});
    if(url.endsWith("/events") && init.method==="POST") return new Response(JSON.stringify(event),{status:200});
    if(url.endsWith(`/events/${eventId}`)) return new Response(JSON.stringify(event),{status:200});
    throw new Error(`Unexpected Calendar request ${init.method||"GET"} ${url}`);
  };
  try {
    const calendar=new GoogleCalendar({client_id:"client",client_secret:"secret",refresh_token:"refresh"},"calendar");
    const first=await calendar.createTodoistPhaseBNativeMasterOnce(event);
    assert.equal(first.created,true);
    assert.equal(first.event.id,eventId);
    // Simulate a lost first response: a second deterministic POST conflicts,
    // then reads back the exact identity instead of inserting another master.
    let postCount=0;
    globalThis.fetch=async (input,init={})=>{
      const url=String(input); calls.push({url,init});
      if(url==="https://oauth2.googleapis.com/token") return new Response(JSON.stringify({access_token:"test-token"}),{status:200});
      if(url.endsWith("/events") && init.method==="POST" && postCount++===0) return new Response("conflict",{status:409});
      if(url.endsWith(`/events/${eventId}`)) return new Response(JSON.stringify(event),{status:200});
      throw new Error(`Unexpected Calendar request ${init.method||"GET"} ${url}`);
    };
    const retryCalendar=new GoogleCalendar({client_id:"client",client_secret:"secret",refresh_token:"refresh"},"calendar");
    const retry=await retryCalendar.createTodoistPhaseBNativeMasterOnce(event);
    assert.equal(retry.created,false);
    assert.equal(retry.event.id,eventId);
    assert.equal(calls.filter(call=>call.url.endsWith("/events")&&call.init.method==="POST").length,2);
  } finally { globalThis.fetch=previous; }
});
