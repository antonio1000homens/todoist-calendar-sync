import { profileForTodoistProject, profiles } from "./config.js";
import { defaultProviderClientFactory, type ProviderClientFactory, type ProviderClients } from "./mutation-budget.js";
import { acquireMoveWriterLeases, ProjectAwareSynchronizer } from "./project-sync.js";
import { StateRepository } from "./repository.js";
import { ignorableElapsedStandaloneCalendarEvent, Synchronizer, todoistCalendarLifecycle } from "./sync.js";
import { hasGuardedRecoveryDispatchCandidate } from "./guarded-recovery-dispatch.js";
import type { CalendarEvent, Delivery, Mapping, Profile, TodoistTask, TodoistWebhookPayload } from "./types.js";

type ScheduleOrphan = (delivery: Delivery, eventId: string, taskId: string) => Promise<void>;

type CalendarDelta = { items: CalendarEvent[]; nextSyncToken?: string };

function standaloneCalendarShape(event: CalendarEvent): boolean {
  if (event.status === "cancelled" || (event.status && event.status !== "confirmed")) return false;
  if (event.recurringEventId || event.recurrence?.length) return false;
  return Boolean(event.start?.date || event.start?.dateTime);
}

function standaloneCalendarSource(event: CalendarEvent): boolean {
  if (!standaloneCalendarShape(event)) return false;
  const shared = event.extendedProperties?.shared;
  return shared?.syncSource !== "todoist-calendar-sync" && !shared?.taskId;
}

function standaloneTodoistCandidate(task: TodoistTask): boolean {
  if (task.is_completed || task.is_deleted || task.due?.is_recurring) return false;
  return Boolean(task.due?.date || task.due?.datetime);
}

