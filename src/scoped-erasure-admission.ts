import {createHash,randomUUID} from "node:crypto";
import {GetCommand,TransactWriteCommand,UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {documentClient} from "./dynamodb-capacity.js";
import type {Profile} from "./types.js";

const LEASE_MS=20*60_000,MAX_SCOPES=24;
const table=()=>{const value=process.env.STATE_TABLE_NAME?.trim();if(!value)throw new Error("STATE_TABLE_NAME is required");return value;};
const controlKey=(profile:Profile)=>({pk:`ERASURE#${profile}`,sk:"SCOPED_ADMISSION"});
const operationKey=(id:string)=>({pk:`ERASURE_OPERATION#${id}`,sk:"STATE"});
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable)
  :value&&typeof value==="object"?Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,stable(child)])):value;
const sha=(value:unknown)=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const canonical=(values:string[])=>[...new Set(values)].sort();
export interface HistoricalCleanupScope {
  profile:Profile;caseId:string;fenceFingerprint:string;entities:string[];taskIds:string[];eventIds:string[];resourceKeys:string[];projectCommentIds:string[];
  writeClasses:string[];fingerprint:string;
}
export interface ScopedGrant {
  profile:Profile;owner:string;caseId:string;fenceOperationId:string;fenceFingerprint:string;epoch:number;fingerprint:string;
  entities:string[];taskIds:string[];eventIds:string[];resourceKeys:string[];projectCommentIds:string[];writeClasses:string[];
  acquiredAt:number;expiresAt:number;
}
export interface ScopedAdmission {owner:string;fingerprint:string;assertActive:()=>Promise<number>;release:()=>Promise<void>}
export class ScopedAdmissionBlockedError extends Error {
  constructor(readonly blocker:string){super(blocker);this.name="ScopedAdmissionBlockedError";}
}
export function makeHistoricalCleanupScope(input:Omit<HistoricalCleanupScope,"fingerprint">):HistoricalCleanupScope {
  const normalized={...input,entities:canonical(input.entities),taskIds:canonical(input.taskIds),eventIds:canonical(input.eventIds),
    resourceKeys:canonical(input.resourceKeys),projectCommentIds:canonical(input.projectCommentIds),
    writeClasses:canonical(input.writeClasses)};
  if(!normalized.caseId||!normalized.entities.length||!normalized.taskIds.length||!normalized.eventIds.length
    ||normalized.taskIds.length+normalized.eventIds.length>64||normalized.resourceKeys.length>500
    ||normalized.projectCommentIds.length>100)throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
  return {...normalized,fingerprint:sha(normalized)};
}
export function erasureAdmissionFingerprint(operation:Record<string,unknown>):string {
  return sha({operationId:operation.operationId,profile:operation.profile,status:operation.status,updatedAt:operation.updatedAt,
    previewFingerprint:operation.previewFingerprint,target:operation.target,selectedActions:operation.selectedActions,
    inventory:operation.inventory,actionPlan:operation.actionPlan});
}
export function scopeConflict(a:HistoricalCleanupScope|ScopedGrant,b:HistoricalCleanupScope|ScopedGrant):string|undefined {
  const overlap=(left:string[],right:string[])=>left.some(value=>right.includes(value));
  if(overlap(a.entities,b.entities)||overlap(a.taskIds,b.taskIds)||overlap(a.eventIds,b.eventIds))return "scoped_admission_overlap";
  if(overlap(a.resourceKeys,b.resourceKeys))return "shared_audit_record";
  if(overlap(a.projectCommentIds,b.projectCommentIds))return "shared_project_comment";
  return undefined;
}
function readGrant(value:unknown):ScopedGrant|undefined {
  if(!value||typeof value!=="object")return undefined;
  const grant=value as ScopedGrant;
  if(typeof grant.owner!=="string"||typeof grant.caseId!=="string"||typeof grant.fingerprint!=="string"
    ||typeof grant.fenceFingerprint!=="string"
    ||!Number.isSafeInteger(grant.epoch)||!Number.isFinite(grant.expiresAt)
    ||!Array.isArray(grant.entities)||!Array.isArray(grant.taskIds)||!Array.isArray(grant.eventIds)||!Array.isArray(grant.resourceKeys)
    ||!Array.isArray(grant.projectCommentIds)||!Array.isArray(grant.writeClasses))return undefined;
  return grant;
}
function activeGrants(row:Record<string,unknown>|undefined,now=Date.now()):ScopedGrant[] {
  if(!row)return [];
  if(!Array.isArray(row.grants))throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
  const grants=row.grants.map(readGrant);
  if(grants.some(value=>!value))throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
  return (grants as ScopedGrant[]).filter(grant=>grant.expiresAt>now);
}
const conditional=(error:unknown)=>["TransactionCanceledException","ConditionalCheckFailedException"].includes((error as {name?:string})?.name||"");

