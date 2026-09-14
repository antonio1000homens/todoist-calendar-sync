import {
  DeleteCommand,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, pacedScan } from "./dynamodb-capacity.js";
import type { Profile } from "./types.js";

export type InterventionResponseMode = "off" | "observe" | "prompt" | "auto";
export type InterventionPolicyScope = "global" | "profile" | "series";

export interface InterventionPolicy {
  decisionType: string;
  scope: InterventionPolicyScope;
  mode: InterventionResponseMode;
  profile?: Profile;
  seriesId?: string;
  defaultAction?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EffectiveInterventionPolicy {
  mode: InterventionResponseMode;
  defaultAction?: string;
  source: "catalog" | InterventionPolicyScope;
  policy?: InterventionPolicy;
}

function tableName(): string {
  const value = process.env.STATE_TABLE_NAME;
  if (!value) throw new Error("STATE_TABLE_NAME is not configured");
  return value;
}

function policyPk(
  scope: InterventionPolicyScope,
  decisionType: string,
  profile?: Profile,
  seriesId?: string,
): string {
  if (scope === "global") return `POLICY#GLOBAL#${decisionType}`;
  if (!profile) throw new Error(`${scope} intervention policy requires profile`);
  if (scope === "profile") return `POLICY#PROFILE#${profile}#${decisionType}`;
  if (!seriesId) throw new Error("series intervention policy requires seriesId");
  return `POLICY#SERIES#${profile}#${seriesId}#${decisionType}`;
}

export class InterventionPolicyStore {
  async getExact(
    scope: InterventionPolicyScope,
    decisionType: string,
    profile?: Profile,
    seriesId?: string,
  ): Promise<InterventionPolicy | undefined> {
    const result = await documentClient.send(new GetCommand({
      TableName: tableName(),
      Key: { pk: policyPk(scope, decisionType, profile, seriesId), sk: "STATE" },
      ConsistentRead: true,
    }));
    return result.Item as InterventionPolicy | undefined;
  }

  async resolve(
    profile: Profile,
    decisionType: string,
    seriesId: string | undefined,
    catalogDefaultMode: InterventionResponseMode,
  ): Promise<EffectiveInterventionPolicy> {
    if (seriesId) {
      const series = await this.getExact("series", decisionType, profile, seriesId);
      if (series) return { mode: series.mode, defaultAction: series.defaultAction, source: "series", policy: series };
    }
    const profilePolicy = await this.getExact("profile", decisionType, profile);
    if (profilePolicy) return { mode: profilePolicy.mode, defaultAction: profilePolicy.defaultAction, source: "profile", policy: profilePolicy };
    const global = await this.getExact("global", decisionType);
    if (global) return { mode: global.mode, defaultAction: global.defaultAction, source: "global", policy: global };
    return { mode: catalogDefaultMode, source: "catalog" };
  }

  async put(input: Omit<InterventionPolicy, "updatedAt">): Promise<InterventionPolicy> {
    const policy: InterventionPolicy = { ...input, updatedAt: new Date().toISOString() };
    await documentClient.send(new PutCommand({
      TableName: tableName(),
      Item: {
        pk: policyPk(policy.scope, policy.decisionType, policy.profile, policy.seriesId),
        sk: "STATE",
        ...policy,
      },
    }));
    return policy;
  }

  async delete(
    scope: InterventionPolicyScope,
    decisionType: string,
    profile?: Profile,
    seriesId?: string,
  ): Promise<void> {
    await documentClient.send(new DeleteCommand({
      TableName: tableName(),
      Key: { pk: policyPk(scope, decisionType, profile, seriesId), sk: "STATE" },
    }));
  }

  async list(profile?: Profile): Promise<InterventionPolicy[]> {
    const result = await pacedScan<InterventionPolicy & { pk?: string; sk?: string }>({
      TableName: tableName(),
      FilterExpression: "begins_with(pk, :prefix)",
      ExpressionAttributeValues: { ":prefix": "POLICY#" },
    }, {
      operation: "list_intervention_policies",
      profile,
    });
    return result.items
      .filter((policy) => !profile || policy.scope === "global" || policy.profile === profile)
      .sort((a, b) => `${a.scope}:${a.decisionType}:${a.seriesId || ""}`.localeCompare(`${b.scope}:${b.decisionType}:${b.seriesId || ""}`));
  }
}
