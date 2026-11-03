import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {planHistoricalVersionRetirement} from "../scripts/plan-erasure-lambda-versions.mjs";

const BASE="todoist-calendar-sync-ingress-production";
const SHA="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr==";
function version(q) {
  return {qualifier:q,codeSha256:SHA,lastModified:"2026-11-03T00:00:00Z"};
}
function inventory() {
  return {
    purpose:"issue-307-read-only-qualified-lambda-inventory",
    status:"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT",
    replayBarrierMayBeEnabled:false,
    executableRecoveryMayBeEnabled:false,
    expectedFunctions:[BASE],
    missingExpected:[],
    functions:[{
      name:BASE,
      versions:[version("$LATEST"),version("2"),version("3"),version("4")],
      aliases:[{name:"live",version:"4",additionalVersions:{}}],
      eventSourceMappings:[{qualifier:"live",state:"Enabled",sourceService:"sqs"}],
      policies:{
        unqualified:{statementCount:1,wildcardPrincipalPresent:true},
        "2":{statementCount:0,wildcardPrincipalPresent:false},
        "3":{statementCount:0,wildcardPrincipalPresent:false},
        "4":{statementCount:0,wildcardPrincipalPresent:false},
        live:{statementCount:1,wildcardPrincipalPresent:true},
      },
      urls:{unqualified:{authType:"NONE"},live:{authType:"NONE"}},
      approvedForReplayRelease:false,
    }],
  };
}

test("published versions are classified for human review only, never as safe deletion",()=>{
  const plan=planHistoricalVersionRetirement(inventory());
  assert.equal(plan.status,"REVIEW_ONLY_NEVER_EXECUTE");
  assert.equal(plan.action,"NO_LAMBDA_DELETIONS_OR_POLICY_CHANGES");
  assert.equal(plan.replayBarrierMayBeEnabled,false);
  assert.equal(plan.executableRecoveryMayBeEnabled,false);
  assert.equal(plan.totalPublishedVersions,3);
  assert.equal(plan.totalReviewCandidates,2);
  const f=plan.functions[0];
  assert.deepEqual(f.reviewCandidates.map(v=>v.version),["2","3"]);
  assert.ok(f.reviewCandidates.every(v=>v.safeToDelete===false&&v.directInvocationAndCodeDeployUnverified));
  assert.deepEqual(f.retained.map(v=>v.version),["4"]);
});

test("weighted alias, direct qualifier mapping and resource policy each protect historical versions",()=>{
  const x=inventory();
  x.functions[0].aliases[0].additionalVersions={"3":0.2};
  x.functions[0].policies["2"].statementCount=1;
  const p=planHistoricalVersionRetirement(x);
  assert.equal(p.totalReviewCandidates,0);
  assert.deepEqual(p.functions[0].retained.map(v=>v.version),["2","3","4"]);
  assert.ok(p.functions[0].retained.find(v=>v.version==="2").reasons.includes("version-resource-policy"));
  assert.ok(p.functions[0].retained.find(v=>v.version==="3").reasons.includes("weighted-alias:live"));
  x.functions[0].aliases[0].additionalVersions={};
  x.functions[0].policies["2"].statementCount=0;
  x.functions[0].eventSourceMappings=[{qualifier:"2",state:"Disabled",sourceService:"sqs"}];
  assert.ok(planHistoricalVersionRetirement(x).functions[0].retained.find(v=>v.version==="2")
    .reasons.includes("event-source:Disabled"));
});

test("stale, truncated or inconsistent inventories abort rather than approving erasure",()=>{
  for(const mutate of [
    x=>{x.missingExpected=["missing"];},
    x=>{x.functions[0].versions[1].codeSha256="";},
    x=>{delete x.functions[0].policies["2"];},
    x=>{x.functions[0].versions.push(version("2"));},
    x=>{x.functions[0].aliases[0].version="999";},
    x=>{x.functions[0].aliases[0].additionalVersions={"999":0.1};},
    x=>{x.functions[0].eventSourceMappings[0].qualifier="unknown";},
    x=>{delete x.functions[0].urls.live;},
    x=>{x.functions[0].approvedForReplayRelease=true;},
    x=>{x.functions[0].policies["2"].statementCount=-1;},
    x=>{x.status="AUDIT_APPROVED";},
    x=>{x.replayBarrierMayBeEnabled=true;},
    x=>{x.expectedFunctions=["different"];},
  ]) {
    const x=inventory();mutate(x);
    assert.throws(()=>planHistoricalVersionRetirement(x));
  }
});

test("historical retirement planning uses no AWS clients, deletions or HTTP",()=>{
  const script=readFileSync(new URL("../scripts/plan-erasure-lambda-versions.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(script,/from ["']@aws-sdk\//);
  assert.doesNotMatch(script,/fetch\s*\(/);
  assert.doesNotMatch(script,/DeleteFunctionCommand|UpdateAliasCommand|PutRolePolicyCommand/);
});
