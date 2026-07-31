import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { GUEST_WORKSPACE } from "./paths.ts";
import {
	createGondolinEditOps,
	createGondolinFindOps,
	createGondolinLsOps,
	createGondolinReadOps,
	createGondolinWriteOps,
} from "./file.ts";
import { executeGondolinGrep } from "./grep.ts";
import { createGondolinBashOps } from "./shell.ts";
import type { GondolinRuntime } from "./vm.ts";

export function registerGondolinTools(
	pi: ExtensionAPI,
	localCwd: string,
	runtime: GondolinRuntime,
): void {
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(vm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(vm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(vm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(vm, localCwd, runtime.shellPath, runtime.guestBaseEnv),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(vm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(vm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const vm = await runtime.ensureVm(ctx);
			return executeGondolinGrep(vm, localCwd, params, signal);
		},
	});
}
