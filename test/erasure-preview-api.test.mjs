import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { handler } from "../dist/review-api.js";

const issuer="https://erasure-preview.cloudflareaccess.com", audience="erasure-preview-test";
const signing=await generateKeyPair("RS256");
const jwk=await exportJWK(signing.publicKey);Object.assign(jwk,{kid:"preview-test-key",alg:"RS256",use:"sig"});
async function signedHeaders(){
  const jwt=await new SignJWT({email:"operator@example.test"}).setProtectedHeader({alg:"RS256",kid:"preview-test-key"})
    .setIssuer(issuer).setAudience(audience).setSubject("operator-1").setIssuedAt().setExpirationTime("5m").sign(signing.privateKey);
  return {origin:"https://calendar-sync.alf-broadcast.co.uk","cf-access-jwt-assertion":jwt};
}
const event=(path,method,headers={},body)=>({rawPath:path,headers,body:body===undefined?undefined:JSON.stringify(body),
  isBase64Encoded:false,requestContext:{http:{method}},queryStringParameters:{}});

test("preview issues one-use confirmation; create rechecks inventory and persists only an exact fresh operation",async t=>{
  const old={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUDIENCE,
    operators:process.env.REVIEW_OPERATOR_EMAILS,protocol:process.env.ERASURE_PROTOCOL_VERSION,
    enabled:process.env.ERASURE_EXECUTION_ENABLED};
  globalThis.fetch=async input=>String(input).startsWith(`${issuer}/cdn-cgi/access/certs`)
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{"content-type":"application/json"}}):new Response("unexpected",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,REVIEW_OPERATOR_EMAILS:"operator@example.test"});
  const headers=await signedHeaders();
  const exact={operationId:"op-preview",profile:"home",target:{taskId:"task-123",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},previewFingerprint:"canonical-preview-digest",
    inventoryDigest:"exact-inventory-digest",inventory:[{type:"TASK",key:{pk:"TASK#home#task-123",sk:"MAP"},digest:"row-digest",classification:"selected-only"}],
    classificationCounts:{"selected-only":1},blockers:[]};
  let calls=0,issued,created;
  const store={issueConfirmation:async()=>({confirmationId:"single-use",expiresAt:Date.now()+300_000}),
    getIssuedPreview:async()=>issued,create:async operation=>{created=operation;}};
  const deps={createErasureOperationStore:()=>store,buildErasurePreview:async(input,options={})=>{
    calls++;return {...exact,operationId:options.newOperationId?.()||"op-preview",profile:input.profile,target:{taskId:input.taskId,
      ...(input.eventId?{eventId:input.eventId}:{}),deleteCalendar:input.deleteCalendar},
      selectedActions:{deleteTodoist:true,deleteCalendar:input.deleteCalendar}};
  }};
  t.after(()=>{globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,REVIEW_OPERATOR_EMAILS:old.operators}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const preview=await handler(event("/review/api/erasure-previews","POST",headers,
    {profile:"home",taskId:"task-123",deleteCalendar:false}),deps);
  assert.equal(preview.statusCode,200);
  assert.equal(JSON.parse(preview.body).preview.confirmation.confirmationId,"single-use");
  issued={profile:"home",target:{taskId:"task-123",deleteCalendar:false},selectedActions:{deleteTodoist:true,deleteCalendar:false},previewFingerprint:exact.previewFingerprint};
  const createdResponse=await handler(event("/review/api/erasure-operations","POST",headers,
    {operationId:"op-preview",confirmationId:"single-use"}),deps);
  assert.equal(createdResponse.statusCode,201);
  assert.equal(calls,2,"creation must perform a fresh full inventory/provider read");
  assert.equal(created.status,"previewed");assert.equal(created.inventory[0].digest,"row-digest");
  assert.equal(JSON.parse(createdResponse.body).operation.queueReady,false);
  assert.equal(JSON.parse(createdResponse.body).operation.providerDeletionReady,false);
  assert.equal(created.providerDeletionReady,false);
});

test("operation creation refuses a changed exact inventory and leaves confirmation unconsumed",async t=>{
  const old={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUDIENCE,
    operators:process.env.REVIEW_OPERATOR_EMAILS};
  globalThis.fetch=async input=>String(input).startsWith(`${issuer}/cdn-cgi/access/certs`)
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200}):new Response("unexpected",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,REVIEW_OPERATOR_EMAILS:"operator@example.test"});
  const headers=await signedHeaders();
  const calls=[];
  const store={getIssuedPreview:async()=>({profile:"home",target:{taskId:"task-123",deleteCalendar:false},
    selectedActions:{deleteTodoist:true,deleteCalendar:false},previewFingerprint:"old-digest"}),create:async()=>calls.push("create")};
  const deps={createErasureOperationStore:()=>store,buildErasurePreview:async()=>({blockers:[],previewFingerprint:"new-digest"})};
  t.after(()=>{globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,REVIEW_OPERATOR_EMAILS:old.operators}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const result=await handler(event("/review/api/erasure-operations","POST",headers,{operationId:"op-preview",confirmationId:"token"}),deps);
  assert.equal(result.statusCode,409);assert.deepEqual(calls,[]);
});

test("preview-only operation cannot be started before provider deletion is implemented",async t=>{
  const old={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUDIENCE,
    operators:process.env.REVIEW_OPERATOR_EMAILS};
  globalThis.fetch=async input=>String(input).startsWith(`${issuer}/cdn-cgi/access/certs`)
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200}):new Response("unexpected",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,REVIEW_OPERATOR_EMAILS:"operator@example.test"});
  const headers=await signedHeaders();
  const store={get:async()=>({operationId:"op-preview",status:"previewed",providerDeletionReady:false})};
  t.after(()=>{globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,REVIEW_OPERATOR_EMAILS:old.operators}))
      if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const result=await handler(event("/review/api/erasure-operations/op-preview/start","POST",headers,{}),
    {createErasureOperationStore:()=>store});
  assert.equal(result.statusCode,409);
  assert.match(JSON.parse(result.body).error,/provider deletion and postflight workflow is not available/);
});
