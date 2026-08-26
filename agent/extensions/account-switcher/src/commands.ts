import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deriveCredentialIdentity, sameIdentity } from "./identity";
import { activeIdOf, clearActive, install, runtimeOf, syncFromLive } from "./runtime";
import { EXT_ID, VaultStore } from "./vault";
import type { Account } from "./vault";

export function displayName(account: Account): string {
  return `${account.provider}:${account.label}`;
}

function operationSignal(ctx: ExtensionContext): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

async function pick(
  ui: ExtensionContext["ui"],
  store: VaultStore,
  title: string,
): Promise<string | undefined> {
  const accounts = (await store.read()).accounts;
  if (accounts.length === 0) {
    ui.notify("No accounts yet — `/account add` to capture the current login.", "warning");
    return undefined;
  }
  const items = accounts
    .map((account) => ({
      id: account.id,
      label: displayName(account) + (activeIdOf(account.provider) === account.id ? "  ✓" : ""),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const chosen = await ui.select(
    title,
    items.map((item) => item.label),
  );
  return chosen === undefined ? undefined : items.find((item) => item.label === chosen)?.id;
}

async function activate(
  ctx: ExtensionContext,
  store: VaultStore,
  accountId: string,
): Promise<void> {
  const rt = runtimeOf(ctx.modelRegistry);
  if (!rt) return ctx.ui.notify("Model registry unavailable.", "error");

  const account = (await store.read()).accounts.find((candidate) => candidate.id === accountId);
  if (!account) return ctx.ui.notify(`Account "${accountId}" no longer exists.`, "error");

  const previous = await syncFromLive(rt, store, account.provider, operationSignal(ctx));
  if (previous.live && !previous.owner) {
    ctx.ui.setStatus(EXT_ID, undefined);
    return ctx.ui.notify(
      `Current "${account.provider}" login is not saved in the vault — run \`/account add\` to keep it, then switch.`,
      "warning",
    );
  }

  let activeAccount = account;
  if (previous.owner?.id !== account.id) {
    try {
      activeAccount = await install(rt, ctx.modelRegistry, store, account.id, operationSignal(ctx));
    } catch (error) {
      let currentOwner: Account | undefined;
      try {
        currentOwner = (await syncFromLive(rt, store, account.provider)).owner;
      } catch {
        // Preserve the installation error below.
      }
      ctx.ui.setStatus(EXT_ID, currentOwner ? displayName(currentOwner) : undefined);
      return ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
  ctx.ui.setStatus(EXT_ID, displayName(activeAccount));
  ctx.ui.notify(`Active account: ${displayName(activeAccount)}`, "info");
}

export async function cmdSwitch(
  ctx: ExtensionContext,
  store: VaultStore,
  wanted?: string,
): Promise<void> {
  const accountId = wanted ?? (await pick(ctx.ui, store, "Switch to account:"));
  if (!accountId) return;
  await activate(ctx, store, accountId);
}

export async function cmdAdd(
  ctx: ExtensionContext,
  store: VaultStore,
  rest: string[],
): Promise<void> {
  const rt = runtimeOf(ctx.modelRegistry);
  if (!rt) return ctx.ui.notify("Model registry unavailable.", "error");

  const id = (rest[0] || (await ctx.ui.input("Account id:")))?.trim();
  if (!id) return;
  const label = (rest[1] || (await ctx.ui.input("Label:", id)) || id).trim();
  const provider = (
    rest[2] ||
    (await ctx.ui.input("Provider:", "openai-codex")) ||
    "openai-codex"
  ).trim();
  if (!label || !provider) return ctx.ui.notify("Label and provider must not be empty.", "error");

  const live = await rt.credentials.read(provider, { signal: operationSignal(ctx) });
  if (!live) {
    return ctx.ui.notify(
      `No credentials for "${provider}" — run /login first, then add the account.`,
      "error",
    );
  }

  try {
    await store.update((vault) => {
      if (vault.accounts.some((account) => account.id === id)) {
        throw new Error(`Account "${id}" already exists.`);
      }
      if (
        vault.accounts.some((account) => account.provider === provider && account.label === label)
      ) {
        throw new Error(`Account "${provider}:${label}" already exists.`);
      }
      const identity = deriveCredentialIdentity(live);
      if (
        vault.accounts.some(
          (account) => account.provider === provider && sameIdentity(account.identity, identity),
        )
      ) {
        throw new Error(`This "${provider}" login is already saved in the vault.`);
      }
      vault.accounts.push({
        id,
        label,
        provider,
        entry: live,
        identity,
        credentialObservedAt: Date.now(),
      });
    });
  } catch (error) {
    return ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
  await activate(ctx, store, id);
}

export async function cmdRemove(
  ctx: ExtensionContext,
  store: VaultStore,
  rest: string[],
): Promise<void> {
  const rt = runtimeOf(ctx.modelRegistry);
  if (!rt) return ctx.ui.notify("Model registry unavailable.", "error");

  const accountId = rest[0] ?? (await pick(ctx.ui, store, "Remove account:"));
  if (!accountId) return;
  const target = (await store.read()).accounts.find((account) => account.id === accountId);
  if (!target) return ctx.ui.notify(`Account "${accountId}" not found.`, "warning");

  const live = await syncFromLive(rt, store, target.provider, operationSignal(ctx));
  const removedActiveLogin = live.owner?.id === target.id;
  const { result: removed } = await store.update((vault) => {
    const index = vault.accounts.findIndex((account) => account.id === accountId);
    if (index < 0) return undefined;
    return vault.accounts.splice(index, 1)[0];
  });
  if (!removed) return ctx.ui.notify(`Account "${accountId}" was already removed.`, "warning");

  if (removedActiveLogin) {
    clearActive(target.provider);
    if (ctx.model?.provider === target.provider) ctx.ui.setStatus(EXT_ID, undefined);
    ctx.ui.notify(
      `Removed ${displayName(removed)} from the vault; the current login remains active. Use /logout to sign out.`,
      "info",
    );
  } else {
    if (ctx.model?.provider === target.provider) {
      ctx.ui.setStatus(EXT_ID, live.owner ? displayName(live.owner) : undefined);
    }
    ctx.ui.notify(`Removed ${displayName(removed)}.`, "info");
  }
}
