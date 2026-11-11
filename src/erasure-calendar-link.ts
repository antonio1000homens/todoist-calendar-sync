import { fingerprint } from "../scripts/item-purge-policy.mjs";
import type { CalendarEvent } from "./types.js";

/** Return only app-owned shared properties to clear for the exact linked task. */
export function todoistCalendarLinkRemovalPatch(event:CalendarEvent,taskId:string):Record<string,null>|undefined {
  const shared=event.extendedProperties?.shared||{};
  if(shared.taskId!==taskId)return undefined;
  const patch:Record<string,null>={};
  for(const name of Object.keys(shared))
    if(name==="taskId"||name==="taskUrl"||name==="originalSummary"||name.startsWith("sync")||name.startsWith("todoist"))
      patch[name]=null;
  return Object.keys(patch).length?patch:undefined;
}

/** Digest of the exact retained event after unlinking, ignoring provider revision fields. */
export function unlinkedCalendarEventDigest(event:CalendarEvent,taskId:string):string {
  const shared={...(event.extendedProperties?.shared||{})};
  if(shared.taskId===taskId) {
    for(const name of Object.keys(shared))
      if(name==="taskId"||name==="taskUrl"||name==="originalSummary"||name.startsWith("sync")||name.startsWith("todoist"))
        delete shared[name];
  }
  const extendedProperties={...event.extendedProperties} as Record<string,unknown>;
  if(Object.keys(shared).length)extendedProperties.shared=shared;
  else delete extendedProperties.shared;
  const normalized={...event} as Record<string,unknown>;
  if(Object.keys(extendedProperties).length)normalized.extendedProperties=extendedProperties;
  else delete normalized.extendedProperties;
  delete normalized.etag;
  delete normalized.updated;
  delete normalized.sequence;
  return fingerprint(normalized);
}
