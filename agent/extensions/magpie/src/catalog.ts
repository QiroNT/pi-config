/**
 * /v1/models → Pi models. Decision models, image models and prices are added
 * when the X-Magpie-* headers are sent. A row's Pi API is picked from its
 * native_endpoints, since each model is forwarded as it is.
 */

import type {
  AnyModel,
  Api,
  ClassifierApi,
  ClassifierModel,
  ImageApi,
  ImageModel,
  Model,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { Features } from "./config.ts";
import { PROVIDER_ID } from "./config.ts";
import { headersOf, type Gateway } from "./gateway.ts";

export const IMAGE_API = "magpie-images";
export const CLASSIFIER_API = "typesafe-system-one";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface CatalogRow {
  id: string;
  kind?: string;
  display_name?: string;
  magpie_label?: string;
  reasoning?: boolean;
  reasoning_levels?: string[];
  supported_reasoning_levels?: { effort?: string }[];
  context_window?: number;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  native_endpoints?: string[];
  modalities?: { input?: string[]; output?: string[] };
  pricing?: Record<string, string>;
  magpie_price?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface CatalogOptions {
  classifier: boolean;
}

const ALIASES: Record<string, string> = {
  off: "off", none: "off", disabled: "off",
  min: "minimal", minimal: "minimal",
  low: "low", lite: "low", light: "low",
  medium: "medium", med: "medium", mid: "medium", normal: "medium", default: "medium",
  high: "high", deep: "high",
  xhigh: "xhigh", "x-high": "xhigh", "extra-high": "xhigh",
  max: "max", maximum: "max", ultra: "max",
};

// two shapes: reasoning_levels (strings) or
// supported_reasoning_levels (objects)
function names(row: CatalogRow): string[] {
  return row.reasoning_levels?.length
    ? row.reasoning_levels
    : (row.supported_reasoning_levels ?? []).map((level) => level.effort ?? "").filter(Boolean);
}

/** A level missing from the model is set to null, so Pi hides it. */
function thinkingLevelMap(row: CatalogRow): ThinkingLevelMap | undefined {
  const listed = names(row);
  if (!listed.length) return undefined;

  const own = new Map<string, string>();
  for (const name of listed) {
    const level = ALIASES[name.trim().toLowerCase()];
    if (level && !own.has(level)) own.set(level, name);
  }
  const map: ThinkingLevelMap = {};
  for (const level of LEVELS) map[level] = own.get(level) ?? null;
  return map;
}

function perMillion(perToken: string | undefined): number {
  const value = Number(perToken);
  return Number.isFinite(value) ? value * 1_000_000 : 0;
}

// magpie_price is already per million tokens; pricing is per token
function costOf(row: CatalogRow): typeof ZERO_COST {
  const price = row.magpie_price;
  if (price) {
    return {
      input: Number(price.input) || 0,
      output: Number(price.output) || 0,
      cacheRead: Number(price.cache_read) || 0,
      cacheWrite: Number(price.cache_write) || 0,
    };
  }
  const pricing = row.pricing;
  if (pricing) {
    return {
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read),
      cacheWrite: perMillion(pricing.input_cache_write),
    };
  }
  return { ...ZERO_COST };
}

/**
 * Copied from magpie's rule for which models are given a prompt cache, and
 * for how long (seconds).
 */
function promptCacheFor(api: string, id: string): { short: number; long?: number } | undefined {
  const name = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  if (api === "anthropic-messages" && name.startsWith("claude")) return { short: 300, long: 3600 };
  if (api === "openai-responses" && name.startsWith("gpt")) return { short: 300 };
  return undefined;
}

function apiOf(row: CatalogRow): { api: string; atRoot: boolean } {
  const endpoints = row.native_endpoints ?? [];
  // /v1 is added by Anthropic's SDK itself, so Messages is asked at the root
  if (endpoints.includes("/v1/messages")) return { api: "anthropic-messages", atRoot: true };
  if (endpoints.includes("/v1/responses")) return { api: "openai-responses", atRoot: false };
  return { api: "openai-completions", atRoot: false };
}

function inputOf(row: CatalogRow): ("text" | "image")[] {
  const kinds = row.modalities?.input ?? [];
  return kinds.includes("image") ? ["text", "image"] : ["text"];
}

function chatModel(row: CatalogRow, gateway: Gateway, features: Features): Model<Api> {
  const { api, atRoot } = apiOf(row);
  const contextWindow = row.context_window ?? row.context_length ?? row.max_input_tokens ?? 128_000;
  const maxTokens = Math.min(row.max_output_tokens ?? 16_384, contextWindow);

  const model: Model<Api> = {
    id: row.id,
    name: row.display_name ?? row.magpie_label ?? row.id,
    api,
    provider: PROVIDER_ID,
    baseUrl: atRoot ? gateway.root : gateway.v1,
    input: inputOf(row),
    reasoning: Boolean(row.reasoning) || names(row).length > 0,
    cost: features.costs ? costOf(row) : { ...ZERO_COST },
    contextWindow,
    maxTokens,
  };

  if (features.thinkingLevels) {
    const levels = thinkingLevelMap(row);
    // On Messages, "off" is thinking disabled for a Claude model, so a null
    // off is dropped. Thinking is always on for other models there.
    if (levels && api === "anthropic-messages" && row.id.toLowerCase().includes("claude") && levels.off === null) {
      delete levels.off;
    }
    if (levels) model.thinkingLevelMap = levels;
  }

  const cache = promptCacheFor(api, row.id);
  if (cache) model.promptCache = cache;

  // A Responses tool missing a property is read as strict-mode schema
  if (api === "openai-responses") model.compat = { supportsStrictMode: true };

  return model;
}

function imageModel(row: CatalogRow, gateway: Gateway, features: Features): ImageModel<ImageApi> {
  return {
    id: row.id,
    name: row.display_name ?? row.magpie_label ?? row.id,
    type: "image",
    api: IMAGE_API,
    provider: PROVIDER_ID,
    baseUrl: gateway.v1,
    input: inputOf(row),
    output: ["image"],
    cost: features.costs ? costOf(row) : { ...ZERO_COST },
  };
}

function classifierModel(row: CatalogRow, gateway: Gateway, features: Features): ClassifierModel<ClassifierApi> {
  return {
    id: row.id,
    name: row.display_name ?? row.magpie_label ?? row.id,
    type: "classifier",
    api: CLASSIFIER_API,
    provider: PROVIDER_ID,
    baseUrl: gateway.v1,
    input: ["text"],
    cost: features.costs ? costOf(row) : { ...ZERO_COST },
    contextWindow: row.context_window ?? 64_000,
  };
}

export function toPiModels(rows: CatalogRow[], gateway: Gateway, features: Features, options: CatalogOptions): AnyModel[] {
  const models: AnyModel[] = [];
  for (const row of rows) {
    if (!row?.id) continue;
    switch (row.kind) {
      case "image":
        if (features.images) models.push(imageModel(row, gateway, features));
        break;
      case "decision":
        if (features.systemone && options.classifier) models.push(classifierModel(row, gateway, features));
        break;
      case "video":
        // No video model exists in Pi, so these are skipped
        break;
      default:
        if (features.catalog) models.push(chatModel(row, gateway, features));
    }
  }
  return models;
}

export async function fetchCatalog(
  gateway: Gateway,
  features: Features,
  options: CatalogOptions,
  signal?: AbortSignal,
): Promise<AnyModel[]> {
  const extra: Record<string, string> = {};
  if (features.costs) extra["x-magpie-prices"] = "1";
  if (features.systemone && options.classifier) extra["x-magpie-deciders"] = "1";
  if (features.images) extra["x-magpie-drawers"] = "1";

  const response = await fetch(`${gateway.v1}/models`, { headers: headersOf(gateway, extra), signal });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`magpie's model list answered ${response.status}: ${body.slice(0, 300)}`);
  }
  const body: { data?: CatalogRow[] } = await response.json();
  return toPiModels(body.data ?? [], gateway, features, options);
}
