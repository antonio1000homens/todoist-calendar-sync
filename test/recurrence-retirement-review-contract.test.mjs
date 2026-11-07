import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {handler} from "../dist/review-api.js";

const origin="https://calendar-sync.alf-broadcast.co.uk";
const issuer="https://retirement-351-access.example";
const audience="retirement-audience-351";
const phrase="RETIRE ASSOCIATION KEEP PROVIDER ITEMS WITHOUT SERIES CERTIFICATE";
const undoPhrase="RE-ENABLE ASSOCIATION SYNC WITHOUT RESTORING MAPPING";
const target={profile:"work",generation:"historical-351",
  taskId:"completed-task-351",eventId:"historical-occurrence-351",
  seriesId:"historical-series-351"};
const url=(route,query)=>"/review/api/"+route+(query?"?"+new URLSearchParams(query):"");
function event(route,method="GET",headers={},body){
  const address=new URL(route,origin);
  return {rawPath:address.pathname,headers,isBase64Encoded:false,
    queryStringParameters:Object.fromEntries(address.searchParams),
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    requestContext:{http:{method}}};
}
async function json(result){return {code:result.statusCode,...JSON.parse(result.body)};}
function env(t) {
  const keys=["CF_ACCESS_ISSUER","CF_ACCESS_AUDIENCE","REVIEW_OPERATOR_EMAILS",
    "ERASURE_PROTOCOL_VERSION"];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,
    REVIEW_OPERATOR_EMAILS:"retirement-owner@example.test",ERASURE_PROTOCOL_VERSION:"1"});
  const originalFetch=globalThis.fetch;
  t.after(()=>{
    globalThis.fetch=originalFetch;
    for(const [k,v] of Object.entries(saved))
      if(v===undefined)delete process.env[k];else process.env[k]=v;
  });
}
test("#351 scoped review API requires Access JWT, operator ownership, and independent approval/Apply",async t=>{
  env(t);
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);
  Object.assign(jwk,{kid:"retirement-351-key",use:"sig",alg:"RS256"});
  globalThis.fetch=async u=>String(u).startsWith(issuer+"/cdn-cgi/access/certs")
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200}):
      new Response("Unexpected request",{status:500});
  const jwt=await new SignJWT({email:"retirement-owner@example.test"})
    .setProtectedHeader({alg:"RS256",kid:"retirement-351-key"})
    .setIssuer(issuer).setAudience(audience).setSubject("operator-351")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const headers={"cf-access-jwt-assertion":jwt,origin};
  const trace=[];
  const service={
    async issue(value,fingerprint,actor){
      trace.push(["issue",value,fingerprint,actor]);
      return {operation:{operationId:"op-351",status:"previewed",profile:"work"},
        confirmationId:"secret-351",phrase,providerWrites:false};
    },
    async apply(id,confirmation,profile,actor,typed){
      trace.push(["apply",id,confirmation,profile,actor,typed]);
      return {operationId:id,profile,status:"retired"};
    },
    async get(id){trace.push(["get",id]);return {operationId:id,profile:"work",actorSubject:"operator-351"};},
    async status(id,actor){trace.push(["status",id,actor]);return {operationId:id,status:"retired"};},
    async history(profile){trace.push(["history",profile]);return [{operationId:"op-351",status:"retired"}];},
  };
  const undo={
    async inspect(id,actor){trace.push(["inspectUndo",id,actor]);return {operationId:id,eligible:true,blockers:[]};},
    async approveUndo(id,fp,actor){trace.push(["approveUndo",id,fp,actor]);
      return {operationId:id,confirmationId:"undo-secret",phrase:undoPhrase,providerWrites:false};},
    async applyUndo(id,token,actor,text){trace.push(["applyUndo",id,token,actor,text]);
      return {operationId:id,status:"re_enabled",providerWrites:false};},
  };
  const cleanup={async cleanup(id,actor){trace.push(["cleanup",id,actor]);
    return {operationId:id,status:"completed",deletedAudits:1,protectedRecords:3,blockers:[],providerWrites:false};}};
  let leaseCount=0;
  const deps={
    acquireWriteLease:async()=>{leaseCount++;return async()=>{leaseCount--;};},
    createRetirementOperationService:()=>service,
    createRetirementUndoService:()=>undo,
    createRetirementIncidentCleanupService:()=>cleanup,
    inspectRecurrenceRetirement:async value=>{trace.push(["inspect",value]);return {blockers:[],providerWrites:false};},
    previewRecurrenceRetirement:async value=>{trace.push(["preview",value]);return {preview:{status:"reviewable",planFingerprint:"f".repeat(64)}};},
  };
  const denied=await json(await handler(event(url("reconciliation/retirement-inspection",target))));
  assert.equal(denied.code,401);
  const inspection=await json(await handler(event(url("reconciliation/retirement-inspection",target),"GET",headers),deps));
  assert.equal(inspection.code,200);
  const preview=await json(await handler(event(url("reconciliation/retirement-preview",target),"GET",headers),deps));
  assert.equal(preview.code,200);
  const missingIdentity=await json(await handler(event(url("reconciliation/retirement-inspection",
    {profile:"work",generation:"x"}),"GET",headers),deps));
  assert.equal(missingIdentity.code,400);
  const badOrigin=await json(await handler(event(url("reconciliation/retirement-approvals"),
    "POST",{...headers,origin:"https://attacker.example"},{...target,planFingerprint:"f".repeat(64)}),deps));
  assert.equal(badOrigin.code,403);
  const approval=await json(await handler(event(url("reconciliation/retirement-approvals"),
    "POST",headers,{...target,planFingerprint:"f".repeat(64)}),deps));
  assert.equal(approval.code,201);assert.equal(approval.providerWrites,false);
  const badPhrase=await json(await handler(event(url("reconciliation/retirement-apply"),
    "POST",headers,{profile:"work",operationId:"op-351",confirmationId:"secret-351",phrase:"delete both"}),deps));
  assert.equal(badPhrase.code,400);
  assert.equal(trace.filter(x=>x[0]==="apply").length,0);
  const applied=await json(await handler(event(url("reconciliation/retirement-apply"),
    "POST",headers,{profile:"work",operationId:"op-351",confirmationId:"secret-351",phrase}),deps));
  assert.equal(applied.code,200);assert.equal(applied.operation.status,"retired");
  const status=await json(await handler(event(url("reconciliation/retirement-operations/op-351"),
    "GET",headers),deps));assert.equal(status.code,200);
  const history=await json(await handler(event(url("reconciliation/retirement-history",
    {profile:"work"}),"GET",headers),deps));assert.equal(history.code,200);
  const cleaned=await json(await handler(event(url("reconciliation/retirement-cleanup"),
    "POST",headers,{profile:"work",operationId:"op-351"}),deps));
  assert.equal(cleaned.code,200);
  const undone=await json(await handler(event(url("reconciliation/retirement-undo-inspection",
    {operationId:"op-351"}),"GET",headers),deps));assert.equal(undone.code,200);
  const issuedUndo=await json(await handler(event(url("reconciliation/retirement-undo-approvals"),
    "POST",headers,{profile:"work",operationId:"op-351",fingerprint:"f".repeat(64)}),deps));
  assert.equal(issuedUndo.code,201);
  const doneUndo=await json(await handler(event(url("reconciliation/retirement-undo-apply"),
    "POST",headers,{profile:"work",operationId:"op-351",confirmationId:"undo-secret",phrase:undoPhrase}),deps));
  assert.equal(doneUndo.code,200);assert.equal(doneUndo.operation.status,"re_enabled");
  assert.equal(leaseCount,0,"all review admission leases must be released");
  assert.equal(trace.filter(x=>x[0]==="issue").length,1);
  assert.equal(trace.filter(x=>x[0]==="apply").length,1);
  assert.equal(trace.filter(x=>x[0]==="applyUndo").length,1);
  assert.equal(trace.find(x=>x[0]==="issue")[3],"operator-351");
});

test("#351 UI exposes retirement only on reviewable diagnostics, separate typed Apply and safe Undo",async()=>{
  const [main,inspector,history]=await Promise.all([
    readFile(new URL("../review-ui/main.tsx",import.meta.url),"utf8"),
    readFile(new URL("../review-ui/recurrence-retirement-inspector.tsx",import.meta.url),"utf8"),
    readFile(new URL("../review-ui/retirement-history.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(main,/item\.caseStatus!=="retired"/);
  assert.match(main,/RecurrenceRetirementInspector/);
  assert.match(main,/RetirementHistory/);
  assert.match(inspector,/preview\.status==="reviewable"/);
  assert.match(inspector,/Request retirement approval token/);
  assert.match(inspector,/confirmPhrase!==approval\.phrase/);
  assert.match(inspector,/No Todoist or Calendar objects/);
  assert.match(inspector,/retirement-apply/);
  assert.match(inspector,/retirement-undo-approvals/);
  assert.match(inspector,/undoPhrase!==undoApproval\.phrase/);
  assert.match(inspector,/Confirm re-enable syncing/);
  assert.match(inspector,/Clean exclusively attributable incident evidence/);
  assert.match(history,/retirement-history/);
  assert.match(history,/Association retired by operator/);
});
