#!/usr/bin/env node
/**
 * Read-only cost/production verification for the Todoist Calendar sync stack.
 *
 * Default: STS, CloudFormation, Budgets, DynamoDB, SQS, CloudWatch describe
 * APIs only. No scans, writes, resource changes or recurring triggers.
 *
 * --include-cost-explorer intentionally triggers TWO billable Cost Explorer
 * GetCostAndUsage requests: (1) account-wide service costs and (2) Amazon
 * S3 usage type + operation. Never run this by schedule/CI automatically.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function monthWindow(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Expected --month YYYY-MM");
  const [year, m] = month.split("-").map(Number);
  const start = `${year}-${String(m).padStart(2,"0")}-01`;
  const next = new Date(Date.UTC(year, m, 1)).toISOString().slice(0,10);
  return {Start:start,End:next};
}

export function previousUtcMonth(now=new Date()) {
  const date=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1));
  return date.toISOString().slice(0,7);
}

export function monthlyCostGroups(response) {
  const rows = [];
  for (const period of response?.ResultsByTime || []) {
    for (const row of period.Groups || []) {
      const cost = Number(row.Metrics?.UnblendedCost?.Amount ?? 0);
      if (!Number.isFinite(cost)) continue;
      rows.push({ keys:row.Keys || [],usd:Number(cost.toFixed(6)) });
    }
  }
  return rows.sort((a,b)=>b.usd-a.usd);
}

export function s3CostSummary(response) {
  const items=monthlyCostGroups(response);
  return {
    accountWide:true,
    estimatedUnblendedUsd:Number(items.reduce((s,x)=>s+x.usd,0).toFixed(5)),
    topByUsageAndOperation:items.filter(x=>x.usd>0.001).slice(0,15).map(({keys,usd})=>({
      usageType:keys[0],operation:keys[1],usd,
    })),
    bucketAttribution:"unknown — standard Cost Explorer usage/operation groups do not identify a bucket",
    warning:"Do not infer these requests originated in todoist-calendar-sync without bucket-level evidence.",
  };
}

export function budgetAudit(stack, resources, accountBudgets, prefix="todoist-calendar-sync",stage="production") {
  const params=Object.fromEntries((stack?.Parameters||[]).map(x=>[x.ParameterKey,x.ParameterValue]));
  const expectedName=`${prefix}-monthly-cost-${stage}`;
  const found=(accountBudgets?.Budgets||[]).find(b=>b.BudgetName===expectedName);
  const deployed=(resources?.StackResources||[]).some(x=>x.LogicalResourceId==="MonthlyCostBudget"
    && x.ResourceType==="AWS::Budgets::Budget" && !/DELETE/.test(x.ResourceStatus || ""));
  const emailConfigured=Boolean(params.BillingAlarmEmail?.trim());
  const threshold=found?.BudgetLimit?.Amount;
  return {
    expectedBudgetName:expectedName,
    budgetResourceDeployed:deployed,
    emailConfigured,
    emailValue:"redacted",
    budgetFoundInAccount:Boolean(found),
    accountScope:"AWS Budgets COST is account-wide unless budget CostFilters restrict it",
    configuredLimitUsd:params.MonthlyBillingLimitUsd || null,
    actualBudgetLimitUsd:threshold || null,
    actualBudgetUnit:found?.BudgetLimit?.Unit || null,
    conditionSatisfied:emailConfigured,
    findings:[
      !emailConfigured ? "BillingAlarmEmail blank: CloudFormation HasBillingAlarmEmail prevents budget and SNS subscription creation" : null,
      emailConfigured && !deployed ? "Email configured but MonthlyCostBudget is not deployed; inspect stack events and conditions" : null,
      deployed && !found ? "Budget resource exists in stack, but DescribeBudgets did not return its expected name" : null,
      !found ? "Do not create a second budget; enable/repair the existing MonthlyCostBudget definition" : null,
    ].filter(Boolean),
  };
}

export function provisionedTotals(table) {
  const t=table?.Table || {};
  const index=(t.GlobalSecondaryIndexes||[]).map(x=>({
    name:x.IndexName,rcu:x.ProvisionedThroughput?.ReadCapacityUnits??null,
    wcu:x.ProvisionedThroughput?.WriteCapacityUnits??null,status:x.IndexStatus,
  }));
  const rcu=t.ProvisionedThroughput?.ReadCapacityUnits??null;
  const wcu=t.ProvisionedThroughput?.WriteCapacityUnits??null;
  return {
    table:t.TableName,status:t.TableStatus,
    deletionProtection:t.DeletionProtectionEnabled,
    main:{rcu,wcu},indexes:index,
    total:{rcu: rcu===null?null:rcu+index.reduce((s,x)=>s+(x.rcu||0),0),
      wcu:wcu===null?null:wcu+index.reduce((s,x)=>s+(x.wcu||0),0)},
  };
}

export function runAudit({
  month=previousUtcMonth(),region="eu-west-2",stackName="todoist-calendar-sync",
  includeCostExplorer=false,
  call=(service,operation,args,apiRegion=region)=>{
    return JSON.parse(execFileSync("aws", [
      service,operation,...args,"--region",apiRegion,"--output","json",
    ],{encoding:"utf8",maxBuffer:12*1024*1024}));
  },
}={}) {
  const window=monthWindow(month);
  const aws=(service,action,args=[],apiRegion)=>call(service,action,args,apiRegion);
  const stackResponse=aws("cloudformation","describe-stacks",["--stack-name",stackName]);
  const stack=stackResponse.Stacks?.[0];
  if (!stack) throw new Error(`No stack found: ${stackName}`);
  const stackResources=aws("cloudformation","describe-stack-resources",["--stack-name",stackName]);
  const identity=aws("sts","get-caller-identity",[]);
  const budgets=aws("budgets","describe-budgets",["--account-id",identity.Account],"us-east-1");
  const prefix=Object.fromEntries((stack.Parameters||[]).map(x=>[x.ParameterKey,x.ParameterValue])).ResourceNamePrefix || stackName;
  const budget=budgetAudit(stack,stackResources,budgets,prefix);
  if (budget.budgetFoundInAccount) {
    const notices=aws("budgets","describe-notifications-for-budget",[
      "--account-id",identity.Account,"--budget-name",budget.expectedBudgetName,
    ],"us-east-1");
    budget.notifications=(notices.Notifications||[]).map(n=>({
      type:n.NotificationType,comparison:n.ComparisonOperator,threshold:n.Threshold,
      state:n.NotificationState,
    }));
    // Notification configured != proof that user has received an email.
    budget.emailReceiptNotVerified=true;
  }
  const outputs=Object.fromEntries((stack.Outputs||[]).map(o=>[o.OutputKey,o.OutputValue]));
  const tableName=outputs.StateTableName;
  if (!tableName) throw new Error("CloudFormation StateTableName output missing");
  const dynamo=provisionedTotals(aws("dynamodb","describe-table",["--table-name",tableName]));
  const pitr=aws("dynamodb","describe-continuous-backups",["--table-name",tableName])
    .ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
  dynamo.pitrStatus=pitr?.PointInTimeRecoveryStatus||"unknown";
  const queueReports=[];
  for (const [name,url] of [["source",outputs.QueueUrl],["dlq",outputs.DlqUrl]]) {
    if (!url) continue;
    const q=aws("sqs","get-queue-attributes",[
      "--queue-url",url,"--attribute-names",
      "ApproximateNumberOfMessages","ApproximateNumberOfMessagesNotVisible",
      "MessageRetentionPeriod","RedrivePolicy",
    ]);
    const a=q.Attributes||{};
    queueReports.push({name,
      messagesVisible:Number(a.ApproximateNumberOfMessages ?? 0),
      messagesNotVisible:Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
      retentionSeconds:Number(a.MessageRetentionPeriod || 0),
      redrivePolicy:a.RedrivePolicy?JSON.parse(a.RedrivePolicy):null,
    });
  }
  const report={
    checkedAtUtc:new Date().toISOString(),
    billingMonth:month,
    estimatedOrFinal:"Cost Explorer historical figures may be adjusted; no invoice-finality claim",
    stack:stackName,region,
    budget,dynamodb:dynamo,queues:queueReports,
    requirePostDeployChecks:["DynamoDB throttle/consumption 1-minute metrics for table and GSI",
      "source FIFO queue age/depth, DLQ, worker transient retry and manual recovery",
      "Calendar cursor/reconciliation progress, home/antonio/work smoke tests",
      "alarm coverage, SNS subscriptions and operator receipt confirmation",
      "PITR, deletion protection, table/GSI identity and CloudFormation change set"],
    paidCostExplorerQueries:0,
  };
  if (includeCostExplorer) {
    const args=["--time-period",JSON.stringify(window),"--granularity","MONTHLY","--metrics","UnblendedCost"];
    const serviceCost=aws("ce","get-cost-and-usage",[...args,"--group-by","Type=DIMENSION,Key=SERVICE"],"us-east-1");
    const s3=aws("ce","get-cost-and-usage",[
      ...args,"--filter",JSON.stringify({Dimensions:{Key:"SERVICE",Values:["Amazon Simple Storage Service"]}}),
      "--group-by","Type=DIMENSION,Key=USAGE_TYPE","Type=DIMENSION,Key=OPERATION",
    ],"us-east-1");
    report.costs={
      accountWideServices:monthlyCostGroups(serviceCost).filter(x=>x.usd>0.001)
        .map(({keys,usd})=>({service:keys[0],usd})),
      s3:s3CostSummary(s3),
      billingWindow:window,
      taxAndInvoiceWarning:"UnblendedCost excluding tax and tax/invoice timing may differ from billed total",
    };
    report.paidCostExplorerQueries=2;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const argv=process.argv.slice(2);
  const includeCostExplorer=argv.includes("--include-cost-explorer");
  const monthPos=argv.indexOf("--month");
  const month=monthPos>=0?argv[monthPos+1]:previousUtcMonth();
  const regionPos=argv.indexOf("--region");
  const region=regionPos>=0?argv[regionPos+1]:"eu-west-2";
  const stackPos=argv.indexOf("--stack");
  const stackName=stackPos>=0?argv[stackPos+1]:"todoist-calendar-sync";
  if (!month||!region||!stackName||argv.some(x=>!["--include-cost-explorer","--month","--region","--stack",month,region,stackName].includes(x))) {
    throw new Error("Usage: node scripts/monthly-cost-audit.mjs [--month YYYY-MM] [--region eu-west-2] [--stack name] [--include-cost-explorer]");
  }
  if (includeCostExplorer) process.stderr.write("Cost Explorer opt-in: making TWO potentially billable GetCostAndUsage calls. Not scheduled.\n");
  console.log(JSON.stringify(runAudit({month,region,stackName,includeCostExplorer}),null,2));
}
