import test from "node:test";
import assert from "node:assert/strict";
import {QueryCommand} from "@aws-sdk/lib-dynamodb";
import {ListAliasesCommand,GetFunctionConfigurationCommand} from "@aws-sdk/client-lambda";
import {auditLegacyHmacCurrentRuntime} from "../scripts/audit-legacy-hmac-retirement.mjs";

function fixture({markerProfile,env={ERASURE_PROTOCOL_VERSION:"1"},aliases=[],configOverrides={},invalidMarkerPage}={}) {
  const requests={markers:[],functions:[],aliases:[]};
  const db={async send(command) {
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.TableName,"test-state");
    assert.equal(command.input.KeyConditionExpression,"pk = :partition");
    assert.equal(command.input.ConsistentRead,true);
    assert.equal(command.input.Select,"COUNT");
    assert.equal(command.input.Limit,1);
    const pk=command.input.ExpressionAttributeValues[":partition"];
    requests.markers.push(pk);
    return {Count:pk===`ERASURE_REPLAY#${markerProfile}`?1:0,
      ...(invalidMarkerPage&&pk==="ERASURE_REPLAY#home"?{LastEvaluatedKey:{pk:"unexpected"}}:{})};
  }};
  const lambda={async send(command) {
    if(command instanceof ListAliasesCommand) {
      requests.aliases.push(command.input);
      return {Aliases:aliases};
    }
    assert.ok(command instanceof GetFunctionConfigurationCommand);
    requests.functions.push(command.input);
    const qualifier=command.input.Qualifier;
    return {FunctionName:command.input.FunctionName,Version:qualifier?(qualifier==="live"?"2":qualifier):"$LATEST",
      Environment:{Variables:env},...configOverrides};
  }};
  return {db,lambda,tableName:"test-state",
    functions:[{logicalId:"WorkerFunction",name:"test-worker"}],requests};
}

test("clean current runtime inspects all three exact partitions and the Lambda without writes",async()=>{
  const f=fixture();
  const report=await auditLegacyHmacCurrentRuntime(f);
  assert.equal(report.status,"CURRENT_RUNTIME_HMAC_INACTIVE");
  assert.equal(report.currentRuntimeClean,true);
  assert.equal(report.retirementApproved,false,"a live check never approves historical invocation safety");
  assert.equal(report.historicalVersionsAndIAMVerified,false);
  assert.equal(report.awsMutations,0);
  assert.deepEqual(f.requests.markers.sort(),
    ["ERASURE_REPLAY#home","ERASURE_REPLAY#antonio","ERASURE_REPLAY#work"].sort());
  assert.equal(f.requests.functions.length,1);
  assert.equal(f.requests.aliases.length,1);
});

test("any legacy DynamoDB marker blocks retirement without exposing marker identity",async()=>{
  const f=fixture({markerProfile:"antonio"});
  const report=await auditLegacyHmacCurrentRuntime(f);
  assert.equal(report.status,"BLOCKED_LEGACY_HMAC_PRESENT");
  assert.equal(report.currentRuntimeClean,false);
  assert.deepEqual(report.partitions.filter(p=>p.legacyMarkerPresent).map(p=>p.profile),["antonio"]);
  assert.doesNotMatch(JSON.stringify(report),/task-id|event-id/);
});

test("legacy HMAC settings on an alias or weighted target block current-runtime retirement",async()=>{
  const f=fixture({aliases:[{
    Name:"live",FunctionVersion:"2",
    RoutingConfig:{AdditionalVersionWeights:{"1":0.1}},
  }]});
  const send=f.lambda.send;
  f.lambda.send=async command=>{
    if(command instanceof GetFunctionConfigurationCommand&&command.input.Qualifier==="1")
      return {FunctionName:"test-worker",Version:"1",
        Environment:{Variables:{ERASURE_PROTOCOL_VERSION:"1",ERASURE_REPLAY_BARRIER_VERSION:"0",
          ERASURE_REPLAY_HMAC_KEYS:"NEVER_INCLUDE_KEY_CONTENT"}}};
    return send(command);
  };
  const report=await auditLegacyHmacCurrentRuntime(f);
  assert.equal(report.status,"BLOCKED_LEGACY_HMAC_PRESENT");
  assert.equal(report.lambdaFunctions[0].configurations.length,3);
  assert.equal(report.lambdaFunctions[0].configurations.find(c=>c.qualifier==="1").legacyHmacSettingsPresent,true);
  assert.doesNotMatch(JSON.stringify(report),/NEVER_INCLUDE_KEY_CONTENT/);
});

test("inconclusive marker read fails closed rather than reporting zero markers",async()=>{
  const f=fixture({invalidMarkerPage:true});
  await assert.rejects(auditLegacyHmacCurrentRuntime(f),/not conclusively empty/);
});

test("incomplete Lambda config fails closed without interpreting it as unconfigured",async()=>{
  const f=fixture({configOverrides:{Environment:{Error:{ErrorCode:"AccessDeniedException"}}}});
  await assert.rejects(auditLegacyHmacCurrentRuntime(f),/cannot be inspected/);
});

test("inventory refuses missing stack metadata and duplicate Lambda resources",async()=>{
  const f=fixture();
  await assert.rejects(auditLegacyHmacCurrentRuntime({...f,tableName:""}),/complete CloudFormation/);
  await assert.rejects(auditLegacyHmacCurrentRuntime({...f,
    functions:[f.functions[0],f.functions[0]]}),/complete CloudFormation/);
});
