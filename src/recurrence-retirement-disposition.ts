/**
 * #351 permanent, profile-scoped association retirement admission.
 *
 * This guard does NOT implement Apply or Undo; it is the common reader for
 * immutable operator receipts written by the later transactional worker.
 * It does not infer deletion from dates, titles, missing provider items or a
 * retired ID belonging to another profile.
 *
 * VERSION is staged OFF until all ingress, reconciliation and worker code
 * uses these checks. An unrecognised version fails closed.
 */
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

export type RetiredIdentity = {
  profile: Profile;
  taskId?: string;
  eventIds?: readonly string[];
  seriesIds?: readonly string[];
};
export class RetirementDispositionBlockedError extends Error {
  constructor() {
    super("Operator-retired association is excluded from future synchronisation");
    this.name="RetirementDispositionBlockedError";
  }
}
export class RetirementDispositionUnavailableError extends Error {
  constructor(message="Operator retirement admission could not be verified; sync writes must fail closed") {
    super(message);
    this.name="RetirementDispositionUnavailableError";
  }
}
export type DispositionKey = {pk:string;sk:"STATE"};
const PROFILES=["home","antonio","work"] as const;
const ID=/^[A-Za-z0-9@_.:-]{1,1024}$/;
export function retirementDispositionEnabled():boolean {
  const value=process.env.RETIREMENT_DISPOSITION_VERSION;
  if(value===undefined||value===""||value==="0")return false;
  if(value==="1")return true;
  throw new RetirementDispositionUnavailableError("Unknown retirement disposition version");
}
export function retirementDispositionKeys(identity:RetiredIdentity):DispositionKey[] {
  if(!PROFILES.includes(identity.profile) ||
    (!identity.taskId&&!identity.eventIds?.length&&!identity.seriesIds?.length))
    throw new RetirementDispositionUnavailableError("A scoped task, event or series identity is required");
  const values=[
    ...(identity.taskId?[["TASK",identity.taskId] as const]:[]),
    ...(identity.eventIds||[]).map(id=>["EVENT",id] as const),
    ...(identity.seriesIds||[]).map(id=>["SERIES",id] as const),
  ];
  if(values.length>66 || values.some(([,id])=>!ID.test(id)) ||
    new Set(values.map(([kind,id])=>kind+":"+id)).size!==values.length)
    throw new RetirementDispositionUnavailableError("Retirement identity is incomplete or malformed");
  return values.map(([kind,id])=>({pk:"RETIREMENT#"+identity.profile+"#"+kind+"#"+id,sk:"STATE"}));
}
export type RetirementDisposition = {
  profile:Profile;
  operationId:string;
  status:"preparing"|"retired"|"releasing";
  taskId:string;
  seriesId:string;
  masterEventId:string;
  createdAt:string;
};
/**
 * No cached negative reads. A preparing/releasing receipt is a hard fence as
 * well as a completed retired receipt. Every identity is read consistently.
 * A malformed key record is not permissive.
 */
export async function getRetirementDisposition(
  identity:RetiredIdentity,
  db:Pick<DynamoDBDocumentClient,"send">=documentClient,
):Promise<RetirementDisposition|undefined> {
  if(!retirementDispositionEnabled())return undefined;
  const table=process.env.STATE_TABLE_NAME;
  if(!table)throw new RetirementDispositionUnavailableError();
  for(const Key of retirementDispositionKeys(identity)){
    let result;
    try{result=await db.send(new GetCommand({TableName:table,Key,ConsistentRead:true}));}
    catch {throw new RetirementDispositionUnavailableError();}
    if(!result.Item)continue;
    const record=result.Item as Partial<RetirementDisposition>;
    if(record.profile!==identity.profile ||
      !["preparing","retired","releasing"].includes(String(record.status)) ||
      typeof record.operationId!=="string"||!record.operationId ||
      typeof record.taskId!=="string"||!record.taskId ||
      typeof record.seriesId!=="string"||!record.seriesId ||
      typeof record.masterEventId!=="string"||!record.masterEventId)
      throw new RetirementDispositionUnavailableError("Retirement marker has malformed ownership or status");
    return record as RetirementDisposition;
  }
  return undefined;
}
/** Optional read path for reconciliation: retirements silently skip work. */
export async function isRetiredIdentity(
  identity:RetiredIdentity, db:Pick<DynamoDBDocumentClient,"send">=documentClient,
):Promise<boolean> {
  return Boolean(await getRetirementDisposition(identity,db));
}
/** Mandatory write admission: provider and state writes must not rebind. */
export async function assertRetirementAdmissionIfEnabled(
  identity:RetiredIdentity, db:Pick<DynamoDBDocumentClient,"send">=documentClient,
):Promise<void> {
  if(await getRetirementDisposition(identity,db))throw new RetirementDispositionBlockedError();
}
