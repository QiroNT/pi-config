import { EventEmitter } from "node:events";
import path from "node:path";
import { Writable } from "node:stream";
import { toGuestPath } from "./paths.ts";
import { createGuestEnv } from "./shell.ts";
import type { GondolinRuntime } from "./vm.ts";

const CODEX_EXEC_ROUTER = Symbol.for("@howaboua/pi-codex-conversion.exec-router");

type SpawnOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal | null;
	stdio?: string | string[];
};

export type CodexRouter = {
	spawn(command: string, args: string[], options?: SpawnOptions): EventEmitter;
	prepareExecBridgeRequest(request: Record<string, unknown>): Record<string, unknown>;
};

export function createCodexRouter(runtime: GondolinRuntime, localCwd: string): CodexRouter {
	return {
		spawn(command, args, options = {}) {
			const vm = runtime.vm;
			if (!vm) throw new Error("Gondolin VM is not ready");
			const controller = new AbortController();
			const signal = options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal;
			const pipeStdin = options.stdio === "pipe" || (Array.isArray(options.stdio) && options.stdio[0] === "pipe");
			const process = vm.exec([command, ...args], {
				cwd: toGuestPath(localCwd, options.cwd ?? localCwd),
				env:
					path.basename(command) === "exec_bridge"
						? { ...runtime.guestBaseEnv }
						: createGuestEnv(options.env, runtime.guestBaseEnv),
				stdin: pipeStdin,
				signal,
				stdout: "pipe",
				stderr: "pipe",
			});
			const child = new EventEmitter() as EventEmitter & {
				stdout: typeof process.stdout;
				stderr: typeof process.stderr;
				stdin: Writable;
				killed: boolean;
				kill: () => boolean;
			};
			child.stdout = process.stdout;
			child.stderr = process.stderr;
			child.stdin = new Writable({
				write(chunk, _encoding, done) {
					try {
						process.write(chunk);
						done();
					} catch (error) {
						done(error as Error);
					}
				},
				final(done) {
					process.end();
					done();
				},
			});
			child.killed = false;
			child.kill = () => {
				child.killed = true;
				controller.abort();
				return true;
			};
			void process.then(
				(result) => child.emit("close", result.exitCode, null),
				(error) => child.emit("error", error),
			);
			return child;
		},

		prepareExecBridgeRequest(request) {
			if (request.op !== "exec") return request;

			// Fix env.SHELL in getCodexRuntimeShell.
			const argv = Array.isArray(request.argv) ? request.argv.map(String) : [];
			if (path.isAbsolute(argv[0] ?? "") && !argv[0]!.startsWith("/bin/") && !argv[0]!.startsWith("/usr/bin/")) {
				argv.splice(0, 1, "/usr/bin/env", path.basename(argv[0]!));
			}

			return {
				...request,
				argv,
				cwd: toGuestPath(localCwd, String(request.cwd ?? localCwd)),
				env: { ...runtime.guestBaseEnv },
			};
		},
	};
}

export function installCodexRouter(router: CodexRouter): void {
	(globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER] = router;
}

export function uninstallCodexRouter(router: CodexRouter): void {
	if ((globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER] === router) {
		delete (globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER];
	}
}
