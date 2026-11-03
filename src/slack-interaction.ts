import { MANUAL_DECISION_CATALOG, type ManualDecisionType } from "./manual-intervention.js";
import type { Delivery, ManualControlDelivery, ManualPolicyControl, Profile, SlackInteractionEnvelope } from "./types.js";

const profiles: readonly Profile[] = ["home", "antonio", "work"];
const modes = new Set(["off", "observe", "prompt", "auto"]);
const scopes = new Set(["global", "profile", "series"]);
const decisionTypes = new Set(Object.keys(MANUAL_DECISION_CATALOG));
const maxCommandBytes = 2048;
const maxValueBytes = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maxBytes = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid Slack interaction ${name}`);
  }
  return value;
}

function asProfile(value: unknown): Profile | undefined {
  return typeof value === "string" && profiles.includes(value as Profile) ? value as Profile : undefined;
}

function decisionProfile(value: string): Profile | undefined {
  return profiles.find((profile) => value.startsWith(`${profile}-`));
}

function invalid(): ManualControlDelivery {
  return { command: "invalid_request" };
}

function parsePolicyCommand(args: string[]): { profile: Profile; manual: ManualControlDelivery } | undefined {
  let operation: "set_policy" | "clear_policy" = "set_policy";
  if (args[0]?.toLowerCase() === "reset") {
    operation = "clear_policy";
    args.shift();
  }

  let scope: ManualPolicyControl["scope"] = "profile";
  let profile: Profile | undefined;
  let seriesId: string | undefined;
  if (args[0]?.toLowerCase() === "series") {
    scope = "series";
    args.shift();
    profile = asProfile(args.shift());
    seriesId = args.shift();
    if (!profile || !seriesId) return undefined;
  } else {
    const scopeToken = (args.shift() || "").toLowerCase();
    if (scopeToken === "global") {
      scope = "global";
      profile = "antonio";
    } else {
      profile = asProfile(scopeToken);
      if (!profile) return undefined;
    }
  }

  const decisionType = args.shift();
  if (!decisionType || !decisionTypes.has(decisionType)) return undefined;
  if (operation === "clear_policy") {
    const policy: ManualPolicyControl = { decisionType, scope, ...(seriesId ? { seriesId } : {}) };
    return { profile, manual: { command: operation, targetType: "policy", targetId: decisionType, policy } };
  }

  const mode = (args.shift() || "").toLowerCase();
  if (!modes.has(mode)) return undefined;
  const defaultAction = args.shift();
  if (mode === "auto" && !defaultAction) return undefined;
  const policy: ManualPolicyControl = {
    decisionType,
    scope,
    mode: mode as ManualPolicyControl["mode"],
    ...(defaultAction ? { defaultAction } : {}),
    ...(seriesId ? { seriesId } : {}),
  };
  return { profile, manual: { command: operation, targetType: "policy", targetId: decisionType, policy } };
}

function parseSlashCommand(text: string, routeProfile: Profile): ManualControlDelivery {
  if (Buffer.byteLength(text, "utf8") > maxCommandBytes) return invalid();
  const args = text.trim().split(/\s+/).filter(Boolean);
  const verb = (args.shift() || "").toLowerCase();
  if (!verb || verb === "help") return { command: "help", message: SLACK_INTERACTION_USAGE };

  if (verb === "status" || verb === "reconcile") {
    const profile = asProfile(args[0]);
    if (!profile || profile !== routeProfile) return invalid();
    return { command: verb === "status" ? "show_status" : "reconcile_now", targetType: "profile", targetId: profile };
  }
  if (verb === "conflicts") {
    const profile = args[0] ? asProfile(args[0]) : routeProfile;
    if (!profile || profile !== routeProfile) return invalid();
    return { command: "list_conflicts", targetType: "profile", targetId: profile };
  }
  if (verb === "inspect") {
    const targetType = (args.shift() || "").toLowerCase();
    const targetId = args.shift();
    if (!["task", "event", "decision"].includes(targetType) || !targetId) return invalid();
    const profile = targetType === "decision" ? decisionProfile(targetId) : asProfile(args.shift());
    if (!profile || profile !== routeProfile) return invalid();
    return { command: "inspect_mapping", targetType: targetType as "task" | "event" | "decision", targetId };
  }
  if (verb === "resume") {
    const target = args.shift();
    if (!target) return invalid();
    const profile = asProfile(target) || decisionProfile(target);
    if (!profile || profile !== routeProfile) return invalid();
    return asProfile(target)
      ? { command: "resume_pending_reconciliation", targetType: "profile", targetId: target }
      : { command: "resume_decision", targetType: "decision", targetId: target };
  }
  if (verb === "policies") {
    const profile = asProfile(args.shift());
    if (!profile || profile !== routeProfile) return invalid();
    return { command: "list_policies", targetType: "policy", targetId: profile };
  }
  if (verb === "policy") {
    const parsed = parsePolicyCommand(args);
    if (!parsed || parsed.profile !== routeProfile) return invalid();
    return parsed.manual;
  }
  return invalid();
}

function parsePolicyButton(value: Record<string, unknown>, routeProfile: Profile): ManualControlDelivery | undefined {
  const profile = asProfile(value.profile);
  const decisionType = typeof value.decisionType === "string" ? value.decisionType : "";
  const scope = typeof value.policyScope === "string" ? value.policyScope : "";
  const operation = value.policyOperation === "clear" ? "clear_policy" : value.policyOperation === "set" ? "set_policy" : undefined;
  if (!profile || profile !== routeProfile || !decisionTypes.has(decisionType) || !scopes.has(scope) || !operation) return undefined;
  const mode = typeof value.policyMode === "string" ? value.policyMode : undefined;
  if (operation === "set_policy" && (!mode || !modes.has(mode))) return undefined;
  const defaultAction = typeof value.policyAction === "string" ? value.policyAction : undefined;
  const seriesId = typeof value.seriesId === "string" ? value.seriesId : undefined;
  if (scope === "series" && !seriesId) return undefined;
  if (mode === "auto" && !defaultAction) return undefined;
  const policy: ManualPolicyControl = {
    decisionType,
    scope: scope as ManualPolicyControl["scope"],
    ...(mode ? { mode: mode as ManualPolicyControl["mode"] } : {}),
    ...(defaultAction ? { defaultAction } : {}),
    ...(seriesId ? { seriesId } : {}),
  };
  return { command: operation, targetType: "policy", targetId: decisionType, policy };
}

function parseBlockAction(interaction: SlackInteractionEnvelope, routeProfile: Profile): ManualControlDelivery {
  const actionId = interaction.actionId || "";
  const value = interaction.value;
  if (actionId === "gcp_sync_confirmation_cancel") {
    const decisionId = typeof value?.decisionId === "string" ? value.decisionId : "";
    const profile = asProfile(value?.profile);
    if (!decisionId || profile !== routeProfile || decisionProfile(decisionId) !== routeProfile) return invalid();
    return { command: "cancel_confirmation", targetType: "decision", targetId: decisionId };
  }
  if (actionId === "gcp_sync_policy" || actionId.startsWith("gcp_sync_policy_")) {
    return value ? parsePolicyButton(value, routeProfile) || invalid() : invalid();
  }
  if (actionId.startsWith("gcp_sync_decision_") || actionId === "gcp_sync_decision_confirm") {
    const profile = asProfile(value?.profile);
    const decisionId = typeof value?.decisionId === "string" ? value.decisionId : "";
    const action = typeof value?.action === "string" ? value.action : "";
    if (!value || profile !== routeProfile || decisionProfile(decisionId) !== routeProfile || !action) return invalid();
    if (value.confirmRequired === true && value.confirmed !== true) {
      if (!interaction.channelId || !interaction.messageTs) return invalid();
      return { command: "confirm_legacy_action", targetType: "decision", targetId: decisionId, action };
    }
    return { decisionId, action };
  }
  return invalid();
}

/** Converts the ingress-only envelope to the existing domain-owned manual delivery. */
export function decodeSlackInteractionDelivery(delivery: Delivery): Delivery {
  if (delivery.kind !== "manual" || !isRecord(delivery.slackInteraction)) throw new Error("Invalid Slack interaction delivery");
  const value = delivery.slackInteraction as unknown as SlackInteractionEnvelope;
  if (value.schemaVersion !== 1 || value.command !== "/sync" || !profiles.includes(delivery.profile)) throw new Error("Unsupported Slack interaction envelope");
  const userId = boundedString(value.userId, "user ID", 128);
  const requestTimestamp = boundedString(value.requestTimestamp, "timestamp", 32);
  if (!userId || !requestTimestamp) throw new Error("Slack interaction is missing required identity metadata");
  const channelId = boundedString(value.channelId, "channel ID", 128);
  const messageTs = boundedString(value.messageTs, "message timestamp", 32);
  let manual: ManualControlDelivery;
  if (value.type === "slash_command") {
    const commandText = boundedString(value.commandText, "command text", maxCommandBytes);
    if (commandText === undefined) throw new Error("Slack command text is required");
    manual = parseSlashCommand(commandText, delivery.profile);
  } else if (value.type === "block_action") {
    const actionId = boundedString(value.actionId, "action ID", 128);
    if (!actionId) throw new Error("Slack action ID is required");
    if (value.value !== undefined && (!isRecord(value.value) || Buffer.byteLength(JSON.stringify(value.value), "utf8") > maxValueBytes)) {
      throw new Error("Invalid Slack action value");
    }
    manual = parseBlockAction({ ...value, actionId, channelId, messageTs }, delivery.profile);
  } else {
    throw new Error("Unsupported Slack interaction type");
  }

  manual.slackUserId = userId;
  if (channelId) manual.slackChannelId = channelId;
  if (messageTs) manual.slackMessageTs = messageTs;
  return { ...delivery, manual, slackInteraction: undefined };
}

export function isSlackControlUserAllowed(userId: string, allowlist = process.env.SLACK_CONTROL_ALLOWED_USER_IDS || ""): boolean {
  const allowed = new Set(allowlist.split(",").map((id) => id.trim()).filter(Boolean));
  return allowed.size === 0 || allowed.has(userId);
}

export const SLACK_INTERACTION_USAGE = [
  "*todoist-calendar-sync manual controls*",
  "`/sync status <home|antonio|work>`",
  "`/sync reconcile <home|antonio|work>`",
  "`/sync conflicts [home|antonio|work]`",
  "`/sync inspect task <id> <profile>`",
  "`/sync inspect event <id> <profile>`",
  "`/sync inspect decision <decisionId>`",
  "`/sync resume <profile|decisionId>`",
  "`/sync policies <home|antonio|work>`",
  "`/sync policy <profile|global> <decisionType> <off|observe|prompt|auto> [action]`",
  "`/sync policy series <profile> <seriesId> <decisionType> <off|observe|prompt|auto> [action]`",
  "`/sync policy reset <profile|global> <decisionType>`",
  "`/sync policy reset series <profile> <seriesId> <decisionType>`",
].join("\n");

export function isKnownManualDecisionType(value: string): value is ManualDecisionType {
  return decisionTypes.has(value);
}
