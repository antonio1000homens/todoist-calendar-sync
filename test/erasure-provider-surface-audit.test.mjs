import assert from "node:assert/strict";
import test from "node:test";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayUnavailableError} from "../dist/erasure-replay-barrier.js";
import {calendarForProfile,GoogleCalendar,Todoist} from "../dist/providers.js";
import {REPLAY_GUARDED_PROVIDER_WRITES} from "../dist/erasure-replay-providers.js";

const sourceRoot=path.join(path.dirname(fileURLToPath(import.meta.url)),"../src");
async function sourceFiles(dir=sourceRoot) {
  const files=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...await sourceFiles(full));
    else if(entry.isFile()&&entry.name.endsWith(".ts"))files.push(full);
  }
  return files;
}

// Every concrete provider method must be reviewed as identity mutation,
// non-identity provider control, read, or internal plumbing. Adding a method
// to either provider without updating this inventory fails closed in CI.
const inventory={
  calendar:{
    writes:["createFutureMasterOnce","createTodoistPhaseBNativeMasterOnce","createRepairEventOnce","deleteEvent","deleteEventIfUnchanged",
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
    reads:["findComment","findCompletedTaskById","findLegacyTaskComment","getComment","getTask","getTimeZone",
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

test("production provider construction has only guarded identity routes or classified watch control",async()=>{
  const constructors=new Map(),directProviderHttp=[];
  for(const file of await sourceFiles()) {
    const source=await readFile(file,"utf8"),relative=path.relative(sourceRoot,file);
    if(/https:\/\/(?:www\.googleapis\.com\/calendar\/v3|api\.todoist\.com\/api\/v1)/.test(source))
      directProviderHttp.push(relative);
    const names=[...source.matchAll(/new\s+(GoogleCalendar|Todoist)\s*\(/g)].map(match=>match[1]);
    if(names.length)constructors.set(relative,names.sort());
  }
  assert.deepEqual(directProviderHttp,["providers.ts"],
    "all direct Google Calendar and Todoist HTTP writes must pass through the audited provider surface");
  assert.deepEqual(Object.fromEntries([...constructors].sort(([a],[b])=>a.localeCompare(b))),{
    "completed-project-comment-cleanup.ts":["Todoist"],
    "mutation-budget.ts":["GoogleCalendar","Todoist"],
    "providers.ts":["GoogleCalendar"],
    "review-store.ts":["Todoist"],
    "watch.ts":["GoogleCalendar"],
  });
  const factory=await readFile(path.join(sourceRoot,"mutation-budget.ts"),"utf8");
  assert.match(factory,/defaultProviderClientFactory[^=]*=\s*async\s*\(profile,options\)\s*=>\s*guardReplayProviderClients\(profile,\{/,
    "default runtime clients must enter through the replay provider guard");
  const cleanup=await readFile(path.join(sourceRoot,"completed-project-comment-cleanup.ts"),"utf8");
  assert.match(cleanup,/guardReplayProviderClients\(profile,\s*\{[\s\S]{0,120}new Todoist/,
    "operator cleanup's separate Todoist client must keep the replay guard");
  const review=await readFile(path.join(sourceRoot,"review-store.ts"),"utf8");
  assert.match(review,/activeProjectDeletionTombstone\(comments,[\s\S]{0,180}ErasureReplayBlockedError/,
    "stored review and repair identities must be checked against bounded project-comment tombstones");
  const providerFactory=await readFile(path.join(sourceRoot,"providers.ts"),"utf8");
  assert.match(providerFactory,/calendarForProfile[\s\S]{0,240}guardReplayCalendarClient\(profile,\s*new GoogleCalendar/,
    "the exported single-provider factory must not return an unguarded Calendar client");
  const watch=await readFile(path.join(sourceRoot,"watch.ts"),"utf8");
  const orphan=await readFile(path.join(sourceRoot,"orphan-recovery.ts"),"utf8");
  assert.match(orphan,/private async clients\(profile: Profile\)[\s\S]{0,180}guardReplayProviderClients\(profile, await this\.clientFactory\(profile\)\)/,
    "orphan recovery must guard injected as well as production provider factories");
  assert.match(orphan,/const releaseTargetWriter = await acquireMoveWriterLeases\(\[targetProfile\], delivery\.profile\)/,
    "cross-profile orphan recovery must acquire its mapped owner writer lease before writes");
  for(const side of ["calendar","todoist"])for(const method of REPLAY_GUARDED_PROVIDER_WRITES[side])
    assert.doesNotMatch(watch,new RegExp(`\\.${method}\\s*\\(`),"watch control code must not bypass item-write guard: "+method);
  assert.match(watch,/\.watch\(/);
  assert.match(watch,/\.stopWatch\(/);
});

test("calendarForProfile refuses obsolete HMAC gate before any provider write",async t=>{
  const prior=process.env.ERASURE_REPLAY_BARRIER_VERSION;
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  t.after(()=>{if(prior===undefined)delete process.env.ERASURE_REPLAY_BARRIER_VERSION;
    else process.env.ERASURE_REPLAY_BARRIER_VERSION=prior;});
  let reads=0,providerRequests=0;
  t.mock.method(documentClient,"send",async()=>{reads++;throw Error("legacy marker lookup");});
  t.mock.method(globalThis,"fetch",async()=>{providerRequests++;throw Error("provider write");});
  const calendar=calendarForProfile({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"work","calendar-id");
  await assert.rejects(calendar.deleteEvent("event-1","etag"),ErasureReplayUnavailableError);
  assert.equal(reads,0);
  assert.equal(providerRequests,0);
});
