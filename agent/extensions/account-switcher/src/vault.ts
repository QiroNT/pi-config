/** Credential vault persistence. The file contains secrets and is always 0600. */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string>; [key: string]: unknown }
  | { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };

export type CredentialIdentity =
  | { kind: "api-key"; digest: string }
  | { kind: "oauth-account"; namespace: string; value: string }
  | { kind: "oauth-subject"; issuer: string; subject: string }
  | { kind: "oauth-fingerprint"; digest: string };

export interface Account {
  id: string;
  label: string;
  provider: string;
  entry: Credential;
  identity: CredentialIdentity;
  credentialObservedAt: number;
}

export interface Vault {
  version: 1;
  accounts: Account[];
}

interface LockOptions {
  realpath: boolean;
  stale: number;
  update: number;
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize: boolean;
  };
}

type Lock = (path: string, options: LockOptions) => Promise<() => Promise<void>>;

const require = createRequire(import.meta.url);
const lock = (require("proper-lockfile") as { lock: Lock }).lock;

export const EXT_ID = "account-switcher";
const VAULT_PATH = join(getAgentDir(), "account-switcher.json");
const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: { retries: 12, factor: 1.5, minTimeout: 25, maxTimeout: 500, randomize: true },
};

function emptyVault(): Vault {
  return { version: 1, accounts: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") return value.key === undefined || typeof value.key === "string";
  return (
    value.type === "oauth" &&
    typeof value.refresh === "string" &&
    typeof value.access === "string" &&
    typeof value.expires === "number"
  );
}

function validIdentity(value: unknown): value is CredentialIdentity {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "api-key" || value.kind === "oauth-fingerprint")
    return typeof value.digest === "string";
  if (value.kind === "oauth-account")
    return typeof value.namespace === "string" && typeof value.value === "string";
  return (
    value.kind === "oauth-subject" &&
    typeof value.issuer === "string" &&
    typeof value.subject === "string"
  );
}

function identityKey(identity: CredentialIdentity): string {
  switch (identity.kind) {
    case "api-key":
    case "oauth-fingerprint":
      return `${identity.kind}:${identity.digest}`;
    case "oauth-account":
      return `${identity.kind}:${identity.namespace}:${identity.value}`;
    case "oauth-subject":
      return `${identity.kind}:${identity.issuer}:${identity.subject}`;
  }
}

function validateVault(value: unknown): Vault {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error(`Invalid ${VAULT_PATH}: expected a version 1 account vault.`);
  }
  const ids = new Set<string>();
  const displayNames = new Set<string>();
  const credentialOwners = new Set<string>();
  for (const [index, raw] of value.accounts.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !raw.id.trim() ||
      typeof raw.label !== "string" ||
      !raw.label.trim() ||
      typeof raw.provider !== "string" ||
      !raw.provider.trim() ||
      !validCredential(raw.entry) ||
      !validIdentity(raw.identity) ||
      typeof raw.credentialObservedAt !== "number"
    ) {
      throw new Error(`Invalid ${VAULT_PATH}: malformed account at index ${index}.`);
    }
    if (ids.has(raw.id))
      throw new Error(`Invalid ${VAULT_PATH}: duplicate account id "${raw.id}".`);
    ids.add(raw.id);
    const displayName = `${raw.provider}:${raw.label}`;
    if (displayNames.has(displayName)) {
      throw new Error(`Invalid ${VAULT_PATH}: duplicate account name "${displayName}".`);
    }
    displayNames.add(displayName);
    const credentialOwner = `${raw.provider}:${identityKey(raw.identity as CredentialIdentity)}`;
    if (credentialOwners.has(credentialOwner)) {
      throw new Error(
        `Invalid ${VAULT_PATH}: multiple entries refer to the same provider account.`,
      );
    }
    credentialOwners.add(credentialOwner);
  }
  return value as unknown as Vault;
}

async function readVaultFile(): Promise<Vault> {
  let contents: string;
  try {
    contents = await readFile(VAULT_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${VAULT_PATH}: ${message}`);
  }
  const vault = validateVault(parsed);
  await chmod(VAULT_PATH, 0o600);
  return vault;
}

async function atomicWrite(vault: Vault): Promise<void> {
  const directory = dirname(VAULT_PATH);
  const temporary = join(directory, `.account-switcher.${process.pid}.${randomUUID()}.tmp`);
  const contents = JSON.stringify(validateVault(vault), null, 2);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, VAULT_PATH);
    await chmod(VAULT_PATH, 0o600);
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      directoryHandle = await open(directory, "r");
      await directoryHandle.sync();
    } catch {
      // Directory fsync is unavailable on some platforms; rename is still atomic.
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class VaultStore {
  private current: Vault = emptyVault();

  get snapshot(): Vault {
    return structuredClone(this.current);
  }

  async read(): Promise<Vault> {
    this.current = await readVaultFile();
    return this.snapshot;
  }

  async update<T>(mutator: (vault: Vault) => T | Promise<T>): Promise<{ vault: Vault; result: T }> {
    await mkdir(dirname(VAULT_PATH), { recursive: true });
    const release = await lock(VAULT_PATH, LOCK_OPTIONS);
    try {
      const vault = await readVaultFile();
      const result = await mutator(vault);
      validateVault(vault);
      await atomicWrite(vault);
      this.current = vault;
      return { vault: this.snapshot, result };
    } finally {
      await release();
    }
  }
}
