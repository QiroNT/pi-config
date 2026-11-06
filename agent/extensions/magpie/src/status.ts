/**
 * The extension's reads of the gateway: status line, quotas and last route.
 * A 403 is a sign to turn the toggle off, not a reason to retry the call.
 */

import { getJSON, type Gateway } from "./gateway.ts";

export const STATUSLINE_PATH = "/v1/magpie/statusline";
export const QUOTAS_PATH = "/v1/magpie/quotas";
export const ROUTE_PATH = "/v1/magpie/route";

export interface StatuslineAnswer {
  text?: string;
  model?: string;
  /** The accounts shown on the line; empty when no window is found for any. */
  accounts?: unknown[];
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
 * The line shown by magpie, and the model that served the last turn. Accounts
 * are limited by `only`; the model is always included.
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

/** One line per account, in magpie's style: no colon after the name. */
export async function fetchQuotaLines(gateway: Gateway, signal?: AbortSignal): Promise<string[]> {
  const cards = await fetchQuotaCards(gateway, signal);
  return cards.map(quotaLine);
}

/**
 * Null when no account matches. Used for balance-paid accounts, which are
 * left out of the status line.
 */
export async function fetchAccountLine(
  gateway: Gateway,
  provider: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cards = await fetchQuotaCards(gateway, signal);
  const wanted = provider.toLowerCase();
  const card = cards.find((card) => (card.provider ?? "").toLowerCase() === wanted);
  return card ? quotaLine(card) : null;
}

/** Only accounts kept by the gateway are asked for (`kept=1`). */
async function fetchQuotaCards(gateway: Gateway, signal?: AbortSignal): Promise<QuotaCard[]> {
  const answer = await getJSON<{ data?: QuotaCard[] }>(gateway, `${QUOTAS_PATH}?kept=1`, signal);
  return answer.data ?? [];
}

function quotaLine(card: QuotaCard): string {
  const name = card.name ?? card.provider ?? "account";
  if (card.error) return `${name} ${card.error}`;

  const parts: string[] = [];
  for (const window of card.windows ?? []) {
    const label = window.name ?? "";
    const value = window.display ?? (window.unlimited ? "unlimited" : "");
    if (label || value) parts.push([label, value].filter(Boolean).join(" "));
  }
  if (card.balance) parts.push(card.balance);

  return parts.length ? `${name} ${parts.join(" · ")}` : name;
}

/**
 * `already` is the text before this part; a model named in it is not
 * repeated. The effort is left out, since it is shown in Pi's footer.
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
