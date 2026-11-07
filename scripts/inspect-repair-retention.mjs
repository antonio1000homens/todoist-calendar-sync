#!/usr/bin/env node
/**
 * #367 bounded full-table, read-only repair retention dependency report.
 * A partial table scan cannot prove absence of references, so no dependency
 * classifications are emitted until every scan page has been examined.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { assessRepairRetention, parseRepairRetentionArgs } from "./repair-retention-evidence.mjs";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const THROTTLE = new Set(["ThrottlingException", "ProvisionedThroughputExceededException",
  "RequestLimitExceeded", "InternalServerError"]);
const TABLE_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;

export async function scanRepairEvidence({client, table, options, delay=sleep, now=Date.now}) {
  let cursor, pageCount = 0, scannedCount = 0, capacityUnits = 0;
  const allRows = [];
  while (pageCount < options.maxPages) {
    let res;
    const request = new ScanCommand({
      TableName:table, ConsistentRead:true, Limit:100, ReturnConsumedCapacity:"TOTAL",
      ...(cursor ? {ExclusiveStartKey:cursor} : {}),
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      try { res = await client.send(request); break; }
      catch (error) {
        if (!THROTTLE.has(error?.name) || attempt === 4) throw error;
        await delay(Math.min(5000, 250 * 2 ** attempt));
      }
    }
    pageCount++;
    scannedCount += Number(res.ScannedCount ?? res.Items?.length ?? 0);
    capacityUnits += Number(res.ConsumedCapacity?.CapacityUnits || 0);
    allRows.push(...(res.Items || []));
    cursor = res.LastEvaluatedKey;
    await delay(Math.max(200, Math.ceil(Number(res.ConsumedCapacity?.CapacityUnits || 1) * 200)));
    if (!cursor) {
      return {scanComplete:true,mode:"read_only",pageCount,scannedCount,capacityUnits,
        ...assessRepairRetention(allRows,{profile:options.profile,nowMs:now()}),
        warning:"No automatic or operator deletion is authorised. DynamoDB-only evidence cannot prove absent queued retries or external references."};
    }
  }
  // Deliberately do not output even provisional operation/absence counts.
  return {scanComplete:false,mode:"read_only",pageCount,scannedCount,capacityUnits,
    status:"INCOMPLETE_REFERENCE_INVENTORY",
    warning:"No lifecycle conclusions are valid until the strongly consistent scan reaches its final page. Re-run with a larger bounded --max-pages and during an appropriate maintenance window."};
}

export async function main(args=process.argv.slice(2),env=process.env) {
  const options = parseRepairRetentionArgs(args);
  const table = env.STATE_TABLE_NAME?.trim();
  if (!table || !TABLE_PATTERN.test(table)) throw new Error("Explicit valid STATE_TABLE_NAME is required");
  if (!env.AWS_REGION?.trim()) throw new Error("Explicit AWS_REGION is required");
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({
    region:env.AWS_REGION,maxAttempts:4,retryMode:"standard",
  }),{marshallOptions:{removeUndefinedValues:true}});
  const result = await scanRepairEvidence({client,table,options});
  console.log(JSON.stringify(result,null,2));
  if (!result.scanComplete) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => {
    console.error("Repair retention inspection failed: " + String(error?.message || error));
    process.exitCode = 1;
  });
