import { profileForTodoistProject } from "./config.js";
import {
  calendarCanonicalIdentity,
  CanonicalIdentityStore,
  sameCanonicalIdentity,
  todoistCanonicalIdentity,
  type CanonicalIdentity,
  type CanonicalIdentityRepository,
} from "./canonical-identity.js";
import { defaultProviderClientFactory, type ProviderClientFactory, type ProviderClients } from "./mutation-budget.js";
import { ProjectAwareSynchronizer } from "./project-sync.js";
import { StateRepository } from "./repository.js";
import type { CalendarEvent, Delivery, Mapping, Profile, TodoistTask, TodoistWebhookPayload } from "./types.js";

type ScheduleOrphan = (delivery: Delivery, eventId: string, taskId: string) => Promise<void>;

type CalendarDelta = { items: CalendarEvent[]; nextSyncToken?: string };

function standaloneCalendarCandidate(event: CalendarEvent): boolean {
  if (event.status === "cancelled" || (event.status && event.status !== "confirmed")) return false;
  if (event.recurringEventId || event.recurrence?.length) return false;
  if (event.extendedProperties?.shared?.syncSource === "todoist-calendar-sync") return false;
  return Boolean(calendarCanonicalIdentity(event));
}

function standaloneTodoistCandidate(task: TodoistTask): boolean {
  if (task.is_completed || task.is_deleted || task.due?.is_recurring) return false;
  return Boolean(todoistCanonicalIdentity(task));
}

function taskIds(tasks: TodoistTask[]): string[] {
  return tasks.map((task) => task.id).sort();
}

function eventIds(events: CalendarEvent[]): string[] {
  return events.map((event) => event.id).sort();
}

