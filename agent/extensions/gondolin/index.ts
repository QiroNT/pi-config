/**
 * Routes pi's built-in tools and shell commands through a local Gondolin
 * micro-VM. The host working directory is mounted at /workspace in the guest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCodexRouter,
	installCodexRouter,
	uninstallCodexRouter,
} from "./src/codex-router.ts";
import {
	GONDOLIN_IMAGE,
	GUEST_LIBRARIAN_CACHE_DIR,
	HOST_LIBRARIAN_CACHE_DIR,
	HOST_PI_DIR,
	createGondolinRuntime,
} from "./src/vm.ts";
import { createGondolinBashOps } from "./src/shell.ts";
import { GUEST_WORKSPACE } from "./src/paths.ts";
import { registerGondolinTools } from "./src/tools.ts";

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const runtime = createGondolinRuntime(pi, localCwd);
	const codexRouter = createCodexRouter(runtime, localCwd);

	installCodexRouter(codexRouter);

	pi.on("session_start", async (_event, ctx) => {
		await runtime.ensureVm(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		uninstallCodexRouter(codexRouter);
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
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Image: ${GONDOLIN_IMAGE}`,
					`Librarian cache: ${HOST_LIBRARIAN_CACHE_DIR} → ${GUEST_LIBRARIAN_CACHE_DIR}`,
					`Pi directory (read-only): ${HOST_PI_DIR}`,
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
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
