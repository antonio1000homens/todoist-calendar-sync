import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {handler} from "../dist/review-api.js";

const issuer="https://recovery.cloudflareaccess.com",audience="recovery-tests";
function request(route,method,headers,body) {
  return {rawPath:route,headers,body:body===undefined?undefined:JSON.stringify(body),
    isBase64Encoded:false,requestContext:{http:{method}},queryStringParameters:{}};
}
test("authenticated recovery is separate from fenced admission, requires exact typed confirmation, and never invokes erasure start",async t=>{
  const old={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,audience:process.env.CF_ACCESS_AUDIENCE,
    emails:process.env.REVIEW_OPERATOR_EMAILS};
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);Object.assign(jwk,{kid:"recovery",alg:"RS256",use:"sig"});
  globalThis.fetch=async input=>String(input).startsWith(issuer+"/cdn-cgi/access/certs")
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200})
    :new Response("not available",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,
    REVIEW_OPERATOR_EMAILS:"reviewer@example.test"});
  t.after(()=>{
    globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,
      REVIEW_OPERATOR_EMAILS:old.emails}))if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  const jwt=await new SignJWT({email:"reviewer@example.test"})
    .setProtectedHeader({alg:"RS256",kid:"recovery"})
    .setIssuer(issuer).setAudience(audience).setSubject("operator-recovery")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const headers={origin:"https://calendar-sync.alf-broadcast.co.uk","cf-access-jwt-assertion":jwt};
  const calls=[],messages=[];
  const erasures={async get(){return {operationId:"op-1",profile:"work",status:"review_required"};}};
  const recovery={
    async inspect(id){calls.push(["inspect",id]);return {preview:{operationId:id,profile:"work",
      phase:"wait_worker_timeout",classification:"pre_write",allowed:true,blockers:[],mappingStates:[],
      fenceOwned:true,leaseCount:0,providerItemsAbsent:false,stateRowsAbsent:false,epoch:3}};},
    async issueConfirmation(id,operator){calls.push(["issue",id,operator]);return {
      preview:{operationId:id,profile:"work",classification:"pre_write",allowed:true,blockers:[]},
      confirmationId:"fresh-recovery",expiresAt:Date.now()+60_000};},
    async apply(id,token,operator){calls.push(["apply",id,token,operator]);},
    async status(){return {status:"queued",startedAt:"now"};},
  };
  const run=e=>handler(e,{createErasureRecoveryService:()=>recovery,
    createErasureOperationStore:()=>erasures,
    acquireWriteLease:async()=>{throw new Error("Recovery must not acquire a normal fenced admission lease");},
    enqueueErasureRecovery:async id=>messages.push(id)});
  const badAuth=await run(request("/review/api/erasure-recoveries/op-1","GET",{}));
  assert.equal(badAuth.statusCode,401);
  const inspect=await run(request("/review/api/erasure-recoveries/op-1","GET",headers));
  assert.equal(inspect.statusCode,200);assert.equal(JSON.parse(inspect.body).preview.allowed,true);
  const issued=await run(request("/review/api/erasure-recoveries/op-1/confirm","POST",headers,{}));
  assert.equal(issued.statusCode,200);assert.equal(JSON.parse(issued.body).confirmationId,"fresh-recovery");
  const invalid=await run(request("/review/api/erasure-recoveries/op-1/apply","POST",headers,{
    confirmationId:"fresh-recovery",operationId:"op-1",phrase:"FORCE UNLOCK",profile:"work"}));
  assert.equal(invalid.statusCode,400);
  const mismatch=await run(request("/review/api/erasure-recoveries/op-1/apply","POST",headers,{
    confirmationId:"fresh-recovery",operationId:"op-1",phrase:"RESTORE SYNC",profile:"home"}));
  assert.equal(mismatch.statusCode,409);
  assert.equal(calls.filter(x=>x[0]==="apply").length,0);
  const applied=await run(request("/review/api/erasure-recoveries/op-1/apply","POST",headers,{
    confirmationId:"fresh-recovery",operationId:"op-1",phrase:"RESTORE SYNC",profile:"work"}));
  assert.equal(applied.statusCode,202);assert.deepEqual(messages,["op-1"]);
  assert.deepEqual(calls.find(x=>x[0]==="apply"),["apply","op-1","fresh-recovery","operator-recovery"]);
  const status=await run(request("/review/api/erasure-recoveries/op-1/status","GET",headers));
  assert.equal(JSON.parse(status.body).recovery.status,"queued");
  const dispatch=await run(request("/review/api/erasure-recoveries/op-1/dispatch","POST",headers,{}));
  assert.equal(dispatch.statusCode,202);assert.deepEqual(messages,["op-1","op-1"]);
  const wrongOrigin=await run(request("/review/api/erasure-recoveries/op-1/apply","POST",
    {"cf-access-jwt-assertion":jwt},{confirmationId:"fresh-recovery",operationId:"op-1",phrase:"RESTORE SYNC",profile:"work"}));
  assert.equal(wrongOrigin.statusCode,403);
});
