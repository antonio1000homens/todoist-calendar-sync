import test from "node:test";
import assert from "node:assert/strict";
import {readOnlyProviderPair,redactedFailureCode,redactedFailureDetails} from "../scripts/audit-erasure-cross-profile-live.mjs";

test("cross-profile audit classifies oversized Calendar recurrence without exposing input",()=>{
  const secret="Calendar recurring series exceeds replay marker bound: event-secret-123";
  assert.equal(redactedFailureCode(new Error(secret)),"UNCLASSIFIED");
  assert.equal(redactedFailureCode(new Error("Calendar recurring series exceeds replay marker bound")),
    "CALENDAR_RECURRENCE_ALIAS_LIMIT");
  const selected=new Error("Calendar recurrence alias bound exceeded");
  selected.name="CalendarRecurrenceLimitAuditError";
  selected.matchesSelectedEvent=true;
  assert.equal(redactedFailureCode(selected),"CALENDAR_RECURRENCE_ALIAS_LIMIT_SELECTED_EVENT");
  const otherMaster=new Error("Calendar recurrence alias bound exceeded");
  otherMaster.name="CalendarRecurrenceLimitAuditError";
  otherMaster.matchesSelectedEvent=false;
  otherMaster.auditOriginKinds=["project-comment-master-event-id-other-task-work","calendar-event-identity"];
  otherMaster.auditStateFamilies=["RECURRENCE","SENSITIVE_ID_SHOULD_NOT_LEAK"];
  otherMaster.auditStateRefFields=["masterEventId","SENSITIVE_FIELD_SHOULD_NOT_LEAK"];
  otherMaster.auditOtherTaskMappingCount=2;
  otherMaster.auditActiveOtherTaskMappingCount=1;
  otherMaster.auditTaggedEventCount=3;
  otherMaster.auditTaggedRecurringMasterCount=1;
  otherMaster.auditProfile="work";
  otherMaster.auditDeliveryRowCount=4;
  otherMaster.auditDeliveryRowsWithSelectedTask=0;
  otherMaster.auditDeliveryRowsWithSelectedEvent=0;
  otherMaster.auditDeliveryKinds=["calendar","secret-kind"];
  assert.equal(redactedFailureCode(otherMaster),"CALENDAR_RECURRENCE_ALIAS_LIMIT_OTHER_MASTER");
  assert.deepEqual(redactedFailureDetails(otherMaster),{
    selectedEvent:false,profile:"work",
    relationOrigins:["calendar-event-identity","project-comment-master-event-id-other-task-work"],
    stateFamilies:["RECURRENCE"],stateReferenceFields:["masterEventId"],deliveryKinds:["calendar"],
    otherTaskMappingCount:2,activeOtherTaskMappingCount:1,taggedEventCount:3,
    taggedRecurringMasterCount:1,deliveryRowCount:4,deliveryRowsWithSelectedTask:0,
    deliveryRowsWithSelectedEvent:0,
  });
});

test("cross-profile audit classifies incomplete inventories with fixed safe codes",()=>{
  assert.equal(redactedFailureCode(new Error("Calendar full inventory exceeded the audit result limit")),
    "CALENDAR_INVENTORY_LIMIT");
  assert.equal(redactedFailureCode(new Error("Todoist task inventory exceeded the audit result limit")),
    "TODOIST_INVENTORY_LIMIT");
  assert.equal(redactedFailureCode(new Error("Strong state inventory repeated a row across pages")),
    "STATE_INVENTORY_INCONSISTENT");
  const deadline=new Error("deadline"); deadline.name="ErasurePreviewDeadlineError";
  assert.equal(redactedFailureCode(deadline),"STATE_INVENTORY_DEADLINE");
});

test("read-only provider facade tags an oversized recurrence relative to selected event",async()=>{
  const names=["findByTodoistTaskId","getEvent","listAllEventsForErasureAudit",
    "listCalendarListForErasureAudit","listLinkedEventsByTodoistTaskId"];
  const calendar=Object.fromEntries(names.map(name=>[name,async()=>[]]));
  calendar.listEventInstances=async()=>{
    const error=new Error("Calendar recurring series exceeds replay marker bound");
    error.auditOriginKinds=["calendar-task-tag"];
    throw error;
  };
  const todoist=Object.fromEntries(["getTask","listAllProjectCommentsForErasureAudit",
    "listAllTaskCommentsForErasureAudit","listAllTasksForErasureAudit","listProjectComments",
    "listTaskComments"].map(name=>[name,async()=>[]]));
  const facade=readOnlyProviderPair({calendar,todoist},"selected-event","work");
  assert.ok(Object.isFrozen(facade));
  assert.ok(Object.isFrozen(facade.calendar));
  await assert.rejects(facade.calendar.listEventInstances("other-master"),error=>{
    assert.equal(error.name,"CalendarRecurrenceLimitAuditError");
    assert.equal(error.message,"Calendar recurrence alias bound exceeded");
    assert.equal(error.matchesSelectedEvent,false);
    assert.equal(error.auditOriginKinds[0],"calendar-task-tag");
    assert.equal(error.auditProfile,"work");
    assert.equal(redactedFailureCode(error),"CALENDAR_RECURRENCE_ALIAS_LIMIT_OTHER_MASTER");
    assert.deepEqual(redactedFailureDetails(error).relationOrigins,["calendar-task-tag"]);
    return true;
  });
});