function identityChanged(current: CanonicalIdentity | undefined, previous: CanonicalIdentity | undefined): boolean {
  return Boolean(current && previous && !sameCanonicalIdentity(current, previous));
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
    private readonly identities: CanonicalIdentityRepository = new CanonicalIdentityStore(),
  ) {}

  async process(delivery: Delivery): Promise<void> {
    if (delivery.kind === "calendar") return this.processCalendar(delivery);
    if (delivery.kind === "todoist") return this.processTodoist(delivery);
    return new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
  }

  private async eligibleTodoistMatches(profile: Profile, tasks: TodoistTask[], identity: CanonicalIdentity): Promise<TodoistTask[]> {
    const matching = tasks.filter((task) => standaloneTodoistCandidate(task) && sameCanonicalIdentity(todoistCanonicalIdentity(task), identity));
    const eligible: TodoistTask[] = [];
    for (const task of matching) {
      const existing = await this.state.getMappingByTaskAnyProfile(task.id);
      if (!existing) eligible.push(task);
    }
    return eligible;
  }

  private async eligibleCalendarMatches(profile: Profile, events: CalendarEvent[], identity: CanonicalIdentity): Promise<CalendarEvent[]> {
    const matching = events.filter((event) => standaloneCalendarCandidate(event) && sameCanonicalIdentity(calendarCanonicalIdentity(event), identity));
    const eligible: CalendarEvent[] = [];
    for (const event of matching) {
      const existing = await this.state.getMappingByEvent(profile, event.id);
      if (!existing) eligible.push(event);
    }
    return eligible;
  }

  private async seedCalendarIdentityFromMappedTask(profile: Profile, event: CalendarEvent, mapping: Mapping, clients: ProviderClients): Promise<void> {
    if (mapping.recurrenceOwner || event.recurringEventId || event.recurrence?.length) return;
    const existing = await this.identities.get(profile, "calendar", event.id);
    if (existing) return;
    try {
      const task = await clients.todoist.getTask(mapping.taskId);
      const prior = todoistCanonicalIdentity(task);
      if (!prior) return;
      await this.identities.put(profile, "calendar", event.id, prior);
      await this.identities.put(profile, "todoist", task.id, prior);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 404) throw error;
    }
  }

  private async rememberCalendarResult(profile: Profile, event: CalendarEvent, clients: ProviderClients): Promise<void> {
    if (!standaloneCalendarCandidate(event)) return;
    const mapping = await this.state.getMappingByEvent(profile, event.id);
    if (!mapping || mapping.recurrenceOwner) return;
    const eventIdentity = calendarCanonicalIdentity(event);
    if (eventIdentity) await this.identities.put(profile, "calendar", event.id, eventIdentity);
    try {
      const task = await clients.todoist.getTask(mapping.taskId);
      const taskIdentity = todoistCanonicalIdentity(task);
      if (taskIdentity) await this.identities.put(profile, "todoist", task.id, taskIdentity);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 404) throw error;
    }
  }

  private async processCalendar(delivery: Delivery): Promise<void> {
    const token = await this.state.getSyncToken(delivery.profile);
    if (!token) {
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    const clients = await this.clientFactory(delivery.profile);
    let delta: CalendarDelta;
    try {
      delta = await clients.calendar.listDelta(token);
    } catch (error) {
      if (Number((error as { status?: number }).status) !== 410) throw error;
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    let tasks: TodoistTask[] | undefined;
    const blockedEventIds = new Set<string>();

    for (const event of delta.items) {
      if (!standaloneCalendarCandidate(event)) continue;
      const mapping = await this.state.getMappingByEvent(delivery.profile, event.id);
      if (mapping) {
        await this.seedCalendarIdentityFromMappedTask(delivery.profile, event, mapping, clients);
        continue;
      }
      // Exact embedded provider identity remains higher confidence than any
      // canonical-title/start inference and is handled by the normal synchronizer.
      if (event.extendedProperties?.shared?.taskId) continue;

      const currentIdentity = calendarCanonicalIdentity(event);
      if (!currentIdentity) continue;
      tasks ||= await clients.todoist.listTasks();

      const currentMatches = await this.eligibleTodoistMatches(delivery.profile, tasks, currentIdentity);
      if (currentMatches.length > 1) {
        blockedEventIds.add(event.id);
        await this.state.audit(delivery.profile, "calendar_snapshot_unmapped_ambiguous", {
          eventId: event.id,
          source: "webhook_current_identity",
          candidateTaskIds: taskIds(currentMatches),
          identity: currentIdentity,
        });
        continue;
      }
      if (currentMatches.length === 1) {
        const task = currentMatches[0];
        await this.state.putMapping({
          profile: delivery.profile,
          eventId: event.id,
          taskId: task.id,
          projectId: task.project_id,
          updatedAt: new Date().toISOString(),
        });
        await this.state.audit(delivery.profile, "calendar_orphan_todoist_rebound_current_identity", {
          eventId: event.id,
          taskId: task.id,
        });
        continue;
      }

      const previousRecord = await this.identities.get(delivery.profile, "calendar", event.id);
      const previousIdentity = previousRecord?.identity;
      if (!previousIdentity || !identityChanged(currentIdentity, previousIdentity)) continue;
      const historicalMatches = await this.eligibleTodoistMatches(delivery.profile, tasks, previousIdentity);
      if (historicalMatches.length > 1) {
        blockedEventIds.add(event.id);
        await this.state.audit(delivery.profile, "calendar_snapshot_unmapped_ambiguous", {
          eventId: event.id,
          source: "webhook_previous_identity",
          candidateTaskIds: taskIds(historicalMatches),
          previousIdentity,
          currentIdentity,
        });
        continue;
      }
      if (historicalMatches.length === 1) {
        const task = historicalMatches[0];
        await this.state.putMapping({
          profile: delivery.profile,
          eventId: event.id,
          taskId: task.id,
          projectId: task.project_id,
          updatedAt: new Date().toISOString(),
        });
        await this.state.audit(delivery.profile, "calendar_orphan_todoist_rebound_previous_identity", {
          eventId: event.id,
          taskId: task.id,
          previousIdentity,
          currentIdentity,
        });
      }
    }

    const filteredClients: ProviderClientFactory = async (profile) => {
      if (profile !== delivery.profile) return this.clientFactory(profile);
      return {
        ...clients,
        calendar: proxiedCalendarWithDelta(clients, token, delta, blockedEventIds),
      };
    };
    await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, filteredClients).process(delivery);

    for (const event of delta.items) {
      if (blockedEventIds.has(event.id)) continue;
      await this.rememberCalendarResult(delivery.profile, event, clients);
    }
  }

  private async seedTodoistIdentityFromMappedCalendar(profile: Profile, task: TodoistTask, mapping: Mapping, clients: ProviderClients): Promise<void> {
    if (mapping.recurrenceOwner || task.due?.is_recurring) return;
    const existing = await this.identities.get(profile, "todoist", task.id);
    if (existing) return;
    try {
      const event = await clients.calendar.getEvent(mapping.eventId);
      const prior = calendarCanonicalIdentity(event);
      if (!prior) return;
      await this.identities.put(profile, "todoist", task.id, prior);
      await this.identities.put(profile, "calendar", event.id, prior);
    } catch (error) {
      if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
    }
  }

  private async rememberTodoistResult(task: TodoistTask): Promise<void> {
    const mapping = await this.state.getMappingByTaskAnyProfile(task.id);
    if (!mapping || mapping.recurrenceOwner) return;
    const clients = await this.clientFactory(mapping.profile);
    const taskIdentity = todoistCanonicalIdentity(task);
    if (taskIdentity) await this.identities.put(mapping.profile, "todoist", task.id, taskIdentity);
    try {
      const event = await clients.calendar.getEvent(mapping.eventId);
      const eventIdentity = calendarCanonicalIdentity(event);
      if (eventIdentity) await this.identities.put(mapping.profile, "calendar", event.id, eventIdentity);
    } catch (error) {
      if (![404, 410].includes(Number((error as { status?: number }).status))) throw error;
    }
  }

  private async processTodoist(delivery: Delivery): Promise<void> {
    const payload = JSON.parse(delivery.body) as TodoistWebhookPayload;
    const task = payload.event_data;
    if (!task?.id) {
      await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
      return;
    }

    let mapping = await this.state.getMappingByTaskAnyProfile(task.id);
    const targetProfile = mapping?.profile || profileForTodoistProject(task.project_id) || delivery.profile;
    const clients = await this.clientFactory(targetProfile);

    if (mapping) {
      await this.seedTodoistIdentityFromMappedCalendar(targetProfile, task, mapping, clients);
    } else if (standaloneTodoistCandidate(task)) {
      const exact = await clients.calendar.findByTodoistTaskId(task.id);
      if (exact?.status !== "cancelled" && exact) {
        mapping = {
          profile: targetProfile,
          eventId: exact.id,
          taskId: task.id,
          projectId: task.project_id,
          updatedAt: new Date().toISOString(),
        };
        await this.state.putMapping(mapping);
        await this.state.audit(targetProfile, "todoist_orphan_calendar_rebound_provider_identity", {
          taskId: task.id,
          eventId: exact.id,
        });
      } else if (!exact) {
        const snapshot = await clients.calendar.listDelta();
        const currentIdentity = todoistCanonicalIdentity(task)!;
        const currentMatches = await this.eligibleCalendarMatches(targetProfile, snapshot.items, currentIdentity);
        if (currentMatches.length > 1) {
          await this.state.audit(targetProfile, "todoist_orphan_recovery_ambiguous", {
            taskId: task.id,
            source: "webhook_current_identity",
            candidateEventIds: eventIds(currentMatches),
            identity: currentIdentity,
          });
          return;
        }
        if (currentMatches.length === 1) {
          const event = currentMatches[0];
          mapping = {
            profile: targetProfile,
            eventId: event.id,
            taskId: task.id,
            projectId: task.project_id,
            updatedAt: new Date().toISOString(),
          };
          await this.state.putMapping(mapping);
          await this.state.audit(targetProfile, "todoist_orphan_calendar_rebound_current_identity", {
            taskId: task.id,
            eventId: event.id,
          });
        } else {
          const oldItemIdentity = todoistCanonicalIdentity(payload.event_data_extra?.old_item as TodoistTask);
          const storedIdentity = (await this.identities.get(targetProfile, "todoist", task.id))?.identity;
          const previousIdentity = oldItemIdentity || storedIdentity;
          if (previousIdentity && identityChanged(currentIdentity, previousIdentity)) {
            const historicalMatches = await this.eligibleCalendarMatches(targetProfile, snapshot.items, previousIdentity);
            if (historicalMatches.length > 1) {
              await this.state.audit(targetProfile, "todoist_orphan_recovery_ambiguous", {
                taskId: task.id,
                source: oldItemIdentity ? "webhook_old_item" : "persisted_previous_identity",
                candidateEventIds: eventIds(historicalMatches),
                previousIdentity,
                currentIdentity,
              });
              return;
            }
            if (historicalMatches.length === 1) {
              const event = historicalMatches[0];
              mapping = {
                profile: targetProfile,
                eventId: event.id,
                taskId: task.id,
                projectId: task.project_id,
                updatedAt: new Date().toISOString(),
              };
              await this.state.putMapping(mapping);
              await this.state.audit(targetProfile, "todoist_orphan_calendar_rebound_previous_identity", {
                taskId: task.id,
                eventId: event.id,
                previousIdentity,
                currentIdentity,
                source: oldItemIdentity ? "webhook_old_item" : "persisted_previous_identity",
              });
            }
          }
        }
      }
    }

    await new ProjectAwareSynchronizer(this.state, this.scheduleOrphan, this.clientFactory).process(delivery);
    await this.rememberTodoistResult(task);
  }
}
