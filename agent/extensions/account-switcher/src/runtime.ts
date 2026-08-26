/**
 * The credential store is private pi API reached through `ctx.modelRegistry.runtime`.
 * Keep that dependency isolated here; ModelRegistry.refresh() remains public.
 */
import { deriveCredentialIdentity, sameIdentity } from "./identity";
import type { Account, Credential, Vault } from "./vault";
import { VaultStore } from "./vault";

export interface RuntimeApi {
  credentials: {
    read(provider: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined>;
    modify(
      provider: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

export interface ModelRegistryApi {
  refresh(options: {
    allowNetwork?: boolean;
    providers?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, unknown> }>;
}

export function runtimeOf(modelRegistry: unknown): RuntimeApi | undefined {
  const runtime = (modelRegistry as { runtime?: Partial<RuntimeApi> } | undefined)?.runtime;
  if (
    !runtime?.credentials ||
    typeof runtime.credentials.read !== "function" ||
    typeof runtime.credentials.modify !== "function"
  ) {
    return undefined;
  }
  return runtime as RuntimeApi;
}

function ownerOf(vault: Vault, provider: string, credential: Credential): Account | undefined {
  const identity = deriveCredentialIdentity(credential);
  return vault.accounts.find(
    (account) => account.provider === provider && sameIdentity(account.identity, identity),
  );
}

/** Cached only for display. Destructive operations must re-check live credentials. */
const active = new Map<string, string>();

export function activeIdOf(provider: string): string | undefined {
  return active.get(provider);
}

export function clearActive(provider: string): void {
  active.delete(provider);
}

/** Capture refreshed live credentials when they can be attributed safely. */
export async function syncFromLive(
  rt: RuntimeApi,
  store: VaultStore,
  provider: string,
  signal?: AbortSignal,
): Promise<{ live?: Credential; owner?: Account }> {
  const live = await rt.credentials.read(provider, { signal });
  if (!live) {
    active.delete(provider);
    return {};
  }

  const observedAt = Date.now();
  const initialOwner = ownerOf(await store.read(), provider, live);
  if (!initialOwner) {
    active.delete(provider);
    return { live };
  }

  const { result: owner } = await store.update((vault) => {
    const latestOwner = ownerOf(vault, provider, live);
    if (!latestOwner) return undefined;
    if (observedAt >= latestOwner.credentialObservedAt) {
      latestOwner.entry = live;
      latestOwner.identity = deriveCredentialIdentity(live);
      latestOwner.credentialObservedAt = observedAt;
    }
    return structuredClone(latestOwner);
  });

  if (!owner) {
    active.delete(provider);
    return { live };
  }
  active.set(provider, owner.id);
  return { live, owner };
}

/**
 * Replace the live slot only after re-checking it under auth.json's own lock.
 * Any newly appeared, unknown login aborts the switch instead of being clobbered.
 */
export async function install(
  rt: RuntimeApi,
  registry: ModelRegistryApi,
  store: VaultStore,
  accountId: string,
  signal: AbortSignal,
): Promise<Account> {
  const selected = (await store.read()).accounts.find((account) => account.id === accountId);
  if (!selected) throw new Error(`Account "${accountId}" no longer exists.`);
  let installed: Account | undefined;
  await rt.credentials.modify(
    selected.provider,
    async (current) => {
      const { result } = await store.update((vault) => {
        const target = vault.accounts.find((account) => account.id === accountId);
        if (!target) throw new Error(`Account "${accountId}" no longer exists.`);
        if (target.provider !== selected.provider) {
          throw new Error(`Account "${accountId}" changed while it was being installed.`);
        }

        if (current) {
          const currentOwner = ownerOf(vault, target.provider, current);
          if (!currentOwner) {
            throw new Error(
              `Current "${target.provider}" login is not saved in the vault; refusing to replace it.`,
            );
          }
          currentOwner.entry = current;
          currentOwner.identity = deriveCredentialIdentity(current);
          currentOwner.credentialObservedAt = Date.now();
          if (currentOwner.id === target.id) return structuredClone(currentOwner);
        }
        return structuredClone(target);
      });
      installed = result;
      return result.entry;
    },
    { signal },
  );

  if (!installed) throw new Error(`Account "${accountId}" could not be installed.`);
  active.set(installed.provider, installed.id);

  const refresh = await registry.refresh({
    allowNetwork: false,
    providers: [installed.provider],
    signal,
  });
  if (refresh.aborted) {
    throw new Error(
      `Installed ${installed.provider} credentials, but runtime synchronization was aborted.`,
    );
  }
  const refreshError = refresh.errors.get(installed.provider);
  if (refreshError) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    throw new Error(
      `Installed ${installed.provider} credentials, but runtime synchronization failed: ${message}`,
    );
  }
  return installed;
}
