import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { SQSClient } from "@aws-sdk/client-sqs";
import { handler } from "../dist/review-api.js";
import { ReviewStore } from "../dist/review-store.js";
import { ReviewEngine } from "../dist/review-engine.js";

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
async function token(privateKey, email = "review-owner@example.test", {aud = audience, expired = false} = {}) {
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({email})
    .setProtectedHeader({alg:"RS256",kid:"review-test-key"})
    .setIssuer(issuer).setAudience(aud).setSubject("access-user-123")
    .setIssuedAt(expired?now-120:now).setExpirationTime(expired?now-60:now+300).sign(privateKey);
}
async function jsonResponse(result) { return {status:result.statusCode, body:JSON.parse(result.body)}; }

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
  const caseUpdates=[];
  t.mock.method(ReviewStore.prototype,"updateCase",async(...args)=>{caseUpdates.push(args);});
  t.mock.method(ReviewEngine.prototype,"preview",async actor=>({...preview,actor}));
  t.mock.method(ReviewStore.prototype,"getPreview",async id=>id==="preview-1"?preview:undefined);
  t.mock.method(ReviewStore.prototype,"submit",async()=>operation);
  const queueCalls=[];
  t.mock.method(SQSClient.prototype,"send",async command=>{queueCalls.push(command);return {};});

  const inbox = await jsonResponse(await handler(event("/review/api/cases?profile=all","GET",headers)));
  assert.equal(inbox.status,200);
  assert.deepEqual(inbox.body.items.map(item=>item.id),["case-1"]);

  const previewResult = await jsonResponse(await handler(event("/review/api/cases/case-1/previews","POST",{
    ...headers,origin:"https://calendar-sync.alf-broadcast.co.uk",
  },{action:"exclude",winner:"none",scope:"occurrence",leftovers:{}})));
  assert.equal(previewResult.status,200);

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
});
