import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Credential, CredentialIdentity } from "./vault";

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jwtPayload(access: string): Record<string, unknown> | undefined {
  const parts = access.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

export function deriveCredentialIdentity(credential: Credential): CredentialIdentity {
  if (credential.type === "api_key") {
    return { kind: "api-key", digest: digest({ key: credential.key, env: credential.env }) };
  }

  const payload = jwtPayload(credential.access);
  const openAiAuth = payload?.["https://api.openai.com/auth"];
  if (openAiAuth && typeof openAiAuth === "object") {
    const accountId = stringField(openAiAuth as Record<string, unknown>, ["chatgpt_account_id"]);
    if (accountId) return { kind: "oauth-account", namespace: "openai-chatgpt", value: accountId };
  }

  const explicitId = stringField(credential, ["accountId", "account_id", "userId", "user_id"]);
  if (explicitId) return { kind: "oauth-account", namespace: "credential", value: explicitId };

  const issuer = typeof payload?.iss === "string" ? payload.iss : undefined;
  const subject = typeof payload?.sub === "string" ? payload.sub : undefined;
  if (issuer && subject) return { kind: "oauth-subject", issuer, subject };

  // Opaque OAuth credentials are recognized only while their tokens are unchanged.
  // After rotation they deliberately become unknown rather than risking misattribution.
  return {
    kind: "oauth-fingerprint",
    digest: digest({ access: credential.access, refresh: credential.refresh }),
  };
}

export function sameIdentity(a: CredentialIdentity, b: CredentialIdentity): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "api-key":
    case "oauth-fingerprint":
      return a.digest === (b as typeof a).digest;
    case "oauth-account":
      return a.namespace === (b as typeof a).namespace && a.value === (b as typeof a).value;
    case "oauth-subject":
      return a.issuer === (b as typeof a).issuer && a.subject === (b as typeof a).subject;
  }
}
