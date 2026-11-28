import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";
import { withTodoistInventoryScope } from "../dist/providers.js";
import { Synchronizer, compatibleCalendarCandidateOwnerConflicts } from "../dist/sync.js";
import { serializeMappingComment } from "../dist/mapping-comments.js";
import { profiles } from "../dist/config.js";

test("calendar ownership checks include legacy occurrence mappings",async()=>{
  for(const unrelatedCount of [0,59,500]) {
    const calls={exactReads:[],commentInventories:[],profileScans:0};
    const identities=new Map([
      [`home:active-instance`,{profile:"home",eventId:"active-instance",taskId:"home-task",
        masterEventId:"series-master",activeInstanceId:"active-instance",seriesId:"calendar-series"}],
      [`work:series-master`,{profile:"work",eventId:"work-event",taskId:"work-task",
        masterEventId:"series-master",activeInstanceId:"work-active",seriesId:"work-series"}],
    ]);
    const state={
      async getMappingByEvent(profile,eventId) {
        calls.exactReads.push(`${profile}:${eventId}`);
        return identities.get(`${profile}:${eventId}`);
      },
      async listMappings(profile) { calls.profileScans++;return [...identities.values()].filter(item=>item.profile===profile); },
    };
    const clients=async profile=>({
      calendar:{},
      todoist:{async listProjectComments(projectId) {
        calls.commentInventories.push({profile,projectId});
        return Array.from({length:unrelatedCount},(_,index)=>({id:`unrelated-${profile}-${index}`}));
      }},
    });
    const sync=new Synchronizer(state,undefined,clients);
    const result=await withTodoistInventoryScope(async()=>{
      const currentTodoist=await clients("home").then(pair=>pair.todoist);
      const first=await sync.providerMappingsForCalendarIdentity("home",["series-master","active-instance"],currentTodoist);
      const second=await sync.providerMappingsForCalendarIdentity("home",["series-master","active-instance"],currentTodoist);
      assert.deepEqual(second,first,"same-delivery exact ownership reads are reusable across identical decisions");
      return first;
    });
    assert.deepEqual(result.map(item=>`${item.profile}:${item.taskId}`).sort(),["home:home-task","work:work-task"]);
    assert.equal(calls.exactReads.length,6,"two event IDs are point-read once in each of three profiles per delivery");
    assert.equal(calls.profileScans,6);
    assert.equal(calls.commentInventories.length,6,"the provider adapter receives each scoped inventory request; production caches pagination in the request scope");
  }
});

test("calendar exact-ID ownership guard preserves competing cross-profile claims",async()=>{
  const calls=[];
  const state={
    async getMappingByEvent(profile,eventId) {
      calls.push(`${profile}:${eventId}`);
      if(profile==="home"&&eventId==="master")return {profile,eventId:"active",taskId:"home-task",masterEventId:"master",activeInstanceId:"active"};
      if(profile==="work"&&eventId==="master")return {profile,eventId:"master",taskId:"work-task",masterEventId:"master"};
      return undefined;
    },
    async listMappings(){return [];},
  };
  const clientFactory=async()=>({calendar:{},todoist:{async listProjectComments(){return[];}}});
  const sync=new Synchronizer(state,undefined,clientFactory);
  const mappings=await sync.providerMappingsForCalendarIdentity("home",["master","active"]);
  assert.deepEqual(mappings.map(mapping=>mapping.profile).sort(),["home","work"]);
  assert.equal(calls.length,6);
});

test("same-profile deletion owner fallback skips the task key already read locally",async()=>{
  const old=documentClient.send;const keys=[];
  documentClient.send=async command=>{
    assert.ok(command instanceof GetCommand);
    keys.push(command.input.Key.pk);
    return {};
  };
  try {
    assert.equal(await new StateRepository().getMappingByTaskAnyProfile("deleted-task",["home"]),undefined);
    assert.deepEqual(keys,["TASKOWNER#deleted-task","TASK#antonio#deleted-task","TASK#work#deleted-task"]);
  } finally {documentClient.send=old;}
});

test("master ownership finds a legacy mapping indexed only by occurrence",async()=>{
  const legacy={profile:"work",eventId:"occurrence",taskId:"legacy-task",masterEventId:"master",activeInstanceId:"occurrence"};
  const state={async getMappingByEvent(){return undefined;},async listMappings(profile){return profile==="work"?[legacy]:[];}};
  const sync=new Synchronizer(state,undefined,async()=>({calendar:{},todoist:{async listProjectComments(){return [];}}}));
  assert.deepEqual(await sync.providerMappingsForCalendarIdentity("home",["master"]),[legacy]);
});

test("legacy ownership inventory stops at its page limit and fails closed",async()=>{
  const old=documentClient.send;const calls=[];
  documentClient.send=async command=>{
    calls.push(command);
    return {Items:[],LastEvaluatedKey:{pk:`page-${calls.length}`,sk:"MAP"}};
  };
  try {
    await assert.rejects(new StateRepository().listMappingsForOwnership("home"),/exceeded 5 pages.*manual review required/);
    assert.equal(calls.length,5);
    assert.ok(calls.every(command=>command.input.Limit===100));
  } finally {documentClient.send=old;}
});

test("legacy recurrence link resolves master identity through the occurrence mapping",async()=>{
  const legacy={profile:"work",eventId:"occurrence",taskId:"legacy-task",masterEventId:"master",activeInstanceId:"occurrence"};
  const state={
    async getMappingByEvent(){return undefined;},
    async getRecurrenceLink(profile,id){return profile==="work"&&id==="master"?{profile,seriesId:id,masterEventId:id,taskId:legacy.taskId,eventId:legacy.eventId}:undefined;},
    async getMappingByTask(profile,taskId){return profile==="work"&&taskId===legacy.taskId?legacy:undefined;},
    async listMappingsForOwnership(){return [];},
  };
  const sync=new Synchronizer(state,undefined,async()=>({calendar:{},todoist:{async listProjectComments(){return [];}}}));
  assert.deepEqual(await sync.providerMappingsForCalendarIdentity("home",["master"]),[legacy]);
});


test("provider precedence does not hide a competing legacy claim on the same master",async()=>{
  const provider={profile:"home",eventId:"native-active",taskId:"same-task",masterEventId:"master",activeInstanceId:"native-active",updatedAt:"2026-11-01T00:00:00Z"};
  const legacy={...provider,eventId:"legacy-active",activeInstanceId:"legacy-active"};
  const state={async getMappingByEvent(){return undefined;},async listMappingsForOwnership(profile){return profile==="home"?[legacy]:[];}};
  const sync=new Synchronizer(state,undefined,async profile=>({calendar:{},todoist:{async listProjectComments(projectId){return profile==="home"?[{id:"native",project_id:projectId,content:serializeMappingComment(provider,profiles.home.todoistProjectId)}]:[];}}}));
  const mappings=await sync.providerMappingsForCalendarIdentity("home",["master"]);
  assert.deepEqual(mappings.map(item=>item.eventId).sort(),["legacy-active","native-active"]);
});


test("legacy same-task occurrence claim blocks adoption of a different active occurrence",()=>{
  const candidate={master:{id:"master"},event:{id:"new-occurrence"}};
  const legacy={profile:"home",taskId:"same-task",eventId:"old-occurrence",masterEventId:"master"};
  assert.deepEqual(compatibleCalendarCandidateOwnerConflicts(candidate,[legacy],"same-task","home"),["same-task"]);
});
