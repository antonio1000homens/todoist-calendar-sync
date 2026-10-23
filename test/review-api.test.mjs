import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { SQSClient } from "@aws-sdk/client-sqs";
import { handler, reconciliationAlertRelation } from "../dist/review-api.js";
import { ReviewStore } from "../dist/review-store.js";
import { ReviewEngine } from "../dist/review-engine.js";
import { StateRepository } from "../dist/repository.js";
import { ErasureOperationStore } from "../dist/erasure-executor.js";

const issuer = "https://alf1000.cloudflareaccess.com";
const audience = "review-audience-test";

function event(path, method = "GET", headers = {}, body) {
  const parsed=new URL(path,"https://calendar-sync.alf-broadcast.co.uk");
  return {
    rawPath:parsed.pathname,
    headers,
    body:body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded:false,
    queryStringParameters:Object.fromEntries(parsed.searchParams),
    requestContext:{http:{method}},
  };
}
async function token(privateKey, email = "review-owner@example.test", {aud = audience, expired = false, kid = "review-test-key", tokenIssuer = issuer} = {}) {
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({email})
    .setProtectedHeader({alg:"RS256",kid})
    .setIssuer(tokenIssuer).setAudience(aud).setSubject("access-user-123")
    .setIssuedAt(expired?now-120:now).setExpirationTime(expired?now-60:now+300).sign(privateKey);
}
async function jsonResponse(result) { return {status:result.statusCode, body:JSON.parse(result.body)}; }

test("reconciliation alert hydration distinguishes superseded, progressed, completed, and unchanged runs", () => {
  const alertTime = "2026-10-23T10:00:00.000Z";
  const current = { generation:"generation-1", pending:true, lastProgressAt:"2026-10-23T10:05:00.000Z" };
  assert.equal(reconciliationAlertRelation("generation-0", alertTime, current), "different_generation");
  assert.equal(reconciliationAlertRelation("generation-1", alertTime, current), "progressed_since_alert");
  assert.equal(reconciliationAlertRelation("generation-1", alertTime, { ...current, pending:false,
    lastCompletedAt:"2026-10-23T10:06:00.000Z" }), "completed_since_alert");
  assert.equal(reconciliationAlertRelation("generation-1", alertTime, { ...current, lastProgressAt:"2026-10-23T09:59:00.000Z" }), "same_generation");
  assert.equal(reconciliationAlertRelation("generation-1", alertTime), "unavailable");
});

