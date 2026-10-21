import { profiles } from "./config.js";
import type { ProviderClientFactory } from "./mutation-budget.js";
import { entityKey, type RepairOperation, type Side } from "./review-types.js";
import { reviewHash } from "./review-store.js";
import type { CalendarEvent, Profile, TodoistTask } from "./types.js";

type ProviderObject = CalendarEvent | TodoistTask;
const calendarWrites = new Set(["upsertEvent", "upsertEventIfUnchanged", "createFutureMasterOnce", "createRepairEventOnce", "deleteEvent"]);
const taskWrites = new Set(["upsertTask", "updateRecurringOccurrence", "createTaskOnce", "moveTask", "deleteTask"]);

/** Carry approved provider versions through our own writes and durable retries. */
export function guardRepairProviders(operation: RepairOperation, factory: ProviderClientFactory, save: () => Promise<void>): ProviderClientFactory {
  operation.expectedProviders ??= Object.fromEntries(operation.preview.snapshots.map(s => [entityKey(s.ref), s.object]));
  const expected = operation.expectedProviders;
  return async profile => {
    const clients = await factory(profile);
    const wrap = <T extends object>(provider: T, side: Side): T => new Proxy(provider, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const method = String(property);
        const read = method === (side === "calendar" ? "getEvent" : "getTask");
        const write = (side === "calendar" ? calendarWrites : taskWrites).has(method);
        if (!read && !write) return value.bind(target);
        return async (...args: unknown[]) => {
          const id = read || method.startsWith("delete") || method === "moveTask" ? args[0] as string
            : method === "updateRecurringOccurrence" ? (args[0] as TodoistTask).id
            : method === "createTaskOnce" ? undefined
            : method === "createFutureMasterOnce" || method === "createRepairEventOnce" ? (args[0] as CalendarEvent).id
            : (args[1] as string|undefined) || (side === "calendar" ? (args[0] as CalendarEvent).id : undefined);
          const key = id ? entityKey({ profile, side, id }) : undefined;
          const check = (object: ProviderObject | null) => {
            if (key && Object.hasOwn(expected, key) && reviewHash(expected[key]) !== reviewHash(object)) {
              throw new Error(`Provider item ${key} changed after preview or the last recorded repair write; review live state before continuing`);
            }
          };
          const readLive = async (): Promise<ProviderObject|null> => {
            try { return side === "calendar" ? await clients.calendar.getEvent(id!) : await clients.todoist.getTask(id!); }
            catch (error) { if ([404,410].includes(Number((error as {status?:number}).status))) return null; throw error; }
          };
          if (write && key && Object.hasOwn(expected, key)) check(await readLive());
          let result: unknown;
          try { result = await Reflect.apply(value, target, args); }
          catch (error) {
            if (read && [404,410].includes(Number((error as {status?:number}).status))) check(null);
            throw error;
          }
          if (read) check(result as ProviderObject);
          if (write) {
            const object = method.startsWith("delete") ? null
              : (result as ProviderObject|undefined)?.id ? result as ProviderObject : id ? await readLive() : undefined;
            const resultId = object?.id || id;
            if (resultId && object !== undefined) {
              expected[entityKey({profile,side,id:resultId})] = object;
              if (side === "todoist" && object) {
                const destination = (Object.keys(profiles) as Profile[]).find(p => profiles[p].todoistProjectId === (object as TodoistTask).project_id);
                if (destination) expected[entityKey({profile:destination,side,id:resultId})] = object;
              }
              await save();
            }
          }
          return result;
        };
      },
    });
    return { calendar:wrap(clients.calendar,"calendar"), todoist:wrap(clients.todoist,"todoist") };
  };
}
