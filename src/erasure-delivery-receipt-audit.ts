import type {Profile} from "./types.js";

export interface DeliveryReceiptExpirySummary {
  count:number;
  expired:number;
  expiresWithin1d:number;
  expiresWithin7d:number;
  expiresWithin14d:number;
  missingOrInvalidExpiry:number;
}

export interface ErasureDeliveryReceiptAudit {
  observedAt:string;
  profile:Profile;
  completedReceiptCount:number;
  byKind:Record<string,{withIdentityRefArrays:DeliveryReceiptExpirySummary;withoutIdentityRefArrays:DeliveryReceiptExpirySummary}>;
}

function emptySummary():DeliveryReceiptExpirySummary {
  return {count:0,expired:0,expiresWithin1d:0,expiresWithin7d:0,expiresWithin14d:0,missingOrInvalidExpiry:0};
}

/** Return aggregate TTL and identity-reference coverage without exposing receipt keys. */
export function summarizeErasureDeliveryReceipts(
  rows:Record<string,unknown>[],profile:Profile,nowMs=Date.now(),
):ErasureDeliveryReceiptAudit {
  if(!Array.isArray(rows)||!(["home","antonio","work"] as string[]).includes(profile)
    ||!Number.isFinite(nowMs)||nowMs<0)throw new Error("A complete state inventory and valid profile/time are required");
  const observedSecond=Math.floor(nowMs/1000),byKind:ErasureDeliveryReceiptAudit["byKind"]={};
  let completedReceiptCount=0;
  for(const row of rows) {
    if(!row||typeof row.pk!=="string"||!row.pk.startsWith("DELIVERY#")||row.sk!=="COMPLETED"||row.profile!==profile)continue;
    completedReceiptCount++;
    const rawKind=typeof row.kind==="string"&&/^[a-z][a-z0-9_-]{0,31}$/.test(row.kind)?row.kind:"other";
    const item=byKind[rawKind]||(byKind[rawKind]={withIdentityRefArrays:emptySummary(),withoutIdentityRefArrays:emptySummary()});
    const hasIdentityRefs=Array.isArray((row.identityRefs as Record<string,unknown>|undefined)?.taskIds)
      ||Array.isArray((row.identityRefs as Record<string,unknown>|undefined)?.eventIds);
    const summary=hasIdentityRefs?item.withIdentityRefArrays:item.withoutIdentityRefArrays;
    summary.count++;
    const expiresAt=row.expiresAt;
    if(typeof expiresAt!=="number"||!Number.isSafeInteger(expiresAt)||expiresAt<=0) {
      summary.missingOrInvalidExpiry++;continue;
    }
    const remaining=expiresAt-observedSecond;
    if(remaining<=0)summary.expired++;
    else {
      if(remaining<=86_400)summary.expiresWithin1d++;
      if(remaining<=7*86_400)summary.expiresWithin7d++;
      if(remaining<=14*86_400)summary.expiresWithin14d++;
    }
  }
  return {observedAt:new Date(nowMs).toISOString(),profile,completedReceiptCount,
    byKind:Object.fromEntries(Object.entries(byKind).sort(([left],[right])=>left.localeCompare(right)))};
}