test("all review, reconciliation, and erasure writers hold the profile admission lease through state/queue handoff",async (t)=>{
  const leaseIssuer="https://lease.alf1000cloudflare.com";
  const old={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUDIENCE,
    operators:process.env.REVIEW_OPERATOR_EMAILS,protocol:process.env.ERASURE_PROTOCOL_VERSION};
  const {privateKey,publicKey}=await generateKeyPair("RS256"),jwk=await exportJWK(publicKey);
  Object.assign(jwk,{kid:"review-lease-test-key",alg:"RS256",use:"sig"});
  globalThis.fetch=async input=>String(input).startsWith(`${leaseIssuer}/cdn-cgi/access/certs`)
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200}):new Response("unexpected fetch",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:leaseIssuer,CF_ACCESS_AUDIENCE:audience,
    REVIEW_OPERATOR_EMAILS:"review-owner@example.test",ERASURE_PROTOCOL_VERSION:"1"});
  t.after(()=>{globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,
      REVIEW_OPERATOR_EMAILS:old.operators,ERASURE_PROTOCOL_VERSION:old.protocol}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const headers={"cf-access-jwt-assertion":await token(privateKey,"review-owner@example.test",{kid:"review-lease-test-key",tokenIssuer:leaseIssuer}),origin:"https://calendar-sync.alf-broadcast.co.uk"};
  const active=new Set(),observed=[];
  let fenceAttempts=0,fenceInstalled=false;
  const tryFence=()=>{if(active.size)return false;fenceInstalled=true;return true;};
  const recordWrite=label=>{fenceAttempts++;assert.equal(tryFence(),false,`${label}: a competing fence must wait for the lease`);observed.push(label);};
  const fenceAfterRelease=()=>{assert.equal(tryFence(),true,"the fence may proceed after the writer releases its lease");fenceInstalled=false;};
  const caseItem={id:"case-lease",profile:"home",status:"open",createdAt:"2026-10-23T00:00:00.000Z",updatedAt:"2026-10-23T00:00:00.000Z"};
  const preview={id:"preview-lease",actor:{subject:"access-user-123",email:"review-owner@example.test"},
    intent:{caseId:"case-lease",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  const operation={id:"operation-lease",preview,actor:preview.actor,status:"queued",attempt:0,steps:{}};
  const store={getCase:async()=>caseItem,dismissCase:async()=>{recordWrite("dismiss");return {...caseItem,status:"dismissed"};},
    getPreview:async()=>preview,submit:async()=>{recordWrite("submit");return operation;},
    getOperation:async()=>operation,saveOperation:async()=>{recordWrite("resume-save");},
    countActionableCases:async()=>0};
  const exact={operationId:"erase-lease",profile:"home",target:{taskId:"task-lease",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},providerSnapshotFingerprint:"a".repeat(64),
    inventory:[],actionPlan:{todoistTask:{id:"task-lease",digest:"b".repeat(64)},comments:[]},
    previewFingerprint:"c".repeat(64),blockers:[]};
  let issuedReads=0;
  const erasureStore={issueConfirmation:async()=>{recordWrite("confirmation");return {confirmationId:"confirm",expiresAt:Date.now()+1000};},
    getIssuedPreview:async()=>{issuedReads++;return {profile:"home",target:exact.target,selectedActions:exact.selectedActions,
      providerSnapshotFingerprint:exact.providerSnapshotFingerprint,inventory:exact.inventory,actionPlan:exact.actionPlan,previewFingerprint:exact.previewFingerprint};},
    create:async op=>{assert.ok(active.has("home"));assert.equal(op.providerDeletionReady,false);recordWrite("operation-create");}};
  const deps={acquireWriteLease:async(profile,owner)=>{assert.ok(owner);assert.equal(fenceInstalled,false,"writers cannot enter after the fence wins");active.add(profile);return async()=>active.delete(profile);},
    createReviewStore:()=>store,createReviewEngine:()=>({preview:async()=>{assert.ok(active.size);recordWrite("case-preview");return {id:"preview",intent:{profile:"home"}};}}),
    createErasureOperationStore:()=>erasureStore,buildErasurePreview:async(_request,options)=>{assert.ok(active.has("home"));
      assert.ok(options.allowLeaseOwner);recordWrite("erasure-preview-recheck");return exact;},
    enqueueRepair:async()=>{assert.ok(active.size);recordWrite("queue-handoff");},
    clearDeadLetterMessagesForProfile:async profile=>{assert.ok(active.has(profile));recordWrite("dlq-clear");return {cleared:0};},
    createStateRepository:()=>({getReconciliationState:async()=>{assert.ok(active.has("home"));return {};}}),
    requestReconciliation:async(_state,profile)=>{assert.ok(active.has(profile));recordWrite("reconciliation-write");return {enqueueError:false};}};

  const casePreview=await jsonResponse(await handler(event("/review/api/cases/case-lease/previews","POST",headers,
    {action:"exclude",winner:"none",scope:"occurrence",leftovers:{}}),deps));
  assert.equal(casePreview.status,200);assert.equal(active.size,0);fenceAfterRelease();
  const dismissed=await jsonResponse(await handler(event("/review/api/cases/case-lease/dismiss","POST",headers,{}),deps));
  assert.equal(dismissed.status,200);assert.equal(active.size,0);fenceAfterRelease();
  let caseLookups=0,dismissWrites=0;
  store.getCase=async()=>++caseLookups===1?caseItem:{...caseItem,profile:"work"};
  store.dismissCase=async()=>{dismissWrites++;return {...caseItem,status:"dismissed"};};
  const changedProfile=await jsonResponse(await handler(event("/review/api/cases/case-lease/dismiss","POST",headers,{}),deps));
  assert.equal(changedProfile.status,409);
  assert.equal(dismissWrites,0,"A case whose profile changes after admission lookup must not be mutated");
  assert.equal(active.size,0);
  fenceAfterRelease();
  caseLookups=0;
  store.getCase=async()=>++caseLookups===1?undefined:caseItem;
  const appearedAfterLookup=await jsonResponse(await handler(event("/review/api/cases/case-lease/dismiss","POST",headers,{}),deps));
  assert.equal(appearedAfterLookup.status,409);
  assert.equal(dismissWrites,0,"A record appearing after a missing admission lookup must not be mutated");
  assert.equal(active.size,0);
  fenceAfterRelease();
  store.getCase=async()=>caseItem;
  const submitted=await jsonResponse(await handler(event("/review/api/previews/preview-lease/submit","POST",{
    ...headers,"idempotency-key":"lease-test-request"},{}),deps));
  assert.equal(submitted.status,202);assert.equal(active.size,0);fenceAfterRelease();
  const resumed=await jsonResponse(await handler(event("/review/api/operations/operation-lease/resume","POST",headers,{}),deps));
  assert.equal(resumed.status,202);assert.equal(active.size,0);fenceAfterRelease();
  const reconcile=await jsonResponse(await handler(event("/review/api/reconciliation","POST",headers,{profile:"home"}),deps));
  assert.equal(reconcile.status,202);assert.equal(active.size,0);fenceAfterRelease();
  const erasurePreview=await jsonResponse(await handler(event("/review/api/erasure-previews","POST",headers,
    {profile:"home",taskId:"task-lease",deleteCalendar:false}),deps));
  assert.equal(erasurePreview.status,200);assert.equal(active.size,0);fenceAfterRelease();
  const erasureCreated=await jsonResponse(await handler(event("/review/api/erasure-operations","POST",headers,
    {operationId:"erase-lease",confirmationId:"confirm"}),deps));
  assert.equal(erasureCreated.status,201);assert.equal(active.size,0);assert.equal(issuedReads,2);fenceAfterRelease();
  for(const expected of ["case-preview","dismiss","submit","queue-handoff","resume-save","dlq-clear",
    "reconciliation-write","confirmation","erasure-preview-recheck","operation-create"])
    assert.ok(observed.includes(expected),`expected leased writer ${expected}`);
  assert.equal(fenceAttempts,observed.length,"every exercised writer must block a competing fence until its lease is released");
});

test("review API requires a valid owner Access JWT and same-origin mutations", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    CF_ACCESS_ISSUER:process.env.CF_ACCESS_ISSUER,
    CF_ACCESS_AUDIENCE:process.env.CF_ACCESS_AUDIENCE,
    REVIEW_OPERATOR_EMAILS:process.env.REVIEW_OPERATOR_EMAILS,
    QUEUE_URL:process.env.QUEUE_URL,
  };
  const {privateKey,publicKey} = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk,{kid:"review-test-key",alg:"RS256",use:"sig"});
  globalThis.fetch = async input => String(input).startsWith(`${issuer}/cdn-cgi/access/certs`)
    ? new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{"content-type":"application/json"}})
    : new Response("unexpected fetch",{status:500});
  Object.assign(process.env,{
    CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,
    REVIEW_OPERATOR_EMAILS:"review-owner@example.test",QUEUE_URL:"https://sqs.eu-west-2.amazonaws.com/123/review.fifo",
  });
  t.after(() => {
    globalThis.fetch=originalFetch;
    for (const [key,value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  });

  const denied = await jsonResponse(await handler(event("/review/api/cases")));
  assert.equal(denied.status,401);
  const foreignOrigin = await jsonResponse(await handler(event("/review/api/reconciliation","POST",{
    origin:"https://attacker.example",
  },{profile:"home"})));
  assert.equal(foreignOrigin.status,403);

  const allowedToken = await token(privateKey);
  const headers = {"cf-access-jwt-assertion":allowedToken};
  const [header,payload,signature] = allowedToken.split(".");
  const badSignature = [header,payload,(signature[0] === "A" ? "B" : "A") + signature.slice(1)].join(".");
  const invalid = await jsonResponse(await handler(event("/review/api/cases","GET",{
    "cf-access-jwt-assertion":badSignature,
  })));
  assert.equal(invalid.status,401,JSON.stringify(invalid.body));
  const wrongAudience = await jsonResponse(await handler(event("/review/api/cases","GET",{
    "cf-access-jwt-assertion":await token(privateKey,"review-owner@example.test",{aud:"wrong-audience"}),
  })));
  assert.equal(wrongAudience.status,401);
  const expired = await jsonResponse(await handler(event("/review/api/cases","GET",{
    "cf-access-jwt-assertion":await token(privateKey,"review-owner@example.test",{expired:true}),
  })));
  assert.equal(expired.status,401);
  const wrongOperator = await token(privateKey,"other@example.test");
  const nonOwner = await jsonResponse(await handler(event("/review/api/cases","GET",{"cf-access-jwt-assertion":wrongOperator})));
  assert.equal(nonOwner.status,403);

  const caseItem={id:"case-1",profile:"home",title:"Conflict",reason:"changed",status:"open",createdAt:"2026-10-22T10:00:00.000Z",updatedAt:"2026-10-22T10:00:00.000Z"};
  const preview={id:"preview-1",actor:{subject:"access-user-123",email:"review-owner@example.test"},intent:{caseId:"case-1",profile:"home",action:"exclude"},expiresAt:Math.floor(Date.now()/1000)+600};
  const operation={id:"operation-1",preview,actor:preview.actor,status:"queued",steps:{},notificationPending:false};
  t.mock.method(ReviewStore.prototype,"listCases",async profile=>({items:profile==="home"?[caseItem]:[],cursor:undefined}));
  t.mock.method(ReviewStore.prototype,"getCase",async id=>id==="case-1"?caseItem:undefined);
  const getOperationMock=t.mock.method(ReviewStore.prototype,"getOperation",async id=>id==="dlq-operation"?{
    id,preview:{id:"dlq-preview",intent:{caseId:"case-1",profile:"home",action:"link",taskId:"dlq-task",eventId:"dlq-event"},itemPlan:[{ref:{profile:"home",side:"todoist",id:"dlq-task"},operation:"retain",result:"linked"}]},status:"failed",
  }:undefined);
  const caseUpdates=[];
  t.mock.method(ReviewStore.prototype,"updateCase",async(...args)=>{caseUpdates.push(args);});
  const previewWithValidation = ReviewEngine.prototype.preview;
  const recurringEvent={id:"occurrence",summary:"Weekly reminder",description:"",status:"confirmed",recurringEventId:"series-master",start:{date:"2026-10-21"},end:{date:"2026-10-22"}};
  const seriesMaster={id:"series-master",summary:"Weekly reminder",description:"",status:"confirmed",recurrence:["RRULE:FREQ=WEEKLY"],start:{date:"2026-10-21"},end:{date:"2026-10-22"}};
  const recurringSnapshots=[
    {ref:{profile:"home",side:"todoist",id:"task-1"},object:{id:"task-1",content:"Weekly reminder",description:"",due:{date:"2026-10-21"},project_id:"test-home-project"}},
    {ref:{profile:"home",side:"calendar",id:"occurrence"},object:recurringEvent},
    {ref:{profile:"home",side:"calendar",id:"series-master"},object:seriesMaster,calendarProjectionId:"occurrence"},
  ];
  t.mock.method(ReviewEngine.prototype,"collect",async intent=>intent.eventId === "cancelled-event" ? [
    {ref:{profile:"home",side:"todoist",id:"task-1"},object:{id:"task-1",content:"Test task",project_id:"test-home-project"}},
    {ref:{profile:"home",side:"calendar",id:"cancelled-event"},object:{id:"cancelled-event",summary:"Cancelled event",status:"cancelled"}},
  ] : ["occurrence","series-master"].includes(intent.eventId) ? recurringSnapshots : []);
  const collectMock=ReviewEngine.prototype.collect;
  t.mock.method(ReviewEngine.prototype,"collect",async function(intent,decision){
    if(intent.taskId==="dlq-task"&&intent.eventId==="dlq-event") return [{ref:{profile:"home",side:"todoist",id:"dlq-task"},object:{id:"dlq-task",content:"Fresh task"}}];
    return collectMock.call(this,intent,decision);
  });
  t.mock.method(ReviewEngine.prototype,"preview",async function(actor,intent) {
    return ["cancelled-event","occurrence","series-master"].includes(intent.eventId)
      ? previewWithValidation.call(this,actor,intent)
      : {...preview,actor};
  });
  const persistedPreviews=[];
  t.mock.method(ReviewStore.prototype,"putPreview",async saved=>{persistedPreviews.push(saved);});
  t.mock.method(ReviewStore.prototype,"getPreview",async id=>id==="preview-1"?preview:undefined);
  t.mock.method(ReviewStore.prototype,"submit",async()=>operation);
  const queueCalls=[];
  t.mock.method(SQSClient.prototype,"send",async command=>{queueCalls.push(command);return {};});

  const inbox = await jsonResponse(await handler(event("/review/api/cases?profile=all","GET",headers)));
  assert.equal(inbox.status,200);
  assert.deepEqual(inbox.body.items.map(item=>item.id),["case-1"]);

  t.mock.method(StateRepository.prototype,"getReconciliationState",async profile=>({profile,generation:"generation-1"}));
  t.mock.method(StateRepository.prototype,"listReconciliationDiagnostics",async(profile,generation,limit,after)=>({
    items:[{profile,generation,action:"todoist_snapshot_reconcile_unmapped_conflict",outcome:"conflict",
      taskId:profile==="home"?"task-7":"work-only-task",eventId:profile==="home"?"event-7":"work-only-event",
      reason:"title_mismatch",...(profile==="home"?{caseId:"case-1",caseStatus:"dismissed"}:{})}],
    next:after?undefined:"ITEM#"+"a".repeat(64),
  }));
  const diagnostics=await jsonResponse(await handler(event("/review/api/reconciliation/diagnostics?profile=home","GET",headers)));
  assert.equal(diagnostics.status,200);
  assert.equal(diagnostics.body.generation,"generation-1");
  assert.deepEqual(diagnostics.body.items.map(item=>item.taskId),["task-7"]);
  assert.ok(diagnostics.body.items.every(item=>item.profile==="home"));
  assert.equal(diagnostics.body.items[0].caseStatus,"open","the endpoint uses the current case state, not the state captured when the run observed it");
  assert.match(diagnostics.body.next,/^ITEM#[a-f0-9]{64}$/);
  const workDiagnostics=await jsonResponse(await handler(event("/review/api/reconciliation/diagnostics?profile=work","GET",headers)));
  assert.equal(workDiagnostics.status,200);
  assert.deepEqual(workDiagnostics.body.items.map(item=>item.taskId),["work-only-task"]);
  assert.ok(workDiagnostics.body.items.every(item=>item.profile==="work"));
  const badDiagnostics=await jsonResponse(await handler(event("/review/api/reconciliation/diagnostics?profile=home&after=invalid","GET",headers)));
  assert.equal(badDiagnostics.status,400);

  const dlqCase={...caseItem,decision:{type:"operational_dlq",profile:"home",context:{kind:"repair",repairOperationId:"dlq-operation"}}};
  t.mock.method(ReviewStore.prototype,"getCase",async id=>id==="case-1"?dlqCase:undefined);
  const hydrated=await jsonResponse(await handler(event("/review/api/cases/case-1","GET",headers)));
  assert.equal(hydrated.status,200,JSON.stringify(hydrated.body));
  assert.equal(hydrated.body.item.repairContext.operationId,"dlq-operation");
  assert.equal(hydrated.body.snapshots[0].object.content,"Fresh task");
  for(const bad of [undefined,{id:"dlq-operation",status:"failed",preview:{id:"p",intent:{caseId:"other",profile:"home"}}},{id:"dlq-operation",status:"failed",preview:{id:"p",intent:{caseId:"case-1",profile:"work"}}}]){
    getOperationMock.mock.mockImplementation(async()=>bad);
    const rejected=await jsonResponse(await handler(event("/review/api/cases/case-1","GET",headers)));
    assert.equal(rejected.status,409);
    assert.match(rejected.body.error,/does not match|unavailable/);
  }
  getOperationMock.mock.mockImplementation(async id=>id==="dlq-operation"?{id,preview:{id:"dlq-preview",intent:{caseId:"case-1",profile:"home",action:"link",taskId:"dlq-task",eventId:"dlq-event"},itemPlan:[]},status:"failed"}:undefined);

  const previewResult = await jsonResponse(await handler(event("/review/api/cases/case-1/previews","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
  },{action:"exclude",winner:"none",scope:"occurrence",leftovers:{}})));
  assert.equal(previewResult.status,200);

  const cancelledPreview=await jsonResponse(await handler(event("/review/api/cases/case-1/previews","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
  },{action:"link",taskId:"task-1",eventId:"cancelled-event",winner:"none",scope:"occurrence",leftovers:{}})));
  assert.equal(cancelledPreview.status,400);
  assert.equal(cancelledPreview.body.error,"Calendar repair sources must be confirmed; choose a live event or exclude the cancelled item");

  // Real engine preview validation behind the authenticated API: a missing
  // owner must never persist a preview or queue provider writes. Both supported
  // Calendar source shapes must succeed once the owner is explicit.
  for (const [eventId,scope] of [["occurrence","occurrence"],["series-master","series"]]) {
    const form={action:"link",taskId:"task-1",eventId,winner:"calendar",scope,leftovers:{}};
    const missingOwner=await jsonResponse(await handler(event("/review/api/cases/case-1/previews","POST",{
      ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
    },form)));
    assert.equal(missingOwner.status,400,JSON.stringify(missingOwner.body));
    assert.match(missingOwner.body.error,/Choose which provider owns the recurrence/);
    assert.equal(persistedPreviews.length,scope==="occurrence"?0:1,"Invalid preview must not be persisted");
    assert.equal(queueCalls.length,0,"Preview must never enqueue a repair");
    assert.equal(caseUpdates.length,0,"Preview must not change the case");

    const withOwner=await jsonResponse(await handler(event("/review/api/cases/case-1/previews","POST",{
      ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
    },{...form,owner:"calendar"})));
    assert.equal(withOwner.status,200,JSON.stringify(withOwner.body));
    assert.equal(withOwner.body.preview.intent.owner,"calendar");
    assert.equal(withOwner.body.preview.intent.scope,scope);
    assert.equal(persistedPreviews.length,scope==="occurrence"?1:2);
    assert.equal(queueCalls.length,0);
  }

  t.mock.method(ReviewStore.prototype,"dismissCase",async(id,result)=>{caseUpdates.push([id,"dismissed",result]);return {...caseItem,status:"dismissed",result};});
  const dismissed=await jsonResponse(await handler(event("/review/api/cases/case-1/dismiss","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
  },{})));
  assert.equal(dismissed.status,200);
  assert.equal(dismissed.body.item.status,"dismissed");
  assert.equal(caseUpdates[0][1],"dismissed");

  const submitted = await jsonResponse(await handler(event("/review/api/previews/preview-1/submit","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk","idempotency-key":"review-request-1",
  },{})));
  assert.equal(submitted.status,202);
  assert.equal(queueCalls.length,1);

  // Readiness revocation must reject a persisted active lifecycle before the
  // API transitions state or hands another message to the queue.
  const operationReads=[];
  const transitions=[];
  t.mock.method(ErasureOperationStore.prototype,"get",async id=>{
    operationReads.push(id);
    return {operationId:id,profile:"home",status:"deleting",providerDeletionReady:false,
      lifecycle:{phase:"deleting",nextRunAt:"2026-10-23T10:00:00.000Z"}};
  });
  t.mock.method(ErasureOperationStore.prototype,"transition",async(...args)=>{transitions.push(args);});
  const queueCountBefore=queueCalls.length;
  const rejectedResume=await jsonResponse(await handler(event("/review/api/erasure-operations/erasure-1/start","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
  },{})));
  assert.equal(rejectedResume.status,409,JSON.stringify(rejectedResume.body));
  assert.deepEqual(operationReads,["erasure-1","erasure-1"],"The API pre-reads identity for admission, then re-reads before the decision");
  assert.deepEqual(transitions,[]);
  assert.equal(queueCalls.length,queueCountBefore,"A false-ready active lifecycle must not be re-enqueued");
});