async function mutateRegistry(db:Pick<typeof documentClient,"send">,profile:Profile,transform:(grants:ScopedGrant[])=>ScopedGrant[],
  exclusiveOwner?:string):Promise<void> {
  const key=controlKey(profile);
  for(let attempt=0;attempt<8;attempt++) {
    const result=await db.send(new GetCommand({TableName:table(),Key:key,ConsistentRead:true}));
    const row=result.Item as Record<string,unknown>|undefined;if(!row)return;
    const now=Date.now(),grants=activeGrants(row,now),next=transform(grants),version=Number(row.version)||0;
    const expression=exclusiveOwner===undefined
      ?"SET grants=:grants, owners=:owners, leaseUntilByOwner=:leaseMap, #version=:nextVersion"
      :"SET grants=:grants, owners=:owners, leaseUntilByOwner=:leaseMap, #version=:nextVersion REMOVE exclusiveOwner, exclusiveUntil";
    const values:Record<string,unknown>={":version":version,":nextVersion":version+1,":grants":next,
      ":owners":next.map(value=>value.owner),":leaseMap":Object.fromEntries(next.map(value=>[value.owner,value.expiresAt]))};
    if(exclusiveOwner!==undefined)values[":owner"]=exclusiveOwner;
    try {
      await db.send(new UpdateCommand({TableName:table(),Key:key,UpdateExpression:expression,
        ConditionExpression:"#version=:version"+(exclusiveOwner!==undefined?" AND exclusiveOwner=:owner":""),
        ExpressionAttributeNames:{"#version":"version"},ExpressionAttributeValues:values}));return;
    }catch(error){if(!conditional(error)||attempt===7)throw error;}
  }
}

