import { type VM } from "@earendil-works/gondolin";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { toGuestPath } from "./paths.ts";

// These values describe the host process or point at host-only paths. Passing
// them into the guest breaks command lookup on hosts such as NixOS and can make
// guest tools read host-specific configuration. Other variables remain
// available so callers do not have to maintain a restrictive allowlist.
const HOST_BOUND_ENV_KEYS = new Set([
	"BASH_ENV",
	"BUN_INSTALL",
	"CARGO_HOME",
	"CONDA_DEFAULT_ENV",
	"CONDA_PREFIX",
	"CPATH",
	"CPLUS_INCLUDE_PATH",
	"C_INCLUDE_PATH",
	"DBUS_SESSION_BUS_ADDRESS",
	"DENO_INSTALL",
	"DISPLAY",
	"ENV",
	"GIT_ASKPASS",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_EXEC_PATH",
	"GIT_TEMPLATE_DIR",
	"GOBIN",
	"GOPATH",
	"GPG_AGENT_INFO",
	"HOME",
	"HOST",
	"HOSTNAME",
	"INFOPATH",
	"LD_LIBRARY_PATH",
	"LIBRARY_PATH",
	"LOCALE_ARCHIVE",
	"LOGNAME",
	"MANPATH",
	"NODE_PATH",
	"OLDPWD",
	"PATH",
	"PI_SESSION_FILE",
	"PKG_CONFIG_PATH",
	"PNPM_HOME",
	"PWD",
	"PYENV_ROOT",
	"RUSTUP_HOME",
	"SHELL",
	"SHLVL",
	"SSH_AGENT_PID",
	"SSH_ASKPASS",
	"SSH_AUTH_SOCK",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USER",
	"VIRTUAL_ENV",
	"WAYLAND_DISPLAY",
	"ZDOTDIR",
	"_",
]);

function isHostBoundEnvKey(key: string): boolean {
	return HOST_BOUND_ENV_KEYS.has(key) || key.startsWith("NIX_") || key.startsWith("__NIX") || key.startsWith("XDG_");
}

export function createGuestEnv(
	hostEnv: NodeJS.ProcessEnv | undefined,
	guestBaseEnv: Readonly<Record<string, string>>,
): Record<string, string> {
	const result = { ...guestBaseEnv };
	if (!hostEnv) return result;
	for (const [key, value] of Object.entries(hostEnv)) {
		if (typeof value === "string" && !isHostBoundEnvKey(key)) result[key] = value;
	}
	return result;
}

export function parseEnvironment(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return result;
}

export function createGondolinBashOps(
	vm: VM,
	localCwd: string,
	shellPath: string,
	guestBaseEnv: Readonly<Record<string, string>>,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			const guestCwd = toGuestPath(localCwd, cwd);
			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			let timedOut = false;
			const timer =
				timeout && timeout > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort();
						}, timeout * 1000)
					: undefined;

			try {
				const proc = vm.exec([shellPath, "-lc", command], {
					cwd: guestCwd,
					env: createGuestEnv(env, guestBaseEnv),
					signal: controller.signal,
					stdout: "pipe",
					stderr: "pipe",
				});
				for await (const chunk of proc.output()) onData(chunk.data);
				const result = await proc;
				return { exitCode: result.exitCode };
			} catch (error) {
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
