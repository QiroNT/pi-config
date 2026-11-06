/**
 * magpie, for Pi, over HTTP.
 *
 * Everything magpie would write into Pi's files — the provider, the extra
 * model kinds, the session headers — is done here at runtime instead, from
 * the gateway's own API. What it cannot do over HTTP (the Library's
 * instructions, the per-agent model scope) it leaves to Pi's own files.
 *
 * The gateway URL and key come from `/login magpie`; this extension's file,
 * ~/.pi/agent/magpie.json, holds the toggles only.
 */

import type { ProviderClassifier } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMagpieCommand } from "./src/command.ts";
import {
  modelFeaturesOn,
  PROVIDER_ID,
  readConfig,
  writeConfig,
  type Features,
  type MagpieConfig,
} from "./src/config.ts";
import { createFooter } from "./src/footer.ts";
import { gatewayFor, getJSON, NO_INFO, offers, type Gateway, type GatewayInfo } from "./src/gateway.ts";
import { syncMcp, unregisterMcp } from "./src/mcp.ts";
import { buildProvider } from "./src/provider.ts";

const TIMEOUT_MS = 10_000;

export default async function magpie(pi: ExtensionAPI): Promise<void> {
  const classifier = await loadClassifier();

  let config: MagpieConfig = readConfig();
  let gateway: Gateway | null = null;
  let info: GatewayInfo = NO_INFO;
  let registered = false;
  let session: ExtensionContext | undefined;
  const mcpRegistered = new Map<string, string>();

  /** Whether this magpie serves a path, per its own `/v1` answer. */
  const serves = (path: string): boolean => offers(info, path);

  /** The toggles as they apply here: no decisions on a Pi without classifiers. */
  const features = (): Features => ({
    ...config.features,
    systemone: config.features.systemone && Boolean(classifier),
  });

  /**
   * Register the provider with magpie's catalog. `fetchModels` reads the
   * toggles and the credential on every refresh, so a change needs no
   * re-registration.
   */
  function registerProvider(): void {
    if (registered) return;
    pi.registerProvider(buildProvider({ features, classifier: Boolean(classifier), classify: classifier }));
    registered = true;
  }

  function unregisterProvider(): void {
    if (!registered) return;
    pi.unregisterProvider(PROVIDER_ID);
    registered = false;
  }

  /** Save, then make the change visible: provider, MCP servers, poll. */
  async function apply(next: MagpieConfig, ctx: ExtensionContext | undefined): Promise<void> {
    config = next;
    writeConfig(config);

    if (modelFeaturesOn(config.features)) registerProvider();
    else unregisterProvider();

    const active = ctx ?? session;
    if (active) {
      await connect(active);
      if (registered) {
        await active.modelRegistry.refresh({ signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
      }
      await syncServers(active);
      footer.start(active);
    }
  }

  /** The credential `/login` stored, as the gateway it names. */
  async function connect(ctx: ExtensionContext): Promise<Gateway | null> {
    gateway = await gatewayFor(ctx);
    if (!gateway) {
      info = NO_INFO;
      return null;
    }
    if (!info.version) {
      try {
        const answer = await getJSON<{ version?: string; apis?: string[]; mcp_hub?: boolean }>(
          gateway,
          "/v1",
          AbortSignal.timeout(TIMEOUT_MS),
        );
        info = {
          version: answer.version ?? "",
          apis: Array.isArray(answer.apis) ? answer.apis : null,
          mcpHub: typeof answer.mcp_hub === "boolean" ? answer.mcp_hub : undefined,
        };
      } catch {
        info = NO_INFO;
      }
    }
    return gateway;
  }

  /** magpie's MCP servers, or none: registrations do not outlive the session. */
  async function syncServers(ctx: ExtensionContext): Promise<void> {
    const current = gateway ?? (await connect(ctx));
    const wanted = {
      // the router says whether it has anything to give; an older answer
      // (undefined) is worth registering and finding out
      hub: config.features.mcpHub && info.mcpHub !== false,
      own: config.features.mcpServers,
      exposure: config.exposure,
      offers: serves,
    };

    if (!current || (!wanted.hub && !wanted.own)) {
      unregisterMcp(pi, mcpRegistered);
      return;
    }

    try {
      await syncMcp(pi, current, wanted, mcpRegistered, AbortSignal.timeout(TIMEOUT_MS));
    } catch {
      // no magpie, no servers, no complaint: the tools are missing, not broken
      unregisterMcp(pi, mcpRegistered);
    }
  }

  const footer = createFooter({
    features,
    seconds: () => config.statuslineSeconds,
    gateway: () => gateway,
    connect,
    onMagpie: () => session?.model?.provider === PROVIDER_ID,
    offers: serves,
    // "deepseek/deepseek-flash" belongs to deepseek; a bare id names nobody
    vendor: () => {
      const id = session?.model?.id;
      const vendor = id?.includes("/") ? id.slice(0, id.indexOf("/")) : "";
      return vendor || undefined;
    },
  });

  /** Ask the catalog again, then make what it says visible everywhere. */
  async function refreshCatalog(ctx: ExtensionContext): Promise<number> {
    await connect(ctx);
    await ctx.modelRegistry.refresh({ signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
    await syncServers(ctx);
    footer.start(ctx);

    return ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
  }

  // register our provider
  if (modelFeaturesOn(config.features)) registerProvider();

  pi.on("session_start", async (_event, ctx) => {
    session = ctx;
    await connect(ctx);

    if (modelFeaturesOn(config.features)) registerProvider();
    await syncServers(ctx);
    footer.start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    footer.stop(ctx);
    unregisterMcp(pi, mcpRegistered);
    session = undefined;
  });

  pi.on("model_select", (_event, ctx) => {
    // draw immediately on model switch
    footer.start(ctx);
  });

  pi.on("before_agent_start", () => {
    // a new turn is a new chance for a footer that could not be drawn
    footer.drawSoon();
  });

  // let magpie trace conversation
  pi.on("before_provider_headers", (event, ctx) => {
    if (!config.features.sessionAffinity) return;
    if (ctx.model?.provider !== PROVIDER_ID) return;

    const id = ctx.sessionManager.getSessionId();
    if (!id) return;
    event.headers["x-session-affinity"] = id;
    event.headers["session_id"] = id;
  });

  // the command
  registerMagpieCommand(pi, {
    config: () => config,
    info: () => info,
    connect,
    apply,
    refresh: refreshCatalog,
  });
}

/** magpie's decision models, when this Pi can take them. */
async function loadClassifier(): Promise<ProviderClassifier | undefined> {
  try {
    const module = await import("@earendil-works/pi-ai/providers/all");
    const typesafe = module.builtinProviders().find((provider) => provider.id === "typesafe");
    const classify = typesafe?.classify;
    if (typeof classify !== "function") return undefined;

    return {
      classify: (model, context, options) => classify(model, context, options),
    };
  } catch {
    return undefined;
  }
}