function proxiedCalendarWithDelta(clients: ProviderClients, token: string, delta: CalendarDelta, blockedEventIds: Set<string>): ProviderClients["calendar"] {
  const filtered: CalendarDelta = {
    ...delta,
    items: delta.items.filter((event) => !blockedEventIds.has(event.id)),
  };
  return new Proxy(clients.calendar, {
    get(target, property, receiver) {
      if (property === "listDelta") {
        return async (requestedToken?: string): Promise<CalendarDelta> => {
          if (requestedToken === token) return filtered;
          return target.listDelta(requestedToken);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class OrphanRecoveringSynchronizer {
  constructor(
    private readonly state = new StateRepository(),
    private readonly scheduleOrphan?: ScheduleOrphan,
    private readonly clientFactory: ProviderClientFactory = defaultProviderClientFactory,
  ) {}

  private async clients(profile: Profile): Promise<ProviderClients> {
    return this.clientFactory(profile);
  }

  private async persistMapping(mapping: Mapping, clients: ProviderClients): Promise<Mapping> {
    const synchronizer = new Synchronizer(this.state, this.scheduleOrphan, async () => clients);
    return synchronizer.persistProviderMapping(mapping, clients.todoist);
  }

  private async mappingByEvent(profile: Profile, eventId: string): Promise<Mapping | undefined> {
    return new Synchronizer(this.state, this.scheduleOrphan, this.clientFactory).providerMappingByEvent(profile, eventId);
  }

  private async mappingByTask(taskId: string): Promise<Mapping | undefined> {
    return new Synchronizer(this.state, this.scheduleOrphan, this.clientFactory).providerMappingByTaskAnyProfile(taskId);
  }

  async process(delivery: Delivery): Promise<void> {
    if (delivery.kind === "calendar") return this.processCalendar(delivery);
    if (delivery.kind === "todoist") return this.processTodoist(delivery);
    return new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
  }

  private async processCalendar(delivery: Delivery): Promise<void> {
    const token = await this.state.getSyncToken(delivery.profile);
    if (!token) {
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    const clients = await this.clients(delivery.profile);
    let delta: CalendarDelta;
    try {
      delta = await clients.calendar.listDelta(token);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 410) throw error;
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    const blockedEventIds = new Set<string>();
    const ignoredHistoryEventIds = new Set<string>();
    const now = Date.now();
    let calendarTimeZone: string | undefined;

    for (const event of delta.items) {
      // The delegated synchronizer will still receive this delta and advance
      // its sync cursor; only skip orphan/identity lookups for proven history.
      if (event.extendedProperties?.shared?.syncHistoryOnly === "true") {
        ignoredHistoryEventIds.add(event.id);
        continue;
      }
      if (event.status === "confirmed" && !event.recurringEventId && !event.recurrence?.length
          && event.end?.date && !event.end.dateTime && !calendarTimeZone && clients.calendar.getTimeZone) {
        try { calendarTimeZone = await clients.calendar.getTimeZone(); }
        catch { /* Missing timezone must fail open into ordinary ownership checks. */ }
      }
      if (ignorableElapsedStandaloneCalendarEvent(event, now, calendarTimeZone)) {
        ignoredHistoryEventIds.add(event.id);
        continue;
      }
      const currentMapping = await this.mappingByEvent(delivery.profile, event.id);
      if (await this.state.syncBlocked(delivery.profile, { eventId: event.id, taskId: currentMapping?.taskId || event.extendedProperties?.shared?.taskId })) {
        blockedEventIds.add(event.id);
        continue;
      }
      if (!standaloneCalendarSource(event)) continue;
      // No amount of title/date similarity can reassign a completed event.
      // The permanent event-keyed completion guard survives cleanup of its
      // task-keyed lookup after seven days.
      if (await this.state.getCompletedCalendarProjectionByEvent?.(delivery.profile, event.id)) continue;
      const mapping = await this.mappingByEvent(delivery.profile, event.id);
      if (mapping) continue;
    }

    const filteredClients: ProviderClientFactory = async (profile) => {
      if (profile !== delivery.profile) return this.clients(profile);
      return {
        ...clients,
        calendar: proxiedCalendarWithDelta(clients, token, delta, blockedEventIds),
      };
    };
    await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, filteredClients).process(delivery);

    // Do not create canonical title/date identity rows. Future recovery must
    // come from an exact provider ID or surviving provider metadata.
  }

  private async processTodoist(delivery: Delivery): Promise<void> {
    let payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    let task = payload.event_data;
    if (!task?.id) {
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    const sourceProfile = profileForTodoistProject(task.project_id) || delivery.profile;

    // Validate an otherwise-unmapped upsert against Todoist before orphan
    // recovery or project-transition logic can write mappings/projections.
    // Delayed webhook bodies outlive item purges, so a payload alone cannot be
    // treated as proof that its source item still exists. Use the fresh item as
    // the input to every later recovery/projection decision.
    if (todoistCalendarLifecycle(payload)?.action === "upsert"
      && !await this.mappingByTask(task.id)) {
      const lookupProfile = profileForTodoistProject(task.project_id) || delivery.profile;
      const { todoist } = await this.clients(lookupProfile);
      try {
        const currentTask = await todoist.getTask(task.id);
        if (currentTask.id !== task.id) throw new Error("Todoist returned a different task identity for an unmapped webhook");
        task = currentTask;
        payload = { ...payload, event_data: currentTask };
        // Preserve the signed item:added source separately from this fresh GET
        // when Phase B admission is opted in. Replacing the delivery body with
        // currentTask would make the supposedly independent evidence identical
        // and could promote an already-advanced/edited recurrence.
        if (payload.event_name !== "item:added") {
          delivery = { ...delivery, body: JSON.stringify(payload) };
        }
      } catch (error) {
        if (Number((error as { status?: number }).status) === 404) return;
        throw error;
      }
    }

    const directMapping = await this.mappingByTask(task.id);
    const controlProfile=directMapping?.profile || profileForTodoistProject(task.project_id) || delivery.profile;
    if (await this.state.syncBlocked(controlProfile,{taskId:task.id})) {
      const recoverable=await hasGuardedRecoveryDispatchCandidate({
        profile:controlProfile,mapping:directMapping,sourceTask:task,
        action:todoistCalendarLifecycle(payload)?.action,
        getExactRepairLock:(profile,id)=>this.state.getCancelledAnnualRecoveryLock(profile,id),
      });
      if (recoverable) {
        // The project-aware layer will independently route this same mapped
        // identity to the final Synchronizer. Only its guarded transaction can
        // release a repair; this outer layer never changes ownership itself.
        await this.state.audit(controlProfile,"todoist_preflight_guarded_recovery_routed",{
          taskId:task.id,eventId:directMapping?.eventId,
        });
        return new ProjectAwareSynchronizer(this.state,this.scheduleOrphan,this.clientFactory).process(delivery);
      }
      // Do not silently ACK an unexamined blocked update. Ordinary conflicts
      // are still blocked, but leave an observable diagnostic.
      return this.state.audit(controlProfile,"todoist_preflight_sync_control_blocked",{
        taskId:task.id,eventId:directMapping?.eventId,
      });
    }

    let mapping = await this.mappingByTask(task.id);
    const targetProfile = mapping?.profile || profileForTodoistProject(task.project_id) || delivery.profile;
    const releaseTargetWriter = await acquireMoveWriterLeases([targetProfile], delivery.profile);
    try {
    const clients = await this.clients(targetProfile);

    if (!mapping && standaloneTodoistCandidate(task)) {
      const exact = await clients.calendar.findByTodoistTaskId(task.id);
      if (exact?.status !== "cancelled" && exact) {
        // Provider breadcrumbs remain after a completion, but they do not
        // authorise restoring its retired active mapping. Completion and
        // uncompletion do not mutate Calendar, even for the same task ID.
        if (await this.state.getCompletedCalendarProjectionByEvent?.(targetProfile, exact.id)) {
          await this.state.audit(targetProfile, "todoist_completed_calendar_identity_not_rebound", {
            taskId: task.id, eventId: exact.id,
          });
          return;
        }
        if (await this.state.syncBlocked(targetProfile, { taskId: task.id, eventId: exact.id })) return;
        mapping = {
          profile: targetProfile,
          eventId: exact.id,
          taskId: task.id,
          projectId: task.project_id,
          updatedAt: new Date().toISOString(),
        };
        await this.persistMapping(mapping, clients);
        await this.state.audit(targetProfile, "todoist_orphan_calendar_rebound_provider_identity", {
          taskId: task.id,
          eventId: exact.id,
        });
      }
    }

    await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
    } finally {
      await releaseTargetWriter();
    }
  }
}
