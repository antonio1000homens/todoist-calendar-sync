import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  validateResidueScope, collectExactReferences, assessResidueRow, countResidueRow,
  emptyResidueReport, scopeDigest,
} from "../scripts/verified-deletion-residue-policy.mjs";
import { inventory, parseArgs } from "../scripts/inspect-verified-deletion-residue.mjs";

const scope = { profile: "home", caseIds: ["case-1"], taskIds: ["task-one"], eventIds: ["master-one"] };
const now = 1800000000;

test("strict CLI has no apply mode, requires explicit scoped case/provider identities", () => {
  assert.throws(() => parseArgs(["--profile=home", "--case=case-1", "--task-id=task-one", "--apply"]), /Unknown option/);
  assert.throws(() => parseArgs(["--profile=home", "--case=case-1"]), /provider ID/);
  assert.throws(() => parseArgs(["--profile=all", "--case=case-1", "--task-id=task-one"]), /profile/);
  assert.throws(() => parseArgs(["--profile=home", "--case=case-1", "--task-id=task-one", "--max-pages=1000"]), /max-pages/);
  assert.doesNotThrow(() => validateResidueScope(scope));
  assert.notEqual(scopeDigest(scope, "table1"), scopeDigest(scope, "table2"));
});

test("only typed exact identities count; title and description matches never count", () => {
  const row = {pk:"AUDIT#home#one", sk:"STATE", title:"task-one", detail:{description:"master-one"}};
  assert.equal(assessResidueRow(row,scope),null);
  const refs = collectExactReferences({detail:{taskId:"task-one",masterEventId:"master-one"},
    snapshots:[{ref:{side:"calendar",id:"master-one"}}]});
  assert.deepEqual([...refs.todoist],["task-one"]);
  assert.deepEqual([...refs.calendar],["master-one"]);
});

test("significant unindexed audit remains under TTL, not an automatic deletion candidate", () => {
  const row = {pk:"AUDIT#home#conflict",sk:"STATE",detail:{taskId:"task-one",eventId:"master-one"},
    expiresAt:now+100,createdAt:"2026-11-07T00:00:00Z"};
  const report = emptyResidueReport();
  const assessment = assessResidueRow(row,scope,new Set(),now);
  assert.equal(assessment.classification,"awaiting_defined_TTL");
  assert.equal(assessment.matchingUnindexedAudit,true);
  countResidueRow(report,row,assessment);
  assert.equal(report.matchingAuditsWithoutExactReversePointer,1);
  assert.equal(report.byClass.eligible_and_exclusively_attributable,0);
  assert.equal(assessResidueRow(row,scope,new Set([row.pk]),now).matchingUnindexedAudit,false);
  assert.equal(assessResidueRow({...row,expiresAt:now-1},scope,new Set(),now).classification,"expired_but_still_present");
});

test("shared evidence, active repairs and submitted previews are never marked eligible", () => {
  const common = {sk:"STATE",preview:{intent:{caseId:"case-1",profile:"home",
    taskId:"task-one",eventId:"master-one"}}};
  const shared = {pk:"AUDIT#home#shared",sk:"STATE",
    detail:{taskId:"task-one",candidateTaskIds:["someone-else"]}};
  assert.equal(assessResidueRow(shared,scope,new Set(),now).classification,"shared_or_active");
  assert.equal(assessResidueRow({...common,pk:"REPAIR#abc",status:"running"},scope,new Set(),now).classification,"shared_or_active");
  const terminal = assessResidueRow({...common,pk:"REPAIR#abc",status:"succeeded"},scope,new Set(),now);
  assert.equal(terminal.classification,"unknown_or_incomplete");
  assert.equal(terminal.terminalRepairNoTtl,true);
  assert.equal(assessResidueRow({...common,pk:"REPAIR_PREVIEW#abc",submittedOperation:"run",expiresAt:now-1},
    scope,new Set(),now).classification,"shared_or_active");
  const expiredPreview = assessResidueRow({...common,pk:"REPAIR_PREVIEW#abc",expiresAt:now-1},
    scope,new Set(),now);
  assert.equal(expiredPreview.classification,"expired_but_still_present");
  assert.equal(expiredPreview.expiredUnsubmittedPreview,true);
});

test("identity-free terminal receipt is counted retired; live case is blocked", () => {
  const row={pk:"REVIEW_CASE#case-1",sk:"STATE",profile:"home",
    status:"resolved",result:"resolved_deleted: provider gone"};
  assert.equal(assessResidueRow(row,scope,new Set(),now).classification,"already_retired");
  assert.equal(assessResidueRow({...row,status:"open",result:"open"},scope,new Set(),now).classification,"shared_or_active");
});

