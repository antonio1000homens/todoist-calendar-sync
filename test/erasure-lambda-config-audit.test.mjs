import assert from "node:assert/strict";
import test from "node:test";
import {collectRuntimeConfigAudit} from "../scripts/audit-erasure-lambda-config.mjs";

test("Lambda config audit reads every published version and alias target but omits environment values",async()=>{
  const sha1="a".repeat(44),sha2="b".repeat(44),seen=[];
  const client={async send(command){
    seen.push(command.constructor.name+":"+(command.input.Qualifier||command.input.FunctionName));
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[
      {Version:"$LATEST",CodeSha256:sha2},{Version:"1",CodeSha256:sha1},{Version:"2",CodeSha256:sha2},
    ]};
    if(command.constructor.name==="ListAliasesCommand")return {Aliases:[
      {Name:"live",FunctionVersion:"2",RoutingConfig:{AdditionalVersionWeights:{"1":0.25}}},
    ]};
    if(command.constructor.name==="GetFunctionConfigurationCommand") {
      const version=command.input.Qualifier;
      const codeSha256=version==="1"?sha1:sha2;
      return {FunctionName:command.input.FunctionName,Version:version,CodeSha256:codeSha256,
        Environment:{Variables:{ERASURE_REPLAY_BARRIER_VERSION:version==="2"?"1":"0",
          ERASURE_EXECUTION_ENABLED:version==="1"?"true":"false",TODOIST_API_TOKEN:"private-token"}}};
    }
    throw new Error("Unexpected AWS command");
  }};
  const report=await collectRuntimeConfigAudit(client,{functionNames:["todoist-calendar-sync-review-api-production"],region:"eu-west-2"});
  const fn=report.functions[0];
  assert.equal(fn.versionCount,3);assert.equal(fn.publishedVersionCount,2);
  assert.deepEqual(fn.aliases,[{name:"live",version:"2",revisionId:null,weightedTargets:{"1":0.25}}]);
  assert.deepEqual(fn.configs.map(item=>item.version),["1","2","$LATEST"]);
  assert.equal(fn.replayBarrierEnabledCount,1);assert.equal(fn.replayBarrierPresentCount,3);
  assert.ok(fn.configs.every(item=>item.postwriteReview==="absent"));
  assert.equal(fn.erasureExecutionEnabledCount,1);
  assert.equal(report.replayBarrierMayBeEnabled,false);
  assert.equal(report.executableRecoveryMayBeEnabled,false);
  assert.equal(JSON.stringify(report).includes("private-token"),false);
  assert.equal(seen.filter(value=>value.startsWith("GetFunctionConfigurationCommand:")).length,4);
});

test("Lambda config audit fails closed on pagination loops and alias targets missing from the version inventory",async()=>{
  const loop={async send(command){
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[{Version:"$LATEST",CodeSha256:"a"}],NextMarker:"same"};
    throw new Error("Unexpected AWS command");
  }};
  await assert.rejects(collectRuntimeConfigAudit(loop,{functionNames:["sync-worker"],region:"eu-west-2"}),/Repeated or invalid/);
  const badAlias={async send(command){
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[{Version:"$LATEST",CodeSha256:"a"}]};
    if(command.constructor.name==="ListAliasesCommand")return {Aliases:[{Name:"live",FunctionVersion:"77"}]};
    throw new Error("Unexpected AWS command");
  }};
  await assert.rejects(collectRuntimeConfigAudit(badAlias,{functionNames:["sync-worker"],region:"eu-west-2"}),/Alias target is absent/);
});

test("Lambda config audit fails closed when $LATEST environment flags change during the read",async()=>{
  let latestReads=0;
  const client={async send(command){
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[{Version:"$LATEST",CodeSha256:"a"}]};
    if(command.constructor.name==="ListAliasesCommand")return {Aliases:[]};
    if(command.constructor.name==="GetFunctionConfigurationCommand") {
      const latest=command.input.Qualifier==="$LATEST";
      if(latest&&++latestReads===2)return {FunctionName:"sync-worker",Version:"$LATEST",CodeSha256:"a",
        Environment:{Variables:{ERASURE_REPLAY_BARRIER_VERSION:"1"}}};
      return {FunctionName:"sync-worker",Version:"$LATEST",CodeSha256:"a",Environment:{Variables:{}}};
    }
    throw new Error("Unexpected AWS command");
  }};
  await assert.rejects(collectRuntimeConfigAudit(client,{functionNames:["sync-worker"],region:"eu-west-2"}),/\$LATEST configuration changed/);
});

test("Lambda config audit backs off and retries transient AWS read throttling",async()=>{
  let latestReads=0;const delays=[];
  const client={async send(command){
    if(command.constructor.name==="ListVersionsByFunctionCommand")return {Versions:[{Version:"$LATEST",CodeSha256:"a"}]};
    if(command.constructor.name==="ListAliasesCommand")return {Aliases:[]};
    if(command.constructor.name==="GetFunctionConfigurationCommand") {
      if(command.input.Qualifier==="$LATEST"&&latestReads++===0)
        throw Object.assign(new Error("rate exceeded"),{name:"TooManyRequestsException",$metadata:{httpStatusCode:429}});
      return {FunctionName:"sync-worker",Version:"$LATEST",CodeSha256:"a",Environment:{Variables:{}}};
    }
    throw new Error("Unexpected AWS command");
  }};
  const report=await collectRuntimeConfigAudit(client,{functionNames:["sync-worker"],region:"eu-west-2",sleep:async ms=>delays.push(ms)});
  assert.equal(report.functions[0].versionCount,1);
  assert.deepEqual(delays,[250]);
});
