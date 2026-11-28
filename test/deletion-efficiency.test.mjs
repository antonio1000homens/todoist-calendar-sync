import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../dist/dynamodb-capacity.js";
import { StateRepository } from "../dist/repository.js";
import { withTodoistInventoryScope } from "../dist/providers.js";
import { Synchronizer } from "../dist/sync.js";

test("calendar ownership checks use exact event keys, not profile-wide mapping inventories",async()=>{
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
      async listMappings() { calls.profileScans++;throw new Error("exact identity lookup must not scan profile mappings"); },
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
    assert.equal(calls.profileScans,0);
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
    async listMappings(){throw new Error("profile-wide lookup must not run");},
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
