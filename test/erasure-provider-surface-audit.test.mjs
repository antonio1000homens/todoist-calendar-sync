import assert from "node:assert/strict";
import test from "node:test";
import {GoogleCalendar,Todoist} from "../dist/providers.js";
import {REPLAY_GUARDED_PROVIDER_WRITES} from "../dist/erasure-replay-providers.js";

// Every concrete provider method must be reviewed as identity mutation,
// non-identity provider control, read, or internal plumbing. Adding a method
// to either provider without updating this inventory fails closed in CI.
const inventory={
  calendar:{
    writes:["createFutureMasterOnce","createRepairEventOnce","deleteEvent","deleteEventIfUnchanged",
      "patchEventMetadataIfUnchanged","updateSharedEventPropertiesIfUnchanged","upsertEvent","upsertEventIfUnchanged"],
    controls:["stopWatch","watch"],
    reads:["findByTodoistTaskId","getEvent","getTimeZone","listAllEventsForErasureAudit",
      "listCalendarListForErasureAudit","listDelta","listEventInstances","listExplicitSeriesExceptions",
      "listInstances","listInstancesInWindow","listLinkedEventsByTodoistTaskId","listOccurrencesInWindow"],
    internal:["request","serviceAccountAssertion","token"],
  },
  todoist:{
    writes:["createProjectComment","createTaskOnce","deleteComment","deleteTask","moveTask",
      "updateComment","updateRecurringOccurrence","updateTaskMetadata","upsertComment",
      "upsertProjectComment","upsertTask"],
    controls:[],
    reads:["findComment","findLegacyTaskComment","getComment","getTask","getTimeZone",
      "listAllProjectCommentsForErasureAudit","listAllTaskCommentsForErasureAudit","listProjectComments",
      "listAllTasksForErasureAudit","listTaskComments","listTasks","readTasks"],
    internal:["request","syncCommand","legacyCommentFields"],
  },
};

test("every concrete provider method is classified and all identity writes share replay guard inventory",()=>{
  for(const [key,Provider] of [["calendar",GoogleCalendar],["todoist",Todoist]]){
    const classified=inventory[key];
    const names=Object.getOwnPropertyNames(Provider.prototype).filter(name=>name!=="constructor").sort();
    const expected=[...classified.writes,...classified.controls,...classified.reads,...classified.internal].sort();
    assert.deepEqual(names,expected,key+" provider surface has unreviewed or stale classification");
    assert.equal(new Set(expected).size,expected.length,key+" provider classification has duplicates");
    assert.deepEqual([...REPLAY_GUARDED_PROVIDER_WRITES[key]].sort(),[...classified.writes].sort(),
      key+" identity writes must be replay-guarded and included in the shared mutation budget");
  }
});
