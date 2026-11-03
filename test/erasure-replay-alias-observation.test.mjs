import assert from "node:assert/strict";
import test from "node:test";
import {GoogleCalendar,AmbiguousCalendarLinkError} from "../dist/providers.js";
import {observeCrossProfileCalendarAliases} from "../dist/erasure-replay-alias-observation.js";

const taskId="task-123";
const link=(id,other={})=>({
  id,status:"confirmed",
  extendedProperties:{shared:{taskId}},...other,
});

function readers(data,called=[]) {
  return async profile=>{
    called.push(profile);
    if(!Object.hasOwn(data,profile))throw new Error("Profile reader missing");
    return {async listLinkedEventsByTodoistTaskId(id) {
      assert.equal(id,taskId);
      if(data[profile] instanceof Error)throw data[profile];
      return data[profile];
    }};
  };
}

test("observes all three independent profiles, including cancelled links and recurrence parent hints, without authorising release",async()=>{
  const called=[];
  const inventory=await observeCrossProfileCalendarAliases(taskId,readers({
    home:[link("home-event",{status:"cancelled"})],
    antonio:[],
    work:[link("work-occurrence",{recurringEventId:"work-master",originalStartTime:{date:"2026-11-03"}})],
  },called));
  assert.deepEqual(called,["home","antonio","work"]);
  assert.equal(inventory.phase,"read_only_observation");
  assert.equal(inventory.allProfilesQueried,true);
  assert.equal(inventory.eligibleForPostWriteRelease,false);
  assert.equal(inventory.identityUnverified,true);
  assert.deepEqual(inventory.observedEventIds,{
    home:["home-event"],antonio:[],work:["work-occurrence"],
  });
  assert.deepEqual(inventory.cancelledEventIds,{home:["home-event"],antonio:[],work:[]});
  assert.deepEqual(inventory.recurringMasterHints,{home:[],antonio:[],work:["work-master"]});
  assert.ok(inventory.missingProof.some(s=>s.includes("Empty profile search")));
  assert.ok(inventory.missingProof.some(s=>s.includes("master/instance")));
  assert.equal(Object.hasOwn(inventory,"calendarAliases"),false,
    "observed aliases must not masquerade as the post-write release manifest");
});

test("provider failure, unlinked event, inconsistent, duplicate or missing profile refuses observation",async()=>{
  for(const data of [
    {home:[],antonio:new Error("provider unavailable"),work:[]},
    {home:[{id:"x"}],antonio:[],work:[]},
    {home:[link("x",{extendedProperties:{shared:{taskId:"different"}}})],antonio:[],work:[]},
    {home:[link("x"),link("x")],antonio:[],work:[]},
    {home:[],antonio:[],work:null},
    {home:Array.from({length:33},(_,i)=>link("event-"+i)),antonio:[],work:[]},
  ]) await assert.rejects(observeCrossProfileCalendarAliases(taskId,readers(data)));
  await assert.rejects(observeCrossProfileCalendarAliases("",readers({home:[],antonio:[],work:[]})));
});

function response(body,status=200) {
  return new Response(JSON.stringify(body),{status});
}

test("all-link provider read includes every page, cancelled and recurring identities without ambiguous selection",async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async url=>{
    const u=String(url);
    if(u.includes("oauth2.googleapis.com"))return response({access_token:"token"});
    calls.push(u);
    const next=new URL(u).searchParams.get("pageToken");
    return next?response({items:[link("occurrence",{recurringEventId:"master"})]}):
      response({items:[link("cancelled",{status:"cancelled"})],nextPageToken:"page-2"});
  };
  try {
    const cal=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"test@example.invalid");
    const all=await cal.listLinkedEventsByTodoistTaskId(taskId);
    assert.deepEqual(all.map(e=>e.id),["cancelled","occurrence"]);
    assert.equal(calls.length,2);
    assert.ok(calls.every(s=>s.includes("singleEvents=false")));
    assert.ok(calls.every(s=>s.includes("showDeleted=true")));
    await assert.rejects(cal.findByTodoistTaskId(taskId),AmbiguousCalendarLinkError);
  }finally{globalThis.fetch=previous;}
});

test("provider page loops, conflicting duplicate snapshots and unidentified results fail closed",async()=>{
  const previous=globalThis.fetch;
  try {
    for(const mode of ["repeat","changed","no-id","items-invalid"]) {
      let call=0;
      globalThis.fetch=async url=>{
        if(String(url).includes("oauth2.googleapis.com"))return response({access_token:"token"});
        call++;
        if(mode==="repeat")return response({items:[],nextPageToken:"same-token"});
        if(mode==="changed")return response(call===1?
          {items:[link("same",{summary:"old"})],nextPageToken:"another"}:
          {items:[link("same",{summary:"new"})]});
        if(mode==="no-id")return response({items:[{status:"cancelled"}]});
        return response({items:"invalid"});
      };
      const cal=new GoogleCalendar({client_id:"id",client_secret:"secret",refresh_token:"refresh"},"test@example.invalid");
      await assert.rejects(cal.listLinkedEventsByTodoistTaskId(taskId));
    }
  }finally{globalThis.fetch=previous;}
});