/** Atomic case grant compatible with an already-held, review_required erasure fence. */
export async function acquireHistoricalCleanupScope(input:{profile:Profile;fenceOperationId:string;epoch:number;
  scope:HistoricalCleanupScope;owner?:string;db?:Pick<typeof documentClient,"send">}):Promise<ScopedAdmission> {
  const db=input.db||documentClient,owner=input.owner||randomUUID(),now=()=>Date.now();
  const {profile,fenceOperationId,epoch,scope}=input;
  if(process.env.ERASURE_PROTOCOL_VERSION!=="1")
    throw new ScopedAdmissionBlockedError("writer_not_protocol_aware");
  const {fingerprint,...fingerprinted}=scope;
  if(scope.profile!==profile||scope.fingerprint!==sha(fingerprinted))
    throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
  for(let attempt=0;attempt<8;attempt++) {
    const [fenceResult,epochResult,operationResult,registryResult]=await Promise.all([
      db.send(new GetCommand({TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"FENCE"},ConsistentRead:true})),
      db.send(new GetCommand({TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"EPOCH"},ConsistentRead:true})),
      db.send(new GetCommand({TableName:table(),Key:operationKey(fenceOperationId),ConsistentRead:true})),
      db.send(new GetCommand({TableName:table(),Key:controlKey(profile),ConsistentRead:true})),
    ]);
    const fence=fenceResult.Item as Record<string,unknown>|undefined;
    const op=operationResult.Item as Record<string,unknown>|undefined;
    const registry=registryResult.Item as Record<string,unknown>|undefined;
    if(fence?.operationId!==fenceOperationId||fence.state!=="active"||epochResult.Item?.epoch!==epoch)
      throw new ScopedAdmissionBlockedError("fence_epoch_changed");
    if(!op||op.profile!==profile||op.status!=="review_required"
      ||op.recovery&&["queued","restoring","verifying"].includes(String((op.recovery as Record<string,unknown>).status)))
      throw new ScopedAdmissionBlockedError("writer_not_protocol_aware");
    if(op.previewFingerprint!==op.confirmationFingerprint||typeof op.previewFingerprint!=="string"
      ||!Array.isArray(op.inventory)||!op.actionPlan||typeof op.actionPlan!=="object")
      throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
    if(erasureAdmissionFingerprint(op)!==scope.fenceFingerprint)
      throw new ScopedAdmissionBlockedError("fence_epoch_changed");
    const progress=(op.lifecycle as Record<string,unknown>|undefined)?.deletionProgress as Record<string,unknown>|undefined;
    const writeAttempt=progress?.attempt as Record<string,unknown>|undefined;
    if(writeAttempt&&typeof writeAttempt.startedAt==="number"&&now()-writeAttempt.startedAt<180_000)
      throw new ScopedAdmissionBlockedError("writer_not_protocol_aware");
    if(writeAttempt&&typeof writeAttempt.startedAt!=="number")throw new ScopedAdmissionBlockedError("incomplete_owner_inventory");
    if(registry?.exclusiveOwner&&Number(registry.exclusiveUntil)>now())
      throw new ScopedAdmissionBlockedError("writer_not_protocol_aware");
    const grants=activeGrants(registry,now());
    for(const existing of grants){const conflict=scopeConflict(scope,existing);if(conflict)throw new ScopedAdmissionBlockedError(conflict);}
    if(grants.length>=MAX_SCOPES)throw new ScopedAdmissionBlockedError("scoped_admission_capacity");
    const grant:ScopedGrant={profile,owner,caseId:scope.caseId,fenceOperationId,fenceFingerprint:scope.fenceFingerprint,epoch,fingerprint:scope.fingerprint,
      entities:scope.entities,taskIds:scope.taskIds,eventIds:scope.eventIds,resourceKeys:scope.resourceKeys,
      projectCommentIds:scope.projectCommentIds,writeClasses:scope.writeClasses,acquiredAt:now(),expiresAt:now()+LEASE_MS};
    const next=[...grants,grant],version=Number.isSafeInteger(registry?.version)?Number(registry!.version):0;
    const items:any[]=[
      {ConditionCheck:{TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"FENCE"},
        ConditionExpression:"operationId=:op AND #state=:active",ExpressionAttributeNames:{"#state":"state"},
        ExpressionAttributeValues:{":op":fenceOperationId,":active":"active"}}},
      {ConditionCheck:{TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"EPOCH"},
        ConditionExpression:"epoch=:epoch",ExpressionAttributeValues:{":epoch":epoch}}},
      {ConditionCheck:{TableName:table(),Key:operationKey(fenceOperationId),
        ConditionExpression:"#profile=:profile AND #status=:review AND previewFingerprint=:fingerprint AND confirmationFingerprint=:fingerprint AND attribute_not_exists(recovery)",
        ExpressionAttributeNames:{"#profile":"profile","#status":"status"},
        ExpressionAttributeValues:{":profile":profile,":review":"review_required",":fingerprint":op.previewFingerprint}}},
      registry
        ?{Update:{TableName:table(),Key:controlKey(profile),UpdateExpression:"SET grants=:grants, owners=:owners, leaseUntilByOwner=:leaseMap, #version=:nextVersion",
          ConditionExpression:"#version=:version AND (attribute_not_exists(exclusiveUntil) OR exclusiveUntil<=:now)",
          ExpressionAttributeNames:{"#version":"version"},ExpressionAttributeValues:{":grants":next,
            ":owners":next.map(value=>value.owner),":leaseMap":Object.fromEntries(next.map(value=>[value.owner,value.expiresAt])),
            ":version":version,":nextVersion":version+1,":now":now()}}}
        :{Put:{TableName:table(),Item:{...controlKey(profile),version:1,grants:next,
          owners:next.map(value=>value.owner),leaseUntilByOwner:Object.fromEntries(next.map(value=>[value.owner,value.expiresAt]))},
          ConditionExpression:"attribute_not_exists(pk)"}},
    ];
    try{await db.send(new TransactWriteCommand({TransactItems:items}));break;}
    catch(error){if(!conditional(error))throw error;if(attempt===7)throw new ScopedAdmissionBlockedError("scoped_admission_overlap");}
  }
  const assertActive=async()=>{
    for(let check=0;check<8;check++){
      const [registryResult,fenceResult,epochResult,operationResult]=await Promise.all([
        db.send(new GetCommand({TableName:table(),Key:controlKey(profile),ConsistentRead:true})),
        db.send(new GetCommand({TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"FENCE"},ConsistentRead:true})),
        db.send(new GetCommand({TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"EPOCH"},ConsistentRead:true})),
        db.send(new GetCommand({TableName:table(),Key:operationKey(fenceOperationId),ConsistentRead:true})),
      ]);
      const registry=registryResult.Item as Record<string,unknown>|undefined,grants=activeGrants(registry,now());
      const fence=fenceResult.Item as Record<string,unknown>|undefined;
      const op=operationResult.Item as Record<string,unknown>|undefined;
      if(fence?.operationId!==fenceOperationId||fence.state!=="active"||epochResult.Item?.epoch!==epoch
        ||op?.status!=="review_required"||op.recovery||erasureAdmissionFingerprint(op||{})!==scope.fenceFingerprint)
        throw new ScopedAdmissionBlockedError("fence_epoch_changed");
      const current=grants.find(value=>value.owner===owner);
      if(!current||current.fingerprint!==scope.fingerprint)throw new ScopedAdmissionBlockedError("scoped_admission_lease_expired");
      const refreshed={...current,expiresAt:now()+LEASE_MS};
      try{
        await db.send(new UpdateCommand({TableName:table(),Key:controlKey(profile),
          UpdateExpression:"SET grants=:grants, owners=:owners, leaseUntilByOwner=:leaseMap, #version=:nextVersion",
          ConditionExpression:"#version=:version AND (attribute_not_exists(exclusiveUntil) OR exclusiveUntil<=:now)",
          ExpressionAttributeNames:{"#version":"version"},ExpressionAttributeValues:{":grants":grants.map(value=>value.owner===owner?refreshed:value),
            ":owners":grants.map(value=>value.owner),":leaseMap":Object.fromEntries(grants.map(value=>[value.owner,
              value.owner===owner?refreshed.expiresAt:value.expiresAt])),
            ":version":registry?.version,":nextVersion":Number(registry?.version)+1,":now":now()}}));
        return Number(registry?.version)+1;
      }catch(error){
        if(!conditional(error))throw error;
        if(check===7)throw new ScopedAdmissionBlockedError("fence_epoch_changed");
      }
    }
    throw new ScopedAdmissionBlockedError("fence_epoch_changed");
  };
  return {owner,fingerprint:scope.fingerprint,assertActive,
    release:()=>mutateRegistry(db,profile,grants=>grants.filter(value=>value.owner!==owner))};
}

