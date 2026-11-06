/**
 * magpie's MCP servers as Pi's.
 *
 * Two sources, both on the gateway:
 *   - the router, /mcp/magpie/hub/<agent>: one server that reaches every
 *     server the Library holds for that agent;
 *   - magpie's own, GET /v1/magpie/mcp: web search, vision, images and the
 *     plugin tools, each its own endpoint.
 *
 * Registrations are per session and unsaved, so this runs on every start and
 * after every toggle.
 */

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpExposure } from "./config.ts";
import { getJSON, type Gateway } from "./gateway.ts";

export const HUB_SERVER_NAME = "magpie";
export const HUB_AGENT = "pi";
export const OWN_MCP_PATH = "/v1/magpie/mcp";
/** As `GET /v1` lists it; the router is asked per agent. */
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
 * Register what the toggles name, unregister the rest; idempotent: a server
 * whose config has not changed is left alone, so its connection is too.
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

  // an older magpie serves neither route: the catalog of paths says which
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

/** Forget everything (the master switch going off, or a gateway change). */
export function unregisterMcp(pi: ExtensionAPI, registered: Map<string, string>): void {
  for (const name of [...registered.keys()]) {
    try {
      pi.unregisterMcpServer(name);
    } catch {
      // already gone: the session ended under us
    }
  }
  registered.clear();
}
