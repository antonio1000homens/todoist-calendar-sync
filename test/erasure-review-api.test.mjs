import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { SQSClient } from "@aws-sdk/client-sqs";
import { ErasureOperationStore } from "../dist/erasure-executor.js";
import { handler } from "../dist/review-api.js";

const issuer = "https://erasure-review.cloudflareaccess.com";
const audience = "erasure-review-test";
function event(path, method, headers = {}, body) {
  return { rawPath:path, headers, body:body === undefined ? undefined : JSON.stringify(body), isBase64Encoded:false,
    requestContext:{http:{method}}, queryStringParameters:{} };
}

test("authenticated review API starts only stored confirmed operations and returns limited status", async t => {
  const old = { fetch:globalThis.fetch, issuer:process.env.CF_ACCESS_ISSUER, audience:process.env.CF_ACCESS_AUDIENCE,
    operators:process.env.REVIEW_OPERATOR_EMAILS, queue:process.env.ERASURE_OPERATION_QUEUE_URL };
  const {privateKey,publicKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey);Object.assign(jwk,{kid:"erasure-key",alg:"RS256",use:"sig"});
  globalThis.fetch=async input=>String(input).startsWith(`${issuer}/cdn-cgi/access/certs`)
    ?new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{"content-type":"application/json"}}):new Response("unexpected",{status:500});
  Object.assign(process.env,{CF_ACCESS_ISSUER:issuer,CF_ACCESS_AUDIENCE:audience,REVIEW_OPERATOR_EMAILS:"operator@example.test",
    ERASURE_OPERATION_QUEUE_URL:"https://sqs.example/erasure"});
  const sent=[],transitions=[];
  const operation={operationId:"op-113",status:"previewed",providerDeletionReady:true,previewFingerprint:"secret-digest",confirmationId:"secret-confirmation",
    inventory:[{type:"TASK",key:{pk:"secret-key",sk:"META"},digest:"secret-row"}],createdAt:"2026-10-23T10:00:00.000Z",updatedAt:"2026-10-23T10:00:00.000Z"};
  t.mock.method(ErasureOperationStore.prototype,"get",async id=>id===operation.operationId?operation:undefined);
  t.mock.method(ErasureOperationStore.prototype,"transition",async(...args)=>{transitions.push(args);operation.status="queued";});
  t.mock.method(SQSClient.prototype,"send",async command=>{sent.push(command.input);return {};});
  const jwt=await new SignJWT({email:"operator@example.test"}).setProtectedHeader({alg:"RS256",kid:"erasure-key"})
    .setIssuer(issuer).setAudience(audience).setSubject("operator-1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const headers={origin:"https://calendar-sync.alf-broadcast.co.uk","cf-access-jwt-assertion":jwt};
  t.after(()=>{
    globalThis.fetch=old.fetch;
    for(const [key,value] of Object.entries({CF_ACCESS_ISSUER:old.issuer,CF_ACCESS_AUDIENCE:old.audience,
      REVIEW_OPERATOR_EMAILS:old.operators,ERASURE_OPERATION_QUEUE_URL:old.queue})) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  });

  const denied=await handler(event("/review/api/erasure-operations/op-113/start","POST",headers,{confirmationId:"attacker"}));
  assert.equal(denied.statusCode,400);
  const started=await handler(event("/review/api/erasure-operations/op-113/start","POST",headers,{}));
  assert.equal(started.statusCode,202);
  assert.deepEqual(transitions,[["op-113","previewed","queued"]]);
  assert.deepEqual(JSON.parse(sent[0].MessageBody),{version:1,operationId:"op-113"});
  const retried=await handler(event("/review/api/erasure-operations/op-113/start","POST",headers,{}));
  assert.equal(retried.statusCode,202);assert.equal(sent.length,2,"retries redispatch the same durable operation id");

  const status=await handler(event("/review/api/erasure-operations/op-113","GET",{"cf-access-jwt-assertion":jwt}));
  const body=JSON.parse(status.body);
  assert.equal(status.statusCode,200);assert.equal(body.operation.status,"queued");
  assert.equal("inventory" in body.operation,false);assert.equal("confirmationId" in body.operation,false);

  operation.status="review_required";
  operation.lifecycle={phase:"ready_for_delete",nextRunAt:Date.now()};
  const reviewStatus=await handler(event("/review/api/erasure-operations/op-113","GET",{"cf-access-jwt-assertion":jwt}));
  const reviewBody=JSON.parse(reviewStatus.body);
  assert.equal(reviewStatus.statusCode,200);
  assert.equal(reviewBody.operation.status,"review_required");
  assert.equal(reviewBody.operation.operatorRecoveryRequired,true);
  assert.match(reviewBody.operation.message,/break-glass recovery is required/);
  assert.match(reviewBody.operation.message,/preserve any protections that remain/i);
  assert.match(reviewBody.operation.message,/inspect the actual profile fence and worker mapping state/i);
  assert.match(reviewBody.operation.message,/escalate if either is missing, changed, or cannot be verified/i);
  assert.doesNotMatch(reviewBody.operation.message,/keep the profile fence and worker mappings in place/i);
  assert.match(reviewBody.operation.message,/do not start a fresh preview until service admission is restored/i);
  const resume=await handler(event("/review/api/erasure-operations/op-113/start","POST",headers,{}));
  assert.equal(resume.statusCode,409);
  assert.match(JSON.parse(resume.body).error,/break-glass recovery is required/);
  assert.equal(sent.length,2,"review-required operations cannot requeue the stale confirmation");
});
