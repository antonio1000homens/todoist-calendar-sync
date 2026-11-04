/**
 * Issue #333: independently signed, read-only inventory of Calendar IDs.
 * CalendarList is NOT a complete ACL registry: this payload is attested
 * against an external operator-reviewed routing + historical ACL register.
 * No provider or state mutation can be performed from this module.
 */
import {createHash,createPublicKey,verify} from "node:crypto";
import type {Profile} from "./types.js";

export const CALENDAR_PROVENANCE_MAX_AGE_MS=5*60_000;
export const CALENDAR_PROVENANCE_SOURCE="independently-reviewed-routing-and-calendar-acl-register" as const;
export const ERASURE_PROFILES:Profile[]=["home","antonio","work"];
export type CalendarCoverageEntry={
  id:string;
  direction:"source"|"destination"|"both";
  origin:"configured"|"legacy"|"shared"|"calendar-list";
  accessRole:"reader"|"writer"|"owner"|"writerWithoutPrivateAccess"|"freeBusyReader";
};
export type CalendarCoverageAttestation={
  version:1;
  source:typeof CALENDAR_PROVENANCE_SOURCE;
  evidenceSha256:string;
  complete:boolean;
  observedAt:string;
  expiresAt:string;
  accountId:string;
  region:string;
  functionName:string;
  qualifier:string;
  routingFingerprint:string;
  profiles:Record<Profile,{configuredCalendarId:string;calendars:CalendarCoverageEntry[]}>;
};
export type VerifiedCalendarProvenance=CalendarCoverageAttestation&{
  signatureVerified:true;
  attestationFingerprint:string;
};

const calendarId=(value:unknown):value is string=>
  typeof value==="string"&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
const sha256=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const roles=new Set(["reader","writer","owner","writerWithoutPrivateAccess","freeBusyReader"]);
const origins=new Set(["configured","legacy","shared","calendar-list"]);
const directions=new Set(["source","destination","both"]);
export function canonicalCalendarProvenanceJson(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonicalCalendarProvenanceJson).join(",")+"]";
  if(value!==null&&typeof value==="object")
    return "{"+Object.keys(value as Record<string,unknown>).sort()
      .map(key=>JSON.stringify(key)+":"+canonicalCalendarProvenanceJson((value as Record<string,unknown>)[key]))
      .join(",")+"}";
  if(typeof value==="string"||typeof value==="boolean"||(typeof value==="number"&&Number.isFinite(value))
    ||value===null)return JSON.stringify(value);
  throw new Error("Calendar provenance contains an unsupported JSON value");
}
export function calendarRoutingFingerprint(config:unknown):string {
  return createHash("sha256").update(canonicalCalendarProvenanceJson(config)).digest("hex");
}
export function calendarProvenanceIsFresh(value:Pick<CalendarCoverageAttestation,"observedAt"|"expiresAt">,
  now=Date.now()):boolean {
  const observed=Date.parse(value.observedAt),expires=Date.parse(value.expiresAt);
  return Number.isFinite(observed)&&Number.isFinite(expires)
    &&observed<=now+60_000&&now-observed<=CALENDAR_PROVENANCE_MAX_AGE_MS
    &&expires>=now&&expires>observed&&expires-observed<=CALENDAR_PROVENANCE_MAX_AGE_MS;
}

/**
 * The trust key MUST come from independently reviewed deployment configuration,
 * never from this document or an accompanying CLI flag. Missing trust -> reject.
 * The external ACL evidence SHA binds the signing review to its private source.
 */
export function verifyCalendarProvenance(raw:unknown,trustPublicKeySpkiB64:string,expected:{
  accountId:string;region:string;functionName:string;qualifier:string;routingFingerprint:string;
}):VerifiedCalendarProvenance {
  const failed=()=>{throw new Error("Calendar provenance signature, scope or registry is invalid");};
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||!trustPublicKeySpkiB64) return failed();
  const document=raw as Record<string,unknown>;
  const signature=document.signature;
  const {signature:_signature,...payload}=document;
  if(typeof signature!=="string"||!/^[A-Za-z0-9+/]{86}==$/.test(signature)
    ||document.version!==1||document.source!==CALENDAR_PROVENANCE_SOURCE
    ||document.complete!==true||!sha256(document.evidenceSha256)
    ||typeof document.observedAt!=="string"||typeof document.expiresAt!=="string"
    ||!Number.isFinite(Date.parse(document.observedAt))
    ||!Number.isFinite(Date.parse(document.expiresAt))
    ||!sha256(document.routingFingerprint))return failed();
  for(const [key,value] of Object.entries(expected))if(document[key]!==value)return failed();
  const profiles=document.profiles;
  if(!profiles||typeof profiles!=="object"||Array.isArray(profiles)
    ||Object.keys(profiles).sort().join(",")!==ERASURE_PROFILES.slice().sort().join(","))return failed();
  for(const profile of ERASURE_PROFILES) {
    const record=(profiles as Record<string,unknown>)[profile] as {configuredCalendarId?:unknown;calendars?:unknown};
    if(!record||typeof record!=="object"||!calendarId(record.configuredCalendarId)
      ||!Array.isArray(record.calendars)||record.calendars.length<1||record.calendars.length>256)return failed();
    const ids=new Set<string>();
    let configured=0,source=0,destination=0;
    for(const entry of record.calendars) {
      if(!entry||typeof entry!=="object"||!calendarId(entry.id)||ids.has(entry.id)
        ||!roles.has(entry.accessRole)||!origins.has(entry.origin)||!directions.has(entry.direction))return failed();
      ids.add(entry.id);
      if(entry.origin==="configured") {
        if(entry.id!==record.configuredCalendarId||entry.direction!=="both")return failed();
        configured++;
      }
      if(entry.direction!=="destination")source++;
      if(entry.direction!=="source")destination++;
    }
    if(configured!==1||source===0||destination===0)return failed();
  }
  let key;
  try { key=createPublicKey({key:Buffer.from(trustPublicKeySpkiB64,"base64"),format:"der",type:"spki"}); }catch{return failed();}
  if(key.asymmetricKeyType!=="ed25519")return failed();
  const signed=Buffer.from(canonicalCalendarProvenanceJson(payload),"utf8");
  if(!verify(null,signed,key,Buffer.from(signature,"base64")))return failed();
  return {...payload,signatureVerified:true,
    attestationFingerprint:createHash("sha256").update(signed).digest("hex")} as VerifiedCalendarProvenance;
}
