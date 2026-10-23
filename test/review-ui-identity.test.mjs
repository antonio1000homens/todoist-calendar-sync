import assert from "node:assert/strict";
import test from "node:test";
import { providerIdentity, dispositionOptions, scopeLabel, previewEffect } from "../review-ui/item-identity.mjs";

const calendar = (id, start, extra={})=>({
  ref:{profile:"home",side:"calendar",id},
  object:{id,summary:"Write letter for Gabriel and Lennox",status:"confirmed",start:{date:start},
    end:{date:start.slice(0,8)+"08"},...extra},
});

test("same-title standalone and yearly Calendar events have distinct visible dates and exact copyable IDs",()=>{
  const standalone=providerIdentity(calendar("standalone-2026","2026-03-01"));
  const master=providerIdentity(calendar("annual-master","2027-03-01",{recurrence:["RRULE:FREQ=YEARLY"]}));
  assert.equal(standalone.title,master.title);
  assert.notEqual(standalone.date,master.date);
  assert.equal(standalone.id,"standalone-2026");
  assert.equal(master.id,"annual-master");
  assert.equal(standalone.recurrence,"One-off / not recurring");
  assert.match(master.recurrence,/Series master.*YEARLY/);
  assert.equal(standalone.identified,true);
  assert.equal(master.identified,true);
});

test("recurrence occurrence exposes master and original start separately from series master",()=>{
  const identity=providerIdentity(calendar("year-2027","2027-03-01",{
    recurringEventId:"annual-master",originalStartTime:{date:"2027-03-01"},
  }));
  assert.match(identity.recurrence,/Series occurrence/);
  assert.match(identity.recurrence,/annual-master/);
  assert.match(identity.recurrence,/original start 2027-03-01/);
  assert.equal(scopeLabel("series"),"Entire series");
  assert.equal(scopeLabel("future"),"Future occurrences (preserve history)");
});

test("cancelled search result is labelled but cannot be chosen as a confirmed Calendar source",()=>{
  const cancelled=providerIdentity({_profile:"home",_side:"calendar",id:"cancelled",
    title:"FotMob",status:"cancelled",start:{date:"2027-06-11"}});
  assert.equal(cancelled.status,"Cancelled");
  assert.equal(cancelled.identified,true);
  assert.equal(cancelled.selectable,false);
  const yearly=providerIdentity({_profile:"home",_side:"calendar",id:"master",
    title:"FotMob",status:"confirmed",start:{date:"2027-06-11"},recurrence:["RRULE:FREQ=YEARLY"]});
  assert.equal(yearly.selectable,true);
  assert.match(yearly.recurrence,/Series master/);
});

test("missing or mismatched provider snapshots cannot receive a disposition",()=>{
  const missing=providerIdentity({ref:{profile:"home",side:"todoist",id:"old-task"},object:null});
  assert.equal(missing.identified,false);
  assert.equal(missing.status,"Missing (404/410)");
  const mismatched=providerIdentity({...calendar("listed-id","2027-03-01"),
    object:{...calendar("listed-id","2027-03-01").object,id:"different-id"}});
  assert.equal(mismatched.identified,false);
  const noDate=providerIdentity(calendar("no-date","2027-03-01",{start:undefined}));
  assert.equal(noDate.identified,false);
});

test("preview identity retains exact disposition and mapping result per provider ID",()=>{
  const snapshot=calendar("standalone-2026","2026-03-01");
  const plan={ref:snapshot.ref,operation:"Exclude from syncing",result:"Remove displaced mapping and mark this provider object excluded"};
  assert.deepEqual(previewEffect(snapshot,{leftovers:{"home:calendar:standalone-2026":"exclude"}},plan),plan);
  const fallback=previewEffect(snapshot,{leftovers:{"home:calendar:standalone-2026":"create"}});
  assert.match(fallback.result,/newly created counterpart/);
});

test("yearly Todoist active task remains distinct from the stale deleted mapped task",()=>{
  const active=providerIdentity({ref:{profile:"home",side:"todoist",id:"active-yearly"},object:{
    id:"active-yearly",content:"FotMob",due:{date:"2027-06-11",string:"every year",is_recurring:true}}});
  const stale=providerIdentity({ref:{profile:"home",side:"todoist",id:"deleted-legacy"},object:null,
    mapping:{profile:"home",taskId:"deleted-legacy",eventId:"master"}});
  assert.equal(active.status,"Active");
  assert.match(active.recurrence,/Recurring Todoist/);
  assert.equal(active.selectable,true);
  assert.equal(stale.identified,false);
  assert.equal(stale.id,"deleted-legacy");
});

test("cancelled Calendar and deleted Todoist objects can be excluded but not used as creation sources",()=>{
  const cancelled=calendar("cancelled","2027-03-01",{status:"cancelled"});
  const deleted={ref:{profile:"home",side:"todoist",id:"deleted-task"},object:{
    id:"deleted-task",content:"Old task",is_deleted:true,due:{date:"2027-03-01"}}};
  assert.deepEqual(dispositionOptions(cancelled),["exclude","unchanged"]);
  assert.deepEqual(dispositionOptions(deleted),["exclude","unchanged"]);
  assert.deepEqual(dispositionOptions(calendar("confirmed","2027-03-01")),["create","exclude","unchanged"]);
  assert.deepEqual(dispositionOptions({ref:{profile:"home",side:"calendar",id:"missing"},object:null}),[]);
});
