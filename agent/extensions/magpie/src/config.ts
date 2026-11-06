/**
 * magpie.json: toggles only. The gateway URL and key are stored in Pi's auth
 * store, written by `/login`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PROVIDER_ID = "magpie";

export const FEATURES = [
  "catalog",
  "costs",
  "thinkingLevels",
  "sessionAffinity",
  "systemone",
  "images",
  "statusline",
  "route",
  "mcpHub",
  "mcpServers",
] as const;

export type Feature = (typeof FEATURES)[number];

export type Features = Record<Feature, boolean>;

export const FEATURE_LABELS: Record<Feature, string> = {
  catalog: "chat models",
  costs: "prices and costs",
  thinkingLevels: "thinking levels",
  sessionAffinity: "session headers",
  systemone: "classifier models",
  images: "image models",
  statusline: "status line",
  route: "route line",
  mcpHub: "MCP router",
  mcpServers: "magpie's MCP servers",
};

export const FEATURE_HELP: Record<Feature, string> = {
  catalog: "Offer the gateway's chat models as Pi models, under the provider 'magpie'.",
  costs: "Ask the gateway for each model's price so Pi counts what a call costs (only told to a caller magpie is shared with).",
  thinkingLevels: "Map Pi's thinking levels to the model's own, from the levels the catalog lists.",
  sessionAffinity: "Send x-session-affinity and session_id, so magpie groups a Pi session as one conversation.",
  systemone: "Register magpie's decision models as Pi classifier models, for codemode's classify().",
  images: "Register magpie's image models as Pi image models, for generateImages().",
  statusline: "Draw magpie's own status line in Pi's footer: the accounts of the model in use.",
  route: "Add the model and effort that answered the last turn to the footer row.",
  mcpHub: "Give Pi magpie's MCP router as one MCP server, so it reaches the Library's servers too.",
  mcpServers: "Give Pi each of magpie's own MCP servers (web search, vision, images, plugin tools) separately.",
};

export const DEFAULT_FEATURES: Features = {
  catalog: true,
  costs: true,
  thinkingLevels: true,
  sessionAffinity: true,
  systemone: true,
  images: true,
  statusline: true,
  route: true,
  mcpHub: false,
  mcpServers: false,
};

export type McpExposure = "codemode" | "deferred" | "direct";

export function exposureOf(value: unknown): McpExposure {
  return value === "deferred" || value === "direct" ? value : "codemode";
}

export function allFeatures(on: boolean): Features {
  const features: Features = { ...DEFAULT_FEATURES };
  for (const name of FEATURES) features[name] = on;
  return features;
}

export interface MagpieConfig {
  version: 1;
  features: Features;
  statuslineSeconds: number;
  exposure: McpExposure;
}

export const DEFAULT_CONFIG: MagpieConfig = {
  version: 1,
  features: { ...DEFAULT_FEATURES },
  statuslineSeconds: 30,
  exposure: "codemode",
};

/** PI_CODING_AGENT_DIR (a leading ~ is expanded), else ~/.pi/agent. */
export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    return configured.startsWith("~")
      ? path.join(homedir(), configured.slice(1))
      : path.resolve(configured);
  }
  return path.join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return path.join(agentDir(), "magpie.json");
}

export function modelFeaturesOn(features: Features): boolean {
  return features.catalog || features.systemone || features.images;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Unknown keys are kept. Defaults are used when the file is missing or
 * unparseable, or when statuslineSeconds is under 5.
 */
export function readConfig(): MagpieConfig {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    raw = isRecord(parsed) ? parsed : {};
  } catch {
    return { ...DEFAULT_CONFIG, features: { ...DEFAULT_FEATURES } };
  }
  const rawFeatures = isRecord(raw.features) ? raw.features : {};
  const features: Features = { ...DEFAULT_FEATURES };
  for (const name of FEATURES) {
    features[name] = bool(rawFeatures[name], DEFAULT_FEATURES[name]);
  }

  const seconds = Number(raw.statuslineSeconds);
  const exposure = exposureOf(raw.exposure);

  return {
    ...raw,
    version: 1,
    features,
    statuslineSeconds: Number.isFinite(seconds) && seconds >= 5 ? seconds : DEFAULT_CONFIG.statuslineSeconds,
    exposure,
  };
}

/**
 * A temp file is written and then renamed, so no half-written config is left
 * after a crash.
 */
export function writeConfig(config: MagpieConfig): void {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });

  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}
