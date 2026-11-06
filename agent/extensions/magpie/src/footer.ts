/**
 * magpie's status line and last-route row. Nothing is drawn unless the current
 * model is magpie's. A failure is shown in a few words, so an empty row is read
 * as a toggle that is off, not as a failed request.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Features } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import {
  fetchAccountLine,
  fetchRoute,
  fetchStatusline,
  ROUTE_PATH,
  routeLine,
  STATUSLINE_PATH,
  type RouteAnswer,
} from "./status.ts";

const TIMEOUT_MS = 10_000;
const TURN_MS = 3_000;

/** After a 403, that read is not repeated until `start` is called again. */
interface Refused {
  statusline: boolean;
  route: boolean;
}

export interface FooterOptions {
  features: () => Features;
  seconds: () => number;
  gateway: () => Gateway | null;
  connect: (ctx: ExtensionContext) => Promise<Gateway | null>;
  onMagpie: () => boolean;
  offers: (path: string) => boolean;
  vendor: () => string | undefined;
}

export interface Footer {
  start(ctx: ExtensionContext): void;
  /** A redraw, unless one was made within TURN_MS. */
  drawSoon(): void;
  stop(ctx?: ExtensionContext): void;
}

export function createFooter(options: FooterOptions): Footer {
  const refused: Refused = { statusline: false, route: false };
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastDrawnAt = 0;
  let drawing = false;

  const wanted = (): boolean => {
    const features = options.features();
    return features.statusline || features.route;
  };

  // nobody awaits this, so catch any error here
  function redraw(): void {
    draw().catch(() => undefined);
  }

  async function draw(): Promise<void> {
    // `ctx` may be swapped mid-read by stop() or start(); skip the old one
    const target = ctx;
    if (!target || drawing) return;

    // the row is cleared when the model is not magpie's
    if (!options.onMagpie()) {
      target.ui.setStatus("magpie", undefined);
      return;
    }

    drawing = true;
    try {
      // the credential may be added mid-session by /login: look again if none
      const current = options.gateway() ?? (await options.connect(target));
      if (ctx !== target) return;

      if (!current) {
        target.ui.setStatus("magpie", "magpie not connected — run `/login`");
        return;
      }

      const features = options.features();
      const session = target.sessionManager.getSessionId();
      const timeout = AbortSignal.timeout(TIMEOUT_MS);

      const asked = (on: boolean, key: keyof Refused, path: string): boolean =>
        on && !refused[key] && options.offers(path);

      // the accounts of the provider being used, not every account there is
      const vendor = options.vendor();
      const only = vendor ? [vendor] : undefined;

      const [status, route] = await Promise.allSettled([
        asked(features.statusline, "statusline", STATUSLINE_PATH)
          ? fetchStatusline(current, session, timeout, only)
          : undefined,
        asked(features.route, "route", ROUTE_PATH) ? fetchRoute(current, session, timeout) : undefined,
      ]);
      if (ctx !== target) return;

      // parts: the status line and the route. An off part is left out.
      // A failed part is given its reason. Refused reads are not retried.
      const parts: string[] = [];

      const statusText = settled(status, () => undefined);

      // no windows exist for a balance-paid account, so only the model is shown
      // on magpie's line; that account's own line is appended.
      let statusLine = statusText?.text ?? "";
      if (statusText && !statusText.accounts?.length && vendor) {
        const account = await quietly(() => fetchAccountLine(current, vendor, timeout));
        if (ctx !== target) return;
        if (account) statusLine = statusLine ? `${statusLine} | ${account}` : account;
      }

      if (refused.statusline) parts.push("status line refused (403)");
      else if (statusLine) parts.push(statusLine);
      else parts.push(...failureOf("status line", status));
      if (status.status === "rejected") refused.statusline = statusOf(status.reason) === 403;

      const already = parts.join(" · ");

      const line = settled<RouteAnswer | null, null>(route, () => null);
      const routeText = line ? routeLine(line, already) : null;
      if (refused.route) parts.push("route refused (403)");
      else if (route.status === "rejected") parts.push(...failureOf("route", route));
      else if (routeText) parts.push(routeText);
      if (route.status === "rejected") refused.route = statusOf(route.reason) === 403;

      const row = parts.filter(Boolean).join(" · ");
      target.ui.setStatus("magpie", row ? `magpie ${row}` : undefined);

      lastDrawnAt = Date.now();
    } finally {
      drawing = false;
    }
  }

  return {
    start(next) {
      ctx = next;

      if (timer) clearInterval(timer);
      timer = undefined;
      // refused reads are cleared when the user toggles, refreshes or logs in
      refused.statusline = refused.route = false;

      if (!wanted() || !options.onMagpie()) {
        next.ui.setStatus("magpie", undefined);
        return;
      }

      timer = setInterval(redraw, Math.max(5, options.seconds()) * 1000);
      redraw();
    },

    drawSoon() {
      if (Date.now() - lastDrawnAt < TURN_MS) return;
      redraw();
    },

    stop(latest) {
      if (timer) clearInterval(timer);
      timer = undefined;

      (latest ?? ctx)?.ui.setStatus("magpie", undefined);
      ctx = undefined;
    },
  };
}

/** Null is returned on failure instead of throwing. */
async function quietly<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function failureOf(label: string, result: PromiseSettledResult<unknown>): string[] {
  if (result.status !== "rejected") return [];

  const status = statusOf(result.reason);
  if (status === 403) return [`${label} refused (403)`];
  if (status) return [`${label} failed (${status})`];

  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return [`${label} ${/timeout|abort/i.test(message) ? "timed out" : "unreachable"}`];
}

function settled<T, F>(result: PromiseSettledResult<T | undefined>, fallback: () => F): T | F {
  if (result.status === "rejected") return fallback();
  return result.value === undefined ? fallback() : result.value;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}
