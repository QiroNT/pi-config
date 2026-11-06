/**
 * The extension's own reads of the gateway: the status line magpie would
 * draw for Pi, each account's quota windows, and where the last turn went.
 *
 * All three answer this machine, or another only when magpie is shared on
 * the local network and the request carries its key — so a 403 here means
 * "turn this toggle off", not "retry".
 */

import { getJSON, type Gateway } from "./gateway.ts";

export const STATUSLINE_PATH = "/v1/magpie/statusline";
export const QUOTAS_PATH = "/v1/magpie/quotas";
export const ROUTE_PATH = "/v1/magpie/route";

export interface StatuslineAnswer {
  text?: string;
}

export interface QuotaCard {
  provider?: string;
  name?: string;
  error?: string;
  balance?: string;
  windows?: QuotaWindow[];
}

export interface QuotaWindow {
  name?: string;
  display?: string;
  unlimited?: boolean;
}

export interface RouteAnswer {
  route?: {
    asked?: string;
    askedEffort?: string;
    model?: string;
    effort?: string;
    tries?: { model?: string; effort?: string; done?: boolean; status?: number }[];
  } | null;
}

/**
 * The single line magpie draws, plus the model that served the last turn.
 * `only` keeps the accounts named — the provider of the model in use, say —
 * as `magpie statusline claude` does; the model part stays either way.
 */
export async function fetchStatusline(
  gateway: Gateway,
  session: string,
  signal?: AbortSignal,
  only?: string[],
): Promise<StatuslineAnswer> {
  const query = new URLSearchParams({ format: "json" });
  if (session) query.set("session", session);
  for (const name of only ?? []) query.append("only", name);
  return getJSON<StatuslineAnswer>(gateway, `${STATUSLINE_PATH}?${query}`, signal);
}

export async function fetchRoute(gateway: Gateway, session: string, signal?: AbortSignal): Promise<RouteAnswer | null> {
  if (!session) return null;
  return getJSON<RouteAnswer>(gateway, `${ROUTE_PATH}?session=${encodeURIComponent(session)}`, signal);
}

/**
 * One line per account, in magpie's own style (`claude a@x.com 5h 62%
 * 7d 41%`: no colon after the name), for `/magpie status`.
 */
export async function fetchQuotaLines(gateway: Gateway, signal?: AbortSignal): Promise<string[]> {
  const answer = await getJSON<{ data?: QuotaCard[] }>(gateway, `${QUOTAS_PATH}?kept=1`, signal);
  const cards = answer.data ?? [];

  const lines: string[] = [];
  for (const card of cards) {
    const name = card.name ?? card.provider ?? "account";
    if (card.error) {
      lines.push(`${name} ${card.error}`);
      continue;
    }

    const parts: string[] = [];
    for (const window of card.windows ?? []) {
      const label = window.name ?? "";
      const value = window.display ?? (window.unlimited ? "unlimited" : "");
      if (label || value) parts.push([label, value].filter(Boolean).join(" "));
    }
    if (card.balance) parts.push(card.balance);

    lines.push(parts.length ? `${name} ${parts.join(" · ")}` : name);
  }

  return lines;
}

/**
 * The routing line: what answered, and how it was asked.
 *
 * `already` is what the row says before this part — the status line, when it
 * is on. A model named there is not named twice. The effort is left out: Pi's
 * own footer shows the one in use, so the row keeps only what it cannot see.
 */
export function routeLine(route: RouteAnswer | null, already = ""): string | null {
  const hit = route?.route;
  if (!hit) return null;

  const model = hit.model || hit.asked;
  const tries = hit.tries?.length ?? 0;

  const parts: string[] = [];
  if (model && !already.includes(model)) parts.push(model);
  if (tries > 1) parts.push(`${tries} tries`);
  return parts.length ? parts.join(" · ") : null;
}
