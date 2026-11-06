/**
 * The footer: magpie's status line, and where the last turn went.
 *
 * Nothing here runs unless the current model is magpie's: a footer about
 * magpie in a conversation with another provider is just noise.
 *
 * While it does run, every failure is shown in its own few words, so an
 * empty row means "the toggle is off", not "the request failed".
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Features } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import {
  fetchRoute,
  fetchStatusline,
  ROUTE_PATH,
  routeLine,
  STATUSLINE_PATH,
  type RouteAnswer,
} from "./status.ts";

const TIMEOUT_MS = 10_000;
/** No closer than this between a turn starting and a redraw. */
const TURN_MS = 3_000;

/** Reads the gateway refused once: stop asking, quietly, until `start` runs again. */
interface Refused {
  statusline: boolean;
  route: boolean;
}

export interface FooterOptions {
  /** The toggles as they apply now. */
  features: () => Features;
  /** Seconds between polls. */
  seconds: () => number;
  /** The gateway as currently known, or null before `/login`. */
  gateway: () => Gateway | null;
  /** Ask again for the credential and the gateway. */
  connect: (ctx: ExtensionContext) => Promise<Gateway | null>;
  /** Whether the model in use is magpie's: the footer is about that model. */
  onMagpie: () => boolean;
  /** Whether this magpie serves a path: an old build is missing some. */
  offers: (path: string) => boolean;
  /** The provider the model in use belongs to, if its id names one. */
  vendor: () => string | undefined;
}

export interface Footer {
  /** Begin polling: the interval, plus one read now. */
  start(ctx: ExtensionContext): void;
  /** One read, unless the last one was moments ago: a turn is starting. */
  drawSoon(): void;
  /** Stop polling and take the row away. */
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

  /** A draw nobody awaits: it must never end as an unhandled rejection. */
  function redraw(): void {
    draw().catch(() => undefined);
  }

  async function draw(): Promise<void> {
    // the context this draw belongs to: stop() and start() replace `ctx`
    // while a read is in flight, and a replaced context must not be drawn on
    const target = ctx;
    if (!target || drawing) return;

    // another provider is answering: magpie's footer has nothing to add
    if (!options.onMagpie()) {
      target.ui.setStatus("magpie", undefined);
      return;
    }

    drawing = true;
    try {
      // signed in since the last read: /login writes the credential mid-session
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

      // one footer row, assembled from what answered: the status line and the
      // route. A part that is off contributes nothing; a part that failed
      // says so in its own few words. A read the gateway refused once is not
      // asked again, and the row keeps saying why it is empty.
      const parts: string[] = [];

      const statusText = settled(status, () => undefined);
      if (refused.statusline) parts.push("status line refused (403)");
      else if (statusText?.text) parts.push(statusText.text);
      else parts.push(...failureOf("status line", status));
      if (status.status === "rejected") refused.statusline = statusOf(status.reason) === 403;

      // what the row already says, so the route part does not say it again
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
      // a toggle, a refresh or a new login is the user asking again
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

/** What to say about a part that has nothing to show, in a few words. */
function failureOf(label: string, result: PromiseSettledResult<unknown>): string[] {
  if (result.status !== "rejected") return [];

  const status = statusOf(result.reason);
  if (status === 403) return [`${label} refused (403)`];
  if (status) return [`${label} failed (${status})`];

  const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return [`${label} ${/timeout|abort/i.test(message) ? "timed out" : "unreachable"}`];
}

/** A settled read, or a fallback: the promise's outcome never reaches the footer. */
function settled<T, F>(result: PromiseSettledResult<T | undefined>, fallback: () => F): T | F {
  if (result.status === "rejected") return fallback();
  return result.value === undefined ? fallback() : result.value;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}
