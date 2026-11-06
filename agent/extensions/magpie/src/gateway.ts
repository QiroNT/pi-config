/**
 * The gateway base and key. The URL is stored in the credential's env, so
 * only toggles are saved in magpie.json.
 */

import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./config.ts";

export const USER_AGENT = "pi-magpie-extension/0.1 (pi)";

/**
 * `GET /v1`. A route is left out of `apis` by an older build, so asking for
 * it would only get a 404.
 */
export interface GatewayInfo {
  version: string;
  apis: string[] | null;
  /** undefined when not reported. */
  mcpHub: boolean | undefined;
}

export const NO_INFO: GatewayInfo = { version: "", apis: null, mcpHub: undefined };

/**
 * Whether a path is offered by this magpie. If the answer is unknown (an
 * old build), the path is tried.
 */
export function offers(info: GatewayInfo, path: string): boolean {
  if (!info.apis || info.apis.length === 0) return true;
  return info.apis.includes(path);
}

export interface Gateway {
  url: string;
  /** Everything under /v1 except Messages. */
  v1: string;
  /** Messages is asked here, since /v1 is added by Anthropic's SDK. */
  root: string;
  key: string;
}

/** http:// is added to a host with no scheme. */
export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "");
}

export function gatewayOf(url: string, key: string): Gateway | null {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  return { url: normalized, v1: `${normalized}/v1`, root: normalized, key };
}

export async function gatewayFor(ctx: ExtensionContext): Promise<Gateway | null> {
  try {
    const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    if (!auth) return null;
    const url = auth.env?.MAGPIE_URL ?? auth.auth.baseUrl ?? "";
    return gatewayOf(url, auth.auth.apiKey ?? "");
  } catch {
    return null;
  }
}

/** For a catalog refresh, where the credential is handed in directly. */
export function gatewayFromCredential(credential: Credential | undefined): Gateway | null {
  if (!credential || credential.type !== "api_key") return null;
  return gatewayOf(credential.env?.MAGPIE_URL ?? "", credential.key ?? "");
}

export function headersOf(gateway: Gateway, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, ...extra };
  if (gateway.key) headers.authorization = `Bearer ${gateway.key}`;
  return headers;
}

export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The error text sent back by magpie is included in the thrown message.
 */
export async function getJSON<T>(gateway: Gateway, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${gateway.url}${path}`, { headers: headersOf(gateway), signal });
  const body = await response.text();
  if (!response.ok) {
    let reason = body.slice(0, 500);
    try {
      reason = JSON.parse(body)?.error ?? reason;
    } catch {
      // not JSON: use the raw body as the reason
    }
    throw new GatewayError(response.status, reason || `magpie answered ${response.status}`);
  }
  return JSON.parse(body) as T;
}
