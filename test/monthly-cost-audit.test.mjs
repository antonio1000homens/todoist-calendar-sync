import test from "node:test";
import assert from "node:assert/strict";
import {
  monthWindow, previousUtcMonth, budgetAudit, provisionedTotals,
  monthlyCostGroups, s3CostSummary, runAudit,
} from "../scripts/monthly-cost-audit.mjs";

test("billing month windows handle December to January and leap years without relying on local timezone",()=>{
  assert.deepEqual(monthWindow("2026-12"),{Start:"2026-12-01",End:"2027-01-01"});
  assert.deepEqual(monthWindow("2024-02"),{Start:"2024-02-01",End:"2024-03-01"});
  assert.equal(previousUtcMonth(new Date("2026-11-01T00:00:00Z")),"2026-10");
  assert.equal(previousUtcMonth(new Date("2026-01-01T00:00:00Z")),"2025-12");
  assert.throws(()=>monthWindow("2026-13"),/YYYY-MM/);
});

const stack={
  Parameters:[
    {ParameterKey:"BillingAlarmEmail",ParameterValue:""},
    {ParameterKey:"MonthlyBillingLimitUsd",ParameterValue:"5"},
    {ParameterKey:"ResourceNamePrefix",ParameterValue:"todoist-calendar-sync"},
  ],
  Outputs:[
    {OutputKey:"StateTableName",OutputValue:"state-production"},
    {OutputKey:"QueueUrl",OutputValue:"https://example.test/source.fifo"},
    {OutputKey:"DlqUrl",OutputValue:"https://example.test/dlq.fifo"},
  ],
};
const stackResources={StackResources:[{LogicalResourceId:"SyncState",ResourceType:"AWS::DynamoDB::Table",ResourceStatus:"UPDATE_COMPLETE"}]};
const budgets={Budgets:[{BudgetName:"Unrelated budget",BudgetLimit:{Amount:"25",Unit:"GB-Month"}}]};
const table={Table:{
  TableName:"state-production",TableStatus:"ACTIVE",DeletionProtectionEnabled:true,
  ProvisionedThroughput:{ReadCapacityUnits:25,WriteCapacityUnits:25},
  GlobalSecondaryIndexes:[{IndexName:"ProfileLookupIndex",IndexStatus:"ACTIVE",
    ProvisionedThroughput:{ReadCapacityUnits:5,WriteCapacityUnits:5}}],
}};

test("missing conditional budget is reported rather than silently creating a duplicate",()=>{
  const result=budgetAudit(stack,stackResources,budgets);
  assert.equal(result.budgetResourceDeployed,false);
  assert.equal(result.emailConfigured,false);
  assert.equal(result.budgetFoundInAccount,false);
  assert.equal(result.configuredLimitUsd,"5");
  assert.match(result.findings.join(" "),/BillingAlarmEmail blank/);
  assert.deepEqual(provisionedTotals({Table:table.Table}).total,{rcu:30,wcu:30});
});

test("active budget shows threshold and never emits the subscriber email value",()=>{
  const enabledStack={...stack,Parameters:stack.Parameters.map(x=>x.ParameterKey==="BillingAlarmEmail"
    ?{...x,ParameterValue:"email-not-for-logs@example.test"}:x)};
  const budget={BudgetName:"todoist-calendar-sync-monthly-cost-production",
    BudgetLimit:{Amount:"5.0",Unit:"USD"}};
  const value=budgetAudit(enabledStack,{StackResources:[...stackResources.StackResources,
    {LogicalResourceId:"MonthlyCostBudget",ResourceType:"AWS::Budgets::Budget",ResourceStatus:"CREATE_COMPLETE"}]},
    {Budgets:[budget]});
  assert.equal(value.emailConfigured,true);
  assert.equal(value.budgetFoundInAccount,true);
  assert.equal(value.actualBudgetLimitUsd,"5.0");
  assert.ok(!JSON.stringify(value).includes("email-not-for-logs"));
});

test("Cost Explorer results are account-wide, sorted, and never turned into bucket ownership evidence",()=>{
 const response={ResultsByTime:[{Groups:[
   {Keys:["EUW2-Requests-Tier1","PutObject"],Metrics:{UnblendedCost:{Amount:"0.478537"}}},
   {Keys:["EUW2-TimedStorage-ByteHrs","StandardStorage"],Metrics:{UnblendedCost:{Amount:"0.063435"}}},
   {Keys:["EUW2-Requests-Tier2","GetObject"],Metrics:{UnblendedCost:{Amount:"0.035484"}}},
 ]}]};
 const rows=monthlyCostGroups(response);
 assert.equal(rows[0].keys[1],"PutObject");
 const s3=s3CostSummary(response);
 assert.equal(s3.accountWide,true);
 assert.ok(s3.estimatedUnblendedUsd>0.57);
 assert.match(s3.bucketAttribution,/unknown/);
 assert.equal(s3.topByUsageAndOperation[0].operation,"PutObject");
});

function fakeAwsCalls(){
 const calls=[];
 function call(service,operation,args){
  calls.push({service,operation,args});
  if(service==="cloudformation"&&operation==="describe-stacks")return {Stacks:[stack]};
  if(service==="cloudformation"&&operation==="describe-stack-resources")return stackResources;
  if(service==="sts")return {Account:"123456789012"};
  if(service==="budgets"&&operation==="describe-budgets")return budgets;
  if(service==="dynamodb"&&operation==="describe-table")return table;
  if(service==="dynamodb"&&operation==="describe-continuous-backups")return {ContinuousBackupsDescription:{
    PointInTimeRecoveryDescription:{PointInTimeRecoveryStatus:"ENABLED"}}};
  if(service==="sqs"&&operation==="get-queue-attributes")return {Attributes:{
    ApproximateNumberOfMessages:"0",ApproximateNumberOfMessagesNotVisible:"0",
    MessageRetentionPeriod:args.includes("https://example.test/dlq.fifo")?"1209600":"345600",
  }};
  if(service==="ce"&&operation==="get-cost-and-usage"){
    return {ResultsByTime:[{Groups:[]}]};
  }
  throw new Error(`unexpected AWS API ${service}.${operation}`);
 }
 return {calls,call};
}

test("default audit is read-only and makes ZERO billable Cost Explorer calls",()=>{
  const f=fakeAwsCalls();
  const result=runAudit({month:"2026-10",call:f.call});
  assert.deepEqual(result.dynamodb.total,{rcu:30,wcu:30});
  assert.equal(result.dynamodb.pitrStatus,"ENABLED");
  assert.equal(result.budget.emailConfigured,false);
  assert.equal(result.queues.find(x=>x.name==="dlq").retentionSeconds,1209600);
  assert.equal(result.paidCostExplorerQueries,0);
  assert.equal(f.calls.filter(x=>x.service==="ce").length,0);
  assert.equal(f.calls.some(x=>/^(delete|update|put|create|send|start|stop)/.test(x.operation)),false);
});

test("paid Cost Explorer opt-in makes exactly TWO monthly requests with no account-resource attribution",()=>{
  const f=fakeAwsCalls();
  const result=runAudit({month:"2026-10",includeCostExplorer:true,call:f.call});
  assert.equal(result.paidCostExplorerQueries,2);
  const q=f.calls.filter(x=>x.service==="ce");
  assert.equal(q.length,2);
  assert.deepEqual(q.map(x=>x.operation),["get-cost-and-usage","get-cost-and-usage"]);
  assert.equal(result.costs.billingWindow.Start,"2026-10-01");
  assert.equal(result.costs.s3.accountWide,true);
});