/** Exclusive erasure/recovery permit. A cleanup grant and a recovery permit
 * contend on the same registry version and can never become active together. */
export async function acquireErasureExclusiveAdmission(profile:Profile,owner:string,
  db:Pick<typeof documentClient,"send">=documentClient):Promise<()=>Promise<void>> {
  const key=controlKey(profile);
  for(let attempt=0;attempt<8;attempt++) {
    const [fenceResult,opResult,registryResult]=await Promise.all([
      db.send(new GetCommand({TableName:table(),Key:{pk:`ERASURE#${profile}`,sk:"FENCE"},ConsistentRead:true})),
      db.send(new GetCommand({TableName:table(),Key:operationKey(owner),ConsistentRead:true})),
      db.send(new GetCommand({TableName:table(),Key:key,ConsistentRead:true})),
    ]);
    const fence=fenceResult.Item as Record<string,unknown>|undefined,op=opResult.Item as Record<string,unknown>|undefined;
    const row=registryResult.Item as Record<string,unknown>|undefined,now=Date.now();
    if(fence?.operationId!==owner||fence.state!=="active"||op?.profile!==profile)
      throw new ScopedAdmissionBlockedError("fence_epoch_changed");
    if(activeGrants(row,now).length)throw new ScopedAdmissionBlockedError("scoped_admission_overlap");
    if(row?.exclusiveOwner&&row.exclusiveOwner!==owner&&Number(row.exclusiveUntil)>now)
      throw new ScopedAdmissionBlockedError("writer_not_protocol_aware");
    if(row?.exclusiveOwner===owner&&Number(row.exclusiveUntil)>now)return async()=>{};
    const version=Number.isSafeInteger(row?.version)?Number(row!.version):0;
    try{
      await db.send(new UpdateCommand({TableName:table(),Key:key,
        UpdateExpression:"SET exclusiveOwner=:owner, exclusiveUntil=:until, grants=:grants, owners=:owners, leaseUntilByOwner=:leaseMap, #version=:nextVersion",
        ConditionExpression:(row?"#version=:version":"attribute_not_exists(pk)")+
          " AND (attribute_not_exists(exclusiveUntil) OR exclusiveUntil<=:now OR exclusiveOwner=:owner)",
        ExpressionAttributeNames:{"#version":"version"},ExpressionAttributeValues:{":owner":owner,":until":now+LEASE_MS,
          ":grants":activeGrants(row,now),":owners":[],":leaseMap":{},
          ":version":version,":nextVersion":version+1,":now":now}}));
      return ()=>mutateRegistry(db,profile,values=>values,owner);
    }catch(error){if(!conditional(error))throw error;if(attempt===7)throw new ScopedAdmissionBlockedError("scoped_admission_overlap");}
  }
  throw new ScopedAdmissionBlockedError("scoped_admission_overlap");
}

/** Add the active scoped grants to the existing lease inventory. */
export function scopedGrantsAsLeases(row:Record<string,unknown>|undefined,now=Date.now()):Record<string,unknown>[] {
  return activeGrants(row,now).map(grant=>({pk:"SCOPED_ADMISSION",sk:`SCOPED#${grant.owner}`,
    kind:"scoped_historical_cleanup",owner:grant.owner,caseId:grant.caseId,expiresAt:grant.expiresAt}));
}
