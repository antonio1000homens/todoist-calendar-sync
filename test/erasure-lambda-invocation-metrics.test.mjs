import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildInvocationMetricQueries,collectMetricEvidence} from "../scripts/audit-erasure-lambda-invocation-metrics.mjs";

const accountId="123456789012";
const inventory={purpose:"issue-307-read-only-qualified-lambda-inventory",
  status:"BLOCKED_PENDING_INDEPENDENT_WRITER_AND_IAM_AUDIT",verifiedAccount:accountId,region:"eu-west-2",
  expectedFunctions:["sync-api"],missingExpected:[],functions:[{name:"sync-api",
    versions:[{qualifier:"$LATEST"},{qualifier:"8"},{qualifier:"9"}],
    aliases:[{name:"live",version:"9",additionalVersions:{"8":0.1}}]}]};

test("metric query plan covers unqualified, every published qualifier, alias and alias-executed versions",()=>{
  const queries=buildInvocationMetricQueries(inventory,accountId,455);
  assert.equal(queries.length,6);
  assert.equal(new Set(queries.map(item=>item.query.Id)).size,queries.length);
  assert.equal(queries.filter(item=>item.kind==="published_version").length,2);
  assert.equal(queries.filter(item=>item.kind==="alias_executed_version").length,2);
  assert.deepEqual(queries.filter(item=>item.kind==="alias_executed_version").map(item=>item.query.MetricStat.Metric.Dimensions),[
    [{Name:"FunctionName",Value:"sync-api"},{Name:"Resource",Value:"sync-api:live"},{Name:"ExecutedVersion",Value:"8"}],
    [{Name:"FunctionName",Value:"sync-api"},{Name:"Resource",Value:"sync-api:live"},{Name:"ExecutedVersion",Value:"9"}],
  ]);
  assert.equal(queries.every(item=>item.query.MetricStat.Period===86400&&item.query.MetricStat.Stat==="Sum"),true);
});

test("metric collection paginates, aggregates datapoints and never calls a zero-data result proof",()=>{
  let calls=0;
  const report=collectMetricEvidence({profile:"windsor",accountId,inventory,days:455,
    now:new Date("2026-11-04T12:00:00.000Z"),run(_profile,args){
      calls++;
      const queryPath=args[args.indexOf("--metric-data-queries")+1].slice("file://".length);
      const queries=JSON.parse(readFileSync(queryPath,"utf8"));
      if(calls===1)return {MetricDataResults:[{Id:queries[0].Id,StatusCode:"PartialData",Values:[2],Timestamps:["2026-11-02T00:00:00Z"]}],NextToken:"next-page"};
      return {MetricDataResults:queries.map((query,index)=>({Id:query.Id,StatusCode:"Complete",
        Values:index===0?[3]:[],Timestamps:index===0?["2026-11-03T00:00:00Z"]:[]}))};
    }});
  assert.equal(calls,2);
  assert.equal(report.queryCount,6);
  assert.equal(report.incompleteQueryCount,0);
  assert.equal(report.results[0].recordedDatapoints,2);
  assert.equal(report.results[0].sumInvocations,5);
  assert.equal(report.results[0].statuses[0],"Complete");
  assert.equal(report.results[1].recordedDatapoints,0);
  assert.equal(report.results[1].sumInvocations,0);
  assert.match(report.limitations.find(item=>item.includes("missing data point")),/not proof/);
  assert.equal(report.status,"BLOCKED_METRIC_EVIDENCE_NOT_COMPLETE_AUDIT");
  assert.equal(report.replayBarrierMayBeEnabled,false);
});

test("mismatched accounts, invalid windows, incomplete snapshots and repeated tokens fail closed",()=>{
  assert.throws(()=>buildInvocationMetricQueries({...inventory,verifiedAccount:"999999999999"},accountId),/same-account/);
  assert.throws(()=>buildInvocationMetricQueries(inventory,accountId,456),/1 through 455/);
  assert.throws(()=>buildInvocationMetricQueries({...inventory,missingExpected:["sync-api"]},accountId),/same-account/);
  assert.throws(()=>collectMetricEvidence({profile:"windsor",accountId,inventory,run(){return {MetricDataResults:[],NextToken:"same"};}}),/Repeated CloudWatch metric pagination token/);
});
