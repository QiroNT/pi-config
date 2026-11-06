/**
 * `/magpie` and its arguments: the settings screen, the status, a catalog
 * refresh, the last route, and the one-line switch.
 *
 * The command reads the extension's state through `options` rather than
 * holding it, so the config it acts on is the one the screen last saved.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { allFeatures, DEFAULT_FEATURES, PROVIDER_ID, type MagpieConfig } from "./config.ts";
import type { Gateway, GatewayInfo } from "./gateway.ts";
import { fetchQuotaLines, fetchRoute, fetchStatusline, routeLine } from "./status.ts";
import { openSettings } from "./ui.ts";

const TIMEOUT_MS = 10_000;

export interface CommandOptions {
  /** The toggles as they stand: the screen changes them mid-session. */
  config: () => MagpieConfig;
  /** What the gateway said of itself, for the version. */
  info: () => GatewayInfo;
  /** The credential `/login` stored, as the gateway it names. */
  connect: (ctx: ExtensionContext) => Promise<Gateway | null>;
  /** Save a config and make the change visible: provider, MCP servers, poll. */
  apply: (next: MagpieConfig, ctx: ExtensionContext) => Promise<void>;
  /** Ask the catalog again; answers with how many models magpie now offers. */
  refresh: (ctx: ExtensionContext) => Promise<number>;
}

export function registerMagpieCommand(pi: ExtensionAPI, options: CommandOptions): void {
  /** The gateway as a few lines: the status, and the settings screen's row. */
  async function statusLines(ctx: ExtensionContext): Promise<string[]> {
    const current = await options.connect(ctx);
    if (!current) return ["magpie: not signed in — run `/login` and choose magpie gateway"];

    const info = options.info();
    const lines = [`gateway: ${current.url}${info.version ? ` (magpie ${info.version})` : ""}`];

    // each of these is optional: a read that fails contributes nothing
    const id = ctx.sessionManager.getSessionId();
    const status = await fetchStatusline(current, id, AbortSignal.timeout(TIMEOUT_MS)).catch(() => null);
    if (status?.text) lines.push(status.text);

    const quotas = await fetchQuotaLines(current, AbortSignal.timeout(TIMEOUT_MS)).catch(() => []);
    lines.push(...quotas);

    const models = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
    lines.push(`${models.length} models from magpie on offer`);

    return lines;
  }

  pi.registerCommand("magpie", {
    description: "magpie: settings, status, refresh, on/off",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      switch (command) {
        case "": {
          const current = await options.connect(ctx);
          await openSettings(ctx, {
            config: options.config(),
            gateway: current?.url ?? "",
            version: options.info().version,
            onChange: (next) => options.apply(next, ctx),
            onAction: async (action) => {
              if (action === "refresh") return `${await options.refresh(ctx)} models`;
              showStatus(pi, await statusLines(ctx));
              return "in the transcript";
            },
          });
          return;
        }

        case "status": {
          showStatus(pi, await statusLines(ctx));
          return;
        }

        case "refresh": {
          const count = await options.refresh(ctx);
          ctx.ui.notify(count ? `magpie: ${count} models` : "magpie: no models", "info");
          return;
        }

        case "route": {
          const current = await options.connect(ctx);
          if (!current) {
            ctx.ui.notify("magpie: not signed in — run `/login` and choose magpie gateway", "info");
            return;
          }
          const route = await fetchRoute(
            current,
            ctx.sessionManager.getSessionId(),
            AbortSignal.timeout(TIMEOUT_MS),
          ).catch(() => null);
          ctx.ui.notify(describeRoute(route), "info");
          return;
        }

        case "on":
        case "off": {
          // on is the defaults, off is nothing: a switch, not a diff
          const enabled = command === "on";
          const next: MagpieConfig = {
            ...options.config(),
            features: enabled ? { ...DEFAULT_FEATURES } : allFeatures(false),
          };
          await options.apply(next, ctx);
          ctx.ui.notify(`magpie ${enabled ? "on" : "off"}`, "info");
          return;
        }

        default:
          ctx.ui.notify(`magpie: unknown argument "${command}" — try status, refresh, route, on or off`, "info");
      }
    },
  });
}

/** A multi-line status belongs in the transcript, not in a toast. */
function showStatus(pi: ExtensionAPI, lines: string[]): void {
  pi.sendMessage({ customType: "magpie-status", content: lines.join("\n"), display: true });
}

function describeRoute(route: Awaited<ReturnType<typeof fetchRoute>>): string {
  const line = routeLine(route ?? null);
  const hit = route?.route;
  if (!hit) return "magpie: no route for this session yet";

  const tries = (hit.tries ?? []).map((attempt) => {
    const status = attempt.status ? ` ${attempt.status}` : "";
    const done = attempt.done ? " ok" : "";
    return `${attempt.model ?? "?"}${attempt.effort ? `/${attempt.effort}` : ""}${status}${done}`;
  });

  // the route command is the fuller answer: it keeps the effort the footer omits
  const effort = hit.effort || hit.askedEffort;

  return [`magpie ${line ?? hit.asked ?? "?"}${effort ? ` · ${effort}` : ""}`, tries.length ? `tries: ${tries.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
}
