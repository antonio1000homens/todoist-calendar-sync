import assert from "node:assert/strict";
import test from "node:test";
import {summarizeErasureDeliveryReceipts} from "../dist/erasure-delivery-receipt-audit.js";

test("delivery receipt audit aggregates profile, identity-reference and TTL state without keys",()=>{
  const nowMs=1_800_000_000_000;
  const nowSeconds=Math.floor(nowMs/1000);
  const rows=[
    {pk:"DELIVERY#selected-secret-id",sk:"COMPLETED",profile:"work",kind:"todoist",
      identityRefs:{taskIds:["private-task-id"],eventIds:[]},expiresAt:nowSeconds-1},
    {pk:"DELIVERY#empty-arrays",sk:"COMPLETED",profile:"work",kind:"todoist",
      identityRefs:{taskIds:[],eventIds:[]},expiresAt:nowSeconds+30},
    {pk:"DELIVERY#legacy-secret-id",sk:"COMPLETED",profile:"work",kind:"calendar",expiresAt:nowSeconds+86_400},
    {pk:"DELIVERY#bad-ttl",sk:"COMPLETED",profile:"work",kind:"calendar",expiresAt:"invalid"},
    {pk:"DELIVERY#string-ttl",sk:"COMPLETED",profile:"work",kind:"calendar",expiresAt:String(nowSeconds+10)},
    {pk:"DELIVERY#other-profile",sk:"COMPLETED",profile:"home",kind:"calendar",expiresAt:nowSeconds+30},
    {pk:"TASK#unrelated",sk:"STATE",profile:"work",kind:"todoist",expiresAt:nowSeconds+30},
  ];
  const report=summarizeErasureDeliveryReceipts(rows,"work",nowMs);
  assert.equal(report.observedAt,new Date(nowMs).toISOString());
  assert.equal(report.completedReceiptCount,5);
  assert.deepEqual(report.byKind.todoist.withIdentityRefArrays,{
    count:2,expired:1,expiresWithin1d:1,expiresWithin7d:1,expiresWithin14d:1,missingOrInvalidExpiry:0,
  });
  assert.deepEqual(report.byKind.calendar.withoutIdentityRefArrays,{
    count:3,expired:0,expiresWithin1d:1,expiresWithin7d:1,expiresWithin14d:1,missingOrInvalidExpiry:2,
  });
  const serialized=JSON.stringify(report);
  for(const privateValue of ["selected-secret-id","legacy-secret-id","private-task-id","other-profile"])
    assert.equal(serialized.includes(privateValue),false);
});

test("delivery receipt audit rejects incomplete inputs and invalid time",()=>{
  assert.throws(()=>summarizeErasureDeliveryReceipts(undefined,"work"),/complete state inventory/);
  assert.throws(()=>summarizeErasureDeliveryReceipts([],"scouts"),/valid profile/);
  assert.throws(()=>summarizeErasureDeliveryReceipts([],"work",Number.NaN),/valid profile\/time/);
});
