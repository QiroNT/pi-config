/**
 * The gateway base and credential, and the two ways to get them:
 * from Pi's stored credential (the extension's own requests) or from a
 * refresh context (the catalog fetch).
 *
 * The credential is written by `/login` into Pi's auth store; the URL rides
 * there in the credential's `env`, so magpie.json holds toggles only.
 */

import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./config.ts";

export const USER_AGENT = "pi-magpie-extension/0.1 (pi)";

/**
 * `GET /v1`'s answer: the version, and the paths this magpie serves. The list
 * is how a build that predates a route says so — asking anyway would be a
 * 404 dressed up as a failure.
 */
export interface GatewayInfo {
  version: string;
  apis: string[] | null;
  /** Whether the router has a server to give; undefined when not told. */
  mcpHub: boolean | undefined;
}

export const NO_INFO: GatewayInfo = { version: "", apis: null, mcpHub: undefined };

/** Whether this magpie offers a path; unknown (an old answer) means try it. */
export function offers(info: GatewayInfo, path: string): boolean {
  if (!info.apis || info.apis.length === 0) return true;
  return info.apis.includes(path);
}

export interface Gateway {
  /** The gateway as the user typed it, without a trailing slash. */
  url: string;
  /** For chat, Responses, images, systemone and everything else under /v1. */
  v1: string;
  /** The root, which is what Anthropic's Messages API is asked at. */
  root: string;
  key: string;
}

/** Trim, drop trailing slashes, add a scheme when one is missing. */
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

/** The credential `/login` stored, as the gateway it names. */
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

/** The same, for a catalog refresh, which hands the credential to the provider. */
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

/** GET a gateway path as JSON, with the error magpie wrote kept in the message. */
export async function getJSON<T>(gateway: Gateway, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${gateway.url}${path}`, { headers: headersOf(gateway), signal });
  const body = await response.text();
  if (!response.ok) {
    let reason = body.slice(0, 500);
    try {
      reason = JSON.parse(body)?.error ?? reason;
    } catch {
      // not JSON: the body is the reason
    }
    throw new GatewayError(response.status, reason || `magpie answered ${response.status}`);
  }
  return JSON.parse(body) as T;
}
