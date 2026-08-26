/**
 * Account switcher for pi — swap OAuth/API-key credentials per provider.
 *
 * Entry point: syncs vaulted tokens with the live logins on session start,
 * keeps them fresh on every transition, and registers the `/account` command.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { VaultStore, EXT_ID } from "./src/vault";
import { runtimeOf, syncFromLive, activeIdOf } from "./src/runtime";
import { cmdAdd, cmdRemove, cmdSwitch, displayName } from "./src/commands";

export default async function accountSwitcher(pi: ExtensionAPI): Promise<void> {
  const store = new VaultStore();
  await store.read();

  async function showActive(ctx: ExtensionContext, provider?: string): Promise<void> {
    const rt = runtimeOf(ctx.modelRegistry);
    if (!rt || !provider) return;
    const { owner } = await syncFromLive(rt, store, provider);
    ctx.ui.setStatus(EXT_ID, owner ? displayName(owner) : undefined);
  }

  pi.on("session_start", async (_event, evCtx) => {
    await showActive(evCtx, evCtx.model?.provider);
  });

  pi.on("model_select", async (event, evCtx) => {
    await showActive(evCtx, event.model.provider);
  });

  pi.on("session_shutdown", async (_event, evCtx) => {
    try {
      const rt = runtimeOf(evCtx.modelRegistry);
      if (!rt) return;
      const vault = await store.read();
      for (const provider of new Set(vault.accounts.map((a) => a.provider))) {
        await syncFromLive(rt, store, provider);
      }
    } catch {
      // shutdown must never throw
    }
  });

  pi.registerCommand("account", {
    description: "Switch, add, or remove provider accounts",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const parts = prefix.trim().split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(prefix);
      if (parts.length <= 1 && !trailingSpace) {
        const items: AutocompleteItem[] = [
          { value: "switch", label: "switch", description: "Pick the active account" },
          { value: "add", label: "add", description: "Capture current login as a new account" },
          { value: "remove", label: "remove", description: "Remove an account" },
        ];
        const filtered = items.filter((i) => i.value.startsWith(parts[0] ?? ""));
        return filtered.length > 0 ? filtered : null;
      }
      const cmd = parts[0];
      if (cmd !== "switch" && cmd !== "remove") return null;
      const partial = trailingSpace ? "" : (parts[parts.length - 1] ?? "");
      const items = store.snapshot.accounts
        .map((a) => ({
          value: a.id,
          label: displayName(a) + (activeIdOf(a.provider) === a.id ? "  ✓" : ""),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      const filtered = items.filter((i) => i.value.startsWith(partial));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, cmdCtx) => {
      await cmdCtx.waitForIdle();
      const rest = args.trim().split(/\s+/).filter(Boolean);
      const [cmd, ...operand] = rest;
      switch (cmd ?? "switch") {
        case "switch":
          return cmdSwitch(cmdCtx, store, operand[0]);
        case "add":
          return cmdAdd(cmdCtx, store, operand);
        case "remove":
          return cmdRemove(cmdCtx, store, operand);
        default:
          return cmdCtx.ui.notify(
            `Unknown subcommand "${cmd}". Use switch | add | remove.`,
            "warning",
          );
      }
    },
  });
}
