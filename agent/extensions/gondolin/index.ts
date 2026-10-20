/**
 * Routes pi's built-in tools and shell commands through a local Gondolin
 * micro-VM. The host working directory is mounted at /workspace in the guest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGondolinRuntime } from "./src/vm.ts";
import { createGondolinBashOps } from "./src/shell.ts";
import { GUEST_WORKSPACE } from "./src/paths.ts";
import { registerGondolinTools } from "./src/tools.ts";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const runtime = createGondolinRuntime(pi, localCwd);

  pi.on("session_start", async (_event, ctx) => {
    await runtime.ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.shutdown(ctx);
  });

  pi.registerCommand("gondolin", {
    description: "Show Gondolin VM status",
    handler: async (_args, ctx) => {
      const vm = await runtime.ensureVm(ctx);
      ctx.ui.notify(
        [
          `Gondolin VM: ${vm.id}`,
          `Host workspace: ${localCwd}`,
          `Shell: ${runtime.shellPath}`,
        ].join("\n"),
        "info",
      );
    },
  });

  registerGondolinTools(pi, localCwd, runtime);

  pi.on("user_bash", async (_event, ctx) => {
    const vm = await runtime.ensureVm(ctx);
    return {
      operations: createGondolinBashOps(vm, localCwd, runtime.shellPath, runtime.guestBaseEnv),
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await runtime.ensureVm(ctx);
    event.systemPromptOptions.cwd = `${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
  });
}
