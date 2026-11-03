import test from "node:test";
import assert from "node:assert/strict";
import {
  SYNC_PROFILES, reconciliationScopes, manualReconciliationTarget,
  createScopedRequestGate, reviewScopeLabel,
} from "../review-ui/reconciliation-scope.mjs";

test("all profiles has three independently scoped run summaries, not one aggregate run",()=>{
  assert.deepEqual(reconciliationScopes("all"),["home","antonio","work"]);
  for(const profile of SYNC_PROFILES){
    assert.deepEqual(reconciliationScopes(profile),[profile]);
    assert.equal(reviewScopeLabel(profile),`profile ${profile}`);
  }
  assert.equal(reviewScopeLabel("all"),"all profiles");
  assert.deepEqual(reconciliationScopes("invalid"),[]);
});

test("manual reconciliation follows a concrete review filter unless a selected case is authoritative",()=>{
  for(const filter of SYNC_PROFILES){
    assert.equal(manualReconciliationTarget({filter,chosenProfile:"work"}),filter);
  }
  assert.equal(manualReconciliationTarget({filter:"home",selectedProfile:"work",chosenProfile:"antonio"}),"work");
  assert.equal(manualReconciliationTarget({filter:"all",selectedProfile:"antonio",chosenProfile:"work"}),"antonio");
});

test("All profiles requires an explicitly selected single target and never fans out",()=>{
  assert.equal(manualReconciliationTarget({filter:"all"}),undefined);
  assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:""}),undefined);
  assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:"all"}),undefined);
  assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:"unknown"}),undefined);
  for(const profile of SYNC_PROFILES)
    assert.equal(manualReconciliationTarget({filter:"all",chosenProfile:profile}),profile);
});

test("an older profile response cannot overwrite a new filter even when switching home -> work -> home",()=>{
  const gate=createScopedRequestGate("home");
  const firstHome=gate.begin("reconcile:home");
  const firstInbox=gate.begin("inbox");
  assert.equal(gate.current(firstHome),true);
  gate.switchScope("work");
  assert.equal(gate.current(firstHome),false);
  assert.equal(gate.current(firstInbox),false);
  const work=gate.begin("reconcile:work");
  const workInbox=gate.begin("inbox");
  gate.switchScope("home");
  const secondHome=gate.begin("reconcile:home");
  assert.equal(gate.current(firstHome),false);
  assert.equal(gate.current(work),false);
  assert.equal(gate.current(workInbox),false);
  assert.equal(gate.current(secondHome),true);
});

test("overlapping same-profile requests keep the latest generation and diagnostics",()=>{
  const gate=createScopedRequestGate("all");
  const oldSummary=gate.begin("reconcile:home");
  const otherProfile=gate.begin("reconcile:work");
  const newestSummary=gate.begin("reconcile:home");
  assert.equal(gate.current(oldSummary),false);
  assert.equal(gate.current(newestSummary),true);
  assert.equal(gate.current(otherProfile),true);
  const oldPage=gate.begin("more:home");
  const newPage=gate.begin("more:home");
  assert.equal(gate.current(oldPage),false);
  assert.equal(gate.current(newPage),true);
});

test("out-of-order promise completion is ignored after switching scope",async()=>{
  const gate=createScopedRequestGate("home");
  const records=[];
  let finishOld,finishNew;
  const old=new Promise(resolve=>finishOld=resolve);
  const newer=new Promise(resolve=>finishNew=resolve);
  const ticketOld=gate.begin("reconcile:home");
  const runOld=old.then(value=>{if(gate.current(ticketOld))records.push(value);});
  gate.switchScope("antonio");
  const ticketNew=gate.begin("reconcile:antonio");
  const runNew=newer.then(value=>{if(gate.current(ticketNew))records.push(value);});
  finishNew("antonio");
  await runNew;
  finishOld("stale home");
  await runOld;
  assert.deepEqual(records,["antonio"]);
});

test("a latest manual target is always a single concrete profile",()=>{
  const gate=createScopedRequestGate("all");
  const target=manualReconciliationTarget({filter:"all",chosenProfile:"work"});
  assert.ok(SYNC_PROFILES.includes(target));
  const response=gate.begin(`manual:${target}`);
  gate.switchScope("home");
  assert.equal(gate.current(response),false,"response to old operator action must not alter the new scope");
});

test("closures from a previous profile cannot start a request in the new scope",()=>{
  const gate=createScopedRequestGate("home");
  gate.switchScope("work");
  assert.equal(gate.begin("inbox","home"),undefined);
  assert.equal(gate.begin("reconcile:home","home"),undefined);
  const work=gate.begin("inbox","work");
  assert.equal(gate.current(work),true);
  gate.switchScope("all");
  assert.equal(gate.begin("inbox","work"),undefined);
  assert.equal(gate.current(work),false);
});
