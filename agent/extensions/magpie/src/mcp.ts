/**
 * magpie's MCP servers as Pi's, from two sources: the router (one server for
 * all of the Library's servers for the agent) and magpie's own (one endpoint
 * each). Registrations are per session and unsaved, so this is run on every
 * start and toggle.
 */

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpExposure } from "./config.ts";
import { getJSON, type Gateway } from "./gateway.ts";

export const HUB_SERVER_NAME = "magpie";
export const HUB_AGENT = "pi";
export const OWN_MCP_PATH = "/v1/magpie/mcp";
/** As listed by `GET /v1`, with the agent unfilled. */
export const HUB_MCP_PATH = "/mcp/magpie/hub/{agent}";

export interface OwnMcpServer {
  name: string;
  title?: string;
  path: string;
}

export async function fetchOwnServers(gateway: Gateway, signal?: AbortSignal): Promise<OwnMcpServer[]> {
  const answer = await getJSON<{ servers?: OwnMcpServer[] }>(gateway, OWN_MCP_PATH, signal);
  return (answer.servers ?? []).filter((server) => server.name && server.path);
}

export function hubConfig(gateway: Gateway, exposure: McpExposure): McpServerConfig {
  return {
    type: "http",
    url: `${gateway.root}/mcp/magpie/hub/${HUB_AGENT}`,
    headers: gateway.key ? { Authorization: `Bearer ${gateway.key}` } : undefined,
    exposure,
    description: "magpie's MCP router: the servers the Library gives Pi.",
  };
}

export function ownConfig(gateway: Gateway, server: OwnMcpServer, exposure: McpExposure): McpServerConfig {
  return {
    type: "http",
    url: `${gateway.root}${server.path}`,
    headers: gateway.key ? { Authorization: `Bearer ${gateway.key}` } : undefined,
    exposure,
    description: server.title,
  };
}

/**
 * Safe to call again: a server with an unchanged config is left connected.
 */
export async function syncMcp(
  pi: ExtensionAPI,
  gateway: Gateway,
  wanted: { hub: boolean; own: boolean; exposure: McpExposure; offers: (path: string) => boolean },
  registered: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const desired = new Map<string, McpServerConfig>();

  if (wanted.hub && wanted.offers(HUB_MCP_PATH)) {
    desired.set(HUB_SERVER_NAME, hubConfig(gateway, wanted.exposure));
  }

  // neither route may be served by an older magpie
  if (wanted.own && wanted.offers(OWN_MCP_PATH)) {
    for (const server of await fetchOwnServers(gateway, signal)) {
      if (server.name === HUB_SERVER_NAME) continue;
      desired.set(server.name, ownConfig(gateway, server, wanted.exposure));
    }
  }

  for (const [name, signature] of registered) {
    const next = desired.get(name);
    if (next && signature === JSON.stringify(next)) continue;
    pi.unregisterMcpServer(name);
    registered.delete(name);
  }

  for (const [name, config] of desired) {
    const signature = JSON.stringify(config);
    if (registered.get(name) === signature) continue;

    pi.registerMcpServer(name, config);
    registered.set(name, signature);
  }
}

/**
 * Every registration is dropped when there is no gateway, when no MCP toggle
 * is on, when a sync failed, or when the session has ended.
 */
export function unregisterMcp(pi: ExtensionAPI, registered: Map<string, string>): void {
  for (const name of [...registered.keys()]) {
    try {
      pi.unregisterMcpServer(name);
    } catch {
      // already gone, since the session was closed first
    }
  }
  registered.clear();
}
