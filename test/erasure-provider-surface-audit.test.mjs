import assert from "node:assert/strict";
import test from "node:test";
import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {documentClient} from "../dist/dynamodb-capacity.js";
import {ErasureReplayBlockedError} from "../dist/erasure-replay-barrier.js";
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
    "watch.ts":["GoogleCalendar"],
  });
  const factory=await readFile(path.join(sourceRoot,"mutation-budget.ts"),"utf8");
  assert.match(factory,/defaultProviderClientFactory[^=]*=\s*async\s*\(profile\)\s*=>\s*guardReplayProviderClients\(profile,\{/,
    "default runtime clients must enter through the replay provider guard");
  const cleanup=await readFile(path.join(sourceRoot,"completed-project-comment-cleanup.ts"),"utf8");
  assert.match(cleanup,/guardReplayProviderClients\(profile,\s*\{[\s\S]{0,120}new Todoist/,
    "operator cleanup's separate Todoist client must keep the replay guard");
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

test("calendarForProfile checks the exact profile marker before its provider write",async t=>{
  const prior={version:process.env.ERASURE_REPLAY_BARRIER_VERSION,protocol:process.env.ERASURE_PROTOCOL_VERSION,keys:process.env.ERASURE_REPLAY_HMAC_KEYS,
    current:process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY};
  process.env.ERASURE_REPLAY_BARRIER_VERSION="1";
  process.env.ERASURE_PROTOCOL_VERSION="1";
  process.env.ERASURE_REPLAY_HMAC_KEYS=JSON.stringify({v1:Buffer.alloc(32,7).toString("base64")});
  process.env.ERASURE_REPLAY_HMAC_CURRENT_KEY="v1";
  t.after(()=>{
    for(const [key,value] of Object.entries({ERASURE_REPLAY_BARRIER_VERSION:prior.version,ERASURE_PROTOCOL_VERSION:prior.protocol,
      ERASURE_REPLAY_HMAC_KEYS:prior.keys,ERASURE_REPLAY_HMAC_CURRENT_KEY:prior.current}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const reads=[];let providerRequests=0;
  t.mock.method(documentClient,"send",async command=>{
    reads.push(command.input.Key);
    return {Item:{markerVersion:1}};
  });
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{providerRequests++;throw new Error("provider call must be blocked before HTTP");};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const calendar=calendarForProfile({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"work","calendar-id");
  await assert.rejects(calendar.deleteEvent("erased-event","etag"),ErasureReplayBlockedError);
  assert.equal(reads.length,1);
  assert.equal(reads[0].pk,"ERASURE_REPLAY#work");
  assert.equal(providerRequests,0);
});
