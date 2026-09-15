import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { GoogleCredentials, Profile } from "./types.js";

export interface SyncProfileConfig {
  calendarId: string;
  channelId: string;
  todoistRoute: string;
  todoistProjectId: string;
}

const PROFILE_NAMES: Profile[] = ["home", "antonio", "work"];

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`SYNC_PROFILE_CONFIG_JSON is missing ${field}`);
  return value;
}

function loadProfiles(): Record<Profile, SyncProfileConfig> {
  const raw = process.env.SYNC_PROFILE_CONFIG_JSON;
  if (!raw) throw new Error("SYNC_PROFILE_CONFIG_JSON is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SYNC_PROFILE_CONFIG_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("SYNC_PROFILE_CONFIG_JSON must be an object");
  const source = parsed as Record<string, unknown>;
  return Object.fromEntries(PROFILE_NAMES.map((profile) => {
    const value = source[profile];
    if (!value || typeof value !== "object") throw new Error(`SYNC_PROFILE_CONFIG_JSON is missing ${profile}`);
    const entry = value as Record<string, unknown>;
    return [profile, {
      calendarId: requiredString(entry.calendarId, `${profile}.calendarId`),
      channelId: requiredString(entry.channelId, `${profile}.channelId`),
      todoistRoute: requiredString(entry.todoistRoute, `${profile}.todoistRoute`),
      todoistProjectId: requiredString(entry.todoistProjectId, `${profile}.todoistProjectId`),
    }];
  })) as Record<Profile, SyncProfileConfig>;
}

export const profiles = loadProfiles();

const channelProfiles = new Map(Object.entries(profiles).map(([profile, value]) => [value.channelId, profile as Profile]));
const routeProfiles = new Map(Object.entries(profiles).map(([profile, value]) => [value.todoistRoute, profile as Profile]));
const projectProfiles = new Map(Object.entries(profiles).map(([profile, value]) => [value.todoistProjectId, profile as Profile]));
const ssm = new SSMClient({});
const cache = new Map<string, Promise<string>>();
const todoistTokenProjects = new Map<string, string>();

export function profileForChannel(channelId: string | undefined): Profile | undefined {
  return channelId ? channelProfiles.get(channelId) : undefined;
}

export function configuredProfiles(): Profile[] {
  return PROFILE_NAMES.slice();
}

export function profileForTodoistRoute(route: string): Profile | undefined {
  return routeProfiles.get(route);
}

export function profileForTodoistProject(projectId: string | undefined): Profile | undefined {
  return projectId ? projectProfiles.get(projectId) : undefined;
}

export function rememberTodoistTokenProject(token: string, projectId: string): void {
  todoistTokenProjects.set(token, projectId);
}

export function todoistProjectForToken(token: string): string | undefined {
  return todoistTokenProjects.get(token);
}

export async function secureParameter(name: string): Promise<string> {
  if (!name) throw new Error("Secure parameter name is not configured");
  let pending = cache.get(name);
  if (!pending) {
    pending = ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
      .then((result) => {
        const value = result.Parameter?.Value;
        if (!value) throw new Error(`Secure parameter ${name} is empty`);
        return value;
      });
    cache.set(name, pending);
  }
  return pending;
}

export async function googleCredentials(profile: Profile): Promise<GoogleCredentials> {
  const prefix = process.env.GOOGLE_CREDENTIALS_PARAMETER_PREFIX || "/todoist-calendar-sync/google";
  const value = JSON.parse(await secureParameter(`${prefix}/${profile}`)) as Record<string, unknown>;
  if (typeof value.client_id === "string" && typeof value.client_secret === "string" && typeof value.refresh_token === "string") {
    return { client_id: value.client_id, client_secret: value.client_secret, refresh_token: value.refresh_token };
  }
  if (value.type === "service_account" && typeof value.client_email === "string" && typeof value.private_key === "string") {
    return {
      type: "service_account",
      client_email: value.client_email,
      private_key: value.private_key,
      ...(typeof value.token_uri === "string" ? { token_uri: value.token_uri } : {}),
    };
  }
  throw new Error(`Google credentials for ${profile} are incomplete`);
}

export async function todoistToken(profile: Profile): Promise<string> {
  const prefix = process.env.TODOIST_TOKEN_PARAMETER_PREFIX || "/todoist-calendar-sync/todoist";
  const token = await secureParameter(`${prefix}/${profile}`);
  rememberTodoistTokenProject(token, profiles[profile].todoistProjectId);
  return token;
}

export async function calendarWatchToken(): Promise<string> {
  return secureParameter(process.env.CALENDAR_WATCH_TOKEN_PARAMETER || "/todoist-calendar-sync/calendar-watch-token");
}

export async function todoistWebhookSecret(): Promise<string> {
  return secureParameter(process.env.TODOIST_WEBHOOK_SECRET_PARAMETER || "/todoist-calendar-sync/todoist-webhook-secret");
}

export async function proxySharedSecret(): Promise<string> {
  return secureParameter(process.env.PROXY_SHARED_SECRET_PARAMETER || "/todoist-calendar-sync/proxy-shared-secret");
}