function fixtureClient({caseStatus="resolved",refPages=[],pages=[]}={}) {
  const commands=[];
  let scan=0,refs=0;
  return {commands,client:{async send(command){
    commands.push(command);
    if(command instanceof GetCommand)return {Item:{
      pk:"REVIEW_CASE#case-1",sk:"STATE",profile:"home",status:caseStatus,
      result:caseStatus==="resolved"?"resolved_deleted: verified":"still open",
    }};
    if(command instanceof QueryCommand)return refPages[refs++] || {Items:[]};
    if(command instanceof ScanCommand)return pages[scan++] || {Items:[]};
    throw new Error("Write command forbidden");
  }}};
}
function cursorStore() {
  let record=null;
  return {
    async load(){return record;},
    async save(v){record=structuredClone(v);},
    async clear(){record=null;},
    get stored(){return record;},
  };
}

test("bounded inventory saves resumable progress without repeating a page; never writes", async()=>{
  const {client,commands}=fixtureClient({pages:[
    {Items:[{pk:"AUDIT#home#legacy",sk:"STATE",detail:{taskId:"task-one"},
      expiresAt:now+50}],ScannedCount:25,LastEvaluatedKey:{pk:"checkpoint",sk:"STATE"}},
    {Items:[{pk:"REPAIR#abc",sk:"STATE",status:"succeeded",
      preview:{intent:{caseId:"case-1",taskId:"task-one"}}}],ScannedCount:25},
  ]});
  const store=cursorStore();
  const opts={...scope,maxPages:1,maxRefPages:8};
  const first=await inventory({options:opts,table:"table",client,cursorStore:store,clock:()=>now*1000,delay:async()=>{}});
  assert.equal(first.scanComplete,false);
  assert.equal(first.matchedRows,1);
  assert.ok(store.stored);
  const second=await inventory({options:opts,table:"table",client,cursorStore:store,clock:()=>now*1000,delay:async()=>{}});
  assert.equal(second.scanComplete,true);
  assert.equal(second.matchedRows,2);
  assert.equal(second.terminalRepairsWithoutTtl,1);
  assert.equal(second.byClass.eligible_and_exclusively_attributable,0);
  assert.equal(store.stored,null);
  assert.ok(commands.every(c=>c instanceof GetCommand||c instanceof QueryCommand||c instanceof ScanCommand));
});

test("missing or nonterminal source case stops before scanning",async()=>{
  const {client,commands}=fixtureClient({caseStatus:"open"});
  await assert.rejects(inventory({options:{...scope,maxPages:1,maxRefPages:1},
    table:"table",client,cursorStore:cursorStore(),delay:async()=>{}}),/not a verified-deletion terminal/);
  assert.equal(commands.some(c=>c instanceof ScanCommand),false);
});

test("partial audit reverse-pointer enumeration fails closed",async()=>{
  const {client,commands}=fixtureClient({refPages:[
    {Items:[{auditKey:"AUDIT#home#1"}],LastEvaluatedKey:{pk:"a",sk:"b"}},
  ]});
  await assert.rejects(inventory({options:{...scope,maxPages:1,maxRefPages:1},
    table:"table",client,cursorStore:cursorStore(),delay:async()=>{}}),/pagination incomplete/);
  assert.equal(commands.some(c=>c instanceof ScanCommand),false);
});

test("same provider ID in a foreign profile remains protected", () => {
  const row = {pk:"AUDIT#work#conflict",sk:"STATE",detail:{taskId:"task-one"},
    expiresAt:now+200};
  assert.equal(assessResidueRow(row,scope,new Set(),now).classification,"shared_or_active");
});

test("--restart discards mismatched private cursor scope without scanning a foreign checkpoint",async()=>{
  const {client,commands}=fixtureClient({pages:[{Items:[],ScannedCount:0}]});
  const store=cursorStore();
  await store.save({digest:"another-case",cursor:{pk:"old",sk:"STATE"},report:emptyResidueReport()});
  const opts={...scope,maxPages:1,maxRefPages:1,restart:true};
  const report=await inventory({options:opts,table:"table",client,cursorStore:store,delay:async()=>{}});
  assert.equal(report.scanComplete,true);
  assert.equal(store.stored,null);
  assert.ok(commands.some(x=>x instanceof ScanCommand));
});
