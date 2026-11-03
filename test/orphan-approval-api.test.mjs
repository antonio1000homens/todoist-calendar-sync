import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { handler } from "../dist/review-api.js";

function request(path,method="GET",headers={},body){
  const parsed=new URL(path,"https://calendar-sync.alf-broadcast.co.uk");
  return {rawPath:parsed.pathname,headers,body:body===undefined?undefined:JSON.stringify(body),
    isBase64Encoded:false,queryStringParameters:Object.fromEntries(parsed.searchParams),
    requestContext:{http:{method}}};
}
const decoded=async promise=>{
  const result=await promise;return {status:result.statusCode,body:JSON.parse(result.body)};
};
test("case-scoped orphan API routes preserve JWT, same-origin, exact body, admission and default-deny confirmation",async t=>{
  const issuer="https://orphan-approval-test.cloudflareaccess.com";
  const original={fetch:globalThis.fetch,issuer:process.env.CF_ACCESS_ISSUER,
    audience:process.env.CF_ACCESS_AUDIENCE,operators:process.env.REVIEW_OPERATOR_EMAILS,
    protocol:process.env.ERASURE_PROTOCOL_VERSION,enabled:process.env.ORPHAN_APPROVAL_CONFIRMATION_ENABLED};
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);
  Object.assign(jwk,{kid:"orphan-approval-287",use:"sig",alg:"RS256"});
  globalThis.fetch=async input=>String(input).startsWith(issuer+"/cdn-cgi/access/certs")
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{"content-type":"application/json"}})
    :new Response("unexpected",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:"orphan-review-aud",
    REVIEW_OPERATOR_EMAILS:"owner@example.test",ERASURE_PROTOCOL_VERSION:"1"});
  delete process.env.ORPHAN_APPROVAL_CONFIRMATION_ENABLED;
  t.after(()=>{
    globalThis.fetch=original.fetch;
    for(const [name,value] of Object.entries({
      CF_ACCESS_ISSUER:original.issuer,CF_ACCESS_AUDIENCE:original.audience,
      REVIEW_OPERATOR_EMAILS:original.operators,ERASURE_PROTOCOL_VERSION:original.protocol,
      ORPHAN_APPROVAL_CONFIRMATION_ENABLED:original.enabled,
    }))if(value===undefined)delete process.env[name];else process.env[name]=value;
  });
  const now=Math.floor(Date.now()/1000);
  const jwt=await new SignJWT({email:"owner@example.test"})
    .setProtectedHeader({alg:"RS256",kid:"orphan-approval-287"})
    .setIssuer(issuer).setAudience("orphan-review-aud").setSubject("reviewer-287")
    .setIssuedAt(now).setExpirationTime(now+300).sign(privateKey);
  const headers={"cf-access-jwt-assertion":jwt,origin:"https://calendar-sync.alf-broadcast.co.uk"};
  const item={id:"alert-287",profile:"home",status:"open",title:"Orphan",reason:"unmapped_task",
    taskId:"task-287",createdAt:"2026-11-03T19:00:00Z",updatedAt:"2026-11-03T19:01:00Z"};
  const calls={preview:0,confirm:0,status:0,leases:0,released:0};
  const approval={
    async issue(caseId,side,id,actor) {
      assert.equal(calls.leases-calls.released,1,"all write requests require held admission lease");
      calls.preview++;
      assert.equal(caseId,"alert-287");assert.equal(side,"todoist");assert.equal(id,"task-287");
      assert.equal(actor.subject,"reviewer-287");
      return {previewId:"preview",caseId,side,targetId:id,executionQueued:false};
    },
    async confirm(caseId,payload,actor) {
      assert.equal(calls.leases-calls.released,1);
      calls.confirm++;
      assert.deepEqual({caseId,payload,actorSubject:actor.subject},{
        caseId:"alert-287",payload:{previewId:"preview",confirmationId:"nonce",
          exactId:"task-287",phrase:"PERMANENTLY ERASE"},actorSubject:"reviewer-287"});
      return {operationId:"operation-287",status:"confirmed_not_dispatched",executionQueued:false};
    },
    async status(caseId,id,actor){
      calls.status++;
      assert.equal(caseId,"alert-287");assert.equal(id,"operation-287");
      assert.equal(actor.subject,"reviewer-287");
      return {id,caseId,phase:"confirmed",actorSubject:actor.subject};
    },
  };
  const deps={
    createReviewStore:()=>({getCase:async id=>id===item.id?item:undefined}),
    createReviewEngine:()=>({}),
    createOrphanApprovalService:()=>approval,
    acquireWriteLease:async()=>{calls.leases++;return async()=>{calls.released++;}},
  };
  const p="/review/api/cases/alert-287/orphan-previews";
  const c="/review/api/cases/alert-287/orphan-confirmations";
  const expected={side:"todoist",id:"task-287"};
  const pre=await decoded(handler(request(p,"POST",headers,expected),deps));
  assert.equal(pre.status,200);assert.equal(pre.body.preview.executionQueued,false);
  assert.equal(calls.preview,1);
  const extra=await decoded(handler(request(p,"POST",headers,{...expected,profile:"work"}),deps));
  assert.equal(extra.status,400);assert.equal(calls.preview,1);
  const query=await decoded(handler(request(p+"?id=foreign","POST",headers,expected),deps));
  assert.equal(query.status,400);
  const foreign=await decoded(handler(request(p,"POST",{...headers,origin:"https://evil.example"},expected),deps));
  assert.equal(foreign.status,403);assert.equal(calls.preview,1);
  const noAuth=await decoded(handler(request(p,"POST",{origin:headers.origin},expected),deps));
  assert.equal(noAuth.status,401);
  const data={previewId:"preview",confirmationId:"nonce",exactId:"task-287",phrase:"PERMANENTLY ERASE"};
  const gated=await decoded(handler(request(c,"POST",headers,data),deps));
  assert.equal(gated.status,409);
  assert.equal(calls.confirm,0,"no operation can be created by default");
  process.env.ORPHAN_APPROVAL_CONFIRMATION_ENABLED="true";
  const confirmed=await decoded(handler(request(c,"POST",headers,data),deps));
  assert.equal(confirmed.status,201);
  assert.equal(confirmed.body.operation.executionQueued,false,"no queue handoff after confirmation");
  assert.equal(calls.confirm,1);
  const badBody=await decoded(handler(request(c,"POST",headers,{...data,profile:"home"}),deps));
  assert.equal(badBody.status,400);assert.equal(calls.confirm,1);
  const status=await decoded(handler(request("/review/api/cases/alert-287/orphan-operations/operation-287",
    "GET",{"cf-access-jwt-assertion":jwt}),deps));
  assert.equal(status.status,200);assert.equal(status.body.operation.phase,"confirmed");
  assert.equal(calls.status,1);
  const badStatus=await decoded(handler(request("/review/api/cases/alert-287/orphan-operations/operation-287?profile=work",
    "GET",{"cf-access-jwt-assertion":jwt}),deps));
  assert.equal(badStatus.status,400);assert.equal(calls.status,1);
  assert.equal(calls.leases,calls.released,"all mutation admission leases are released");
});
