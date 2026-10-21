import { profiles } from "./config.js";
import type { ProviderClientFactory } from "./mutation-budget.js";
import { entityKey, type RepairOperation, type Side } from "./review-types.js";
import { reviewHash } from "./review-store.js";
import type { CalendarEvent, Profile, TodoistTask } from "./types.js";
import { hasCanonicalState, startsMatch, toTodoistTask } from "./sync.js";

type ProviderObject = CalendarEvent | TodoistTask;
const calendarWrites = new Set(["upsertEvent", "upsertEventIfUnchanged", "createFutureMasterOnce", "createRepairEventOnce", "deleteEvent"]);
const taskWrites = new Set(["upsertTask", "updateRecurringOccurrence", "createTaskOnce", "moveTask", "deleteTask"]);

/** Carry approved provider versions through our own writes and durable retries. */
export function guardRepairProviders(operation: RepairOperation, factory: ProviderClientFactory, save: () => Promise<void>): ProviderClientFactory {
  operation.expectedProviders ??= Object.fromEntries(operation.preview.snapshots.map(s => [entityKey(s.ref), s.object]));
  const expected = operation.expectedProviders;
  const creations = operation.creations ??= {};
  const move = operation.preview.intent;
  const approvedDestination = operation.preview.snapshots.find(s => s.ref.profile === move.profile && s.ref.side === "todoist" && s.ref.id === move.taskId)?.destination;
  const checkDestination = async (event?: CalendarEvent) => {
    if (move.action !== "move" || !move.targetProfile) return;
    if (!approvedDestination || approvedDestination.profile !== move.targetProfile) throw new Error("Move destination was not previewed; refresh the preview before moving");
    const created = event && Object.values(creations).some(c => c.profile === move.targetProfile && c.side === "calendar"
      && (c.result?.id === event.id || c.requestId === event.id && event.extendedProperties?.shared?.syncRepairId === operation.id));
    if (event?.id !== approvedDestination.eventId && !created) throw new Error("Move destination projection changed after preview; refresh the preview before moving or deleting the source");
    if (event) {
      const approved = expected[entityKey({profile:move.targetProfile,side:"calendar",id:event.id})];
      if (approved && reviewHash(approved) !== reviewHash(event)) throw new Error("Move destination provider state changed after preview or a recorded repair write");
    }
  };
  const recheckDestination = async () => {
    if (move.action === "move" && move.targetProfile && move.taskId) await checkDestination(await (await factory(move.targetProfile)).calendar.findByTodoistTaskId(move.taskId));
  };
  return async profile => {
    const clients = await factory(profile);
    const wrap = <T extends object>(provider: T, side: Side): T => new Proxy(provider, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        const method = String(property);
        if (side === "calendar" && method === "findByTodoistTaskId" && move.action === "move" && profile === move.targetProfile) {
          return async (taskId: string) => {
            const result = await Reflect.apply(value,target,[taskId]);
            if (taskId === move.taskId) await checkDestination(result);
            return result;
          };
        }
        const read = method === (side === "calendar" ? "getEvent" : "getTask");
        const write = (side === "calendar" ? calendarWrites : taskWrites).has(method);
        if (!read && !write) return value.bind(target);
        return async (...args: unknown[]) => {
          if (method === "moveTask" || side === "calendar" && method === "deleteEvent" && profile === move.profile) await recheckDestination();
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
          try {
            if ((method === "upsertTask" || method === "upsertEvent") && !args[1]) {
              const creationKey = `${profile}:${side}:${method}`;
              const fingerprint = reviewHash(args[0]);
              let creation = creations[creationKey];
              if (creation && creation.fingerprint !== fingerprint) throw new Error("Delegated creation input changed; review the repair before retrying");
              if (!creation) {
                creation = creations[creationKey] = {profile,side,fingerprint,requestId:reviewHash([operation.id,creationKey]).slice(0,32),startedAt:new Date().toISOString()};
                await save();
              }
              if (creation.result) {
                const live = side === "calendar" ? await clients.calendar.getEvent(creation.result.id) : await clients.todoist.getTask(creation.result.id);
                const approved = expected[entityKey({profile,side,id:live.id})] || creation.result;
                if (reviewHash(live) !== reviewHash(approved)) throw new Error("The previously created counterpart changed; review it before resuming");
                return live;
              }
              if (side === "todoist" && Date.now()-Date.parse(creation.startedAt) > 23*3600000) throw new Error("Delegated task creation acknowledgement is uncertain and its idempotency window expired; inspect provider state before retrying");
              result = side === "todoist"
                ? await clients.todoist.createTaskOnce(args[0] as TodoistTask,creation.requestId)
                : await clients.calendar.createRepairEventOnce({...args[0] as CalendarEvent,id:creation.requestId},operation.id);
              if (side === "calendar") {
                const desired=args[0] as CalendarEvent, actual=result as CalendarEvent;
                const rules=(event:CalendarEvent)=>(event.recurrence || []).map(rule=>rule.replace(/^RRULE:/,"").split(";").sort().join(";")).sort();
                if (!hasCanonicalState(actual,{...toTodoistTask(desired),id:actual.id})
                  || !startsMatch({id:actual.id,start:actual.end},{...toTodoistTask({...desired,start:desired.end}),id:actual.id})
                  || reviewHash(rules(actual)) !== reviewHash(rules(desired))
                  || Object.entries(desired.extendedProperties?.shared || {}).some(([name,value])=>actual.extendedProperties?.shared?.[name]!==value)) throw new Error("Previously created Calendar counterpart differs from the approved creation; inspect provider state before retrying");
              }
              creation.result = result as ProviderObject;
            } else result = await Reflect.apply(value, target, args);
          }
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
