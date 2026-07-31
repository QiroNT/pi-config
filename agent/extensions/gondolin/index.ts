/**
 * Gondolin Tool Routing Example
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Setup:
 *   cd packages/coding-agent/examples/extensions/gondolin
 *   npm install --ignore-scripts
 *   npm run build:image
 *
 * Usage:
 *   cd /path/to/project
 *   pi -e /path/to/pi/packages/coding-agent/examples/extensions/gondolin
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	buildAssets,
	getDefaultArch,
	importImageFromDirectory,
	RealFSProvider,
	ReadonlyProvider,
	resolveImageSelector,
	ShadowProvider,
	createShadowPathPredicate,
	setImageRef,
	type VirtualProvider,
	VM,
} from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUEST_WORKSPACE = "/workspace";
const GUEST_LIBRARIAN_CACHE_DIR = "/root/.cache/checkouts";
const HOST_PI_DIR = path.join(process.env.HOME ?? "", ".pi");
const HOST_LIBRARIAN_CACHE_DIR = path.join(process.env.HOME ?? "", ".cache", "checkouts");
const HOST_PI_CREDENTIAL_PATHS = [path.join(HOST_PI_DIR, "agent", "auth.json")];
const OCI_IMAGE = "pi-gondolin-rootfs:latest";
const DEFAULT_IMAGE = "pi-gondolin:latest";
const GONDOLIN_IMAGE = process.env.GONDOLIN_IMAGE ?? DEFAULT_IMAGE;
const DEFAULT_GREP_LIMIT = 100;
const CODEX_EXEC_ROUTER = Symbol.for("@howaboua/pi-codex-conversion.exec-router");

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
	const relativePath = path.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function protectPiCredentials(provider: VirtualProvider, hostRoot: string): VirtualProvider {
	const shadowPaths = HOST_PI_CREDENTIAL_PATHS.filter((credentialPath) =>
		isInsideHostPath(hostRoot, credentialPath),
	).map((credentialPath) => `/${toPosix(path.relative(hostRoot, credentialPath))}`);
	if (shadowPaths.length === 0) return provider;
	return new ShadowProvider(provider, {
		shouldShadow: createShadowPathPredicate(shadowPaths),
		writeMode: "deny",
	});
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
	const relativePath = path.relative(localCwd, hostPath);
	if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
	return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
	return {
		readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
		access: async (filePath) => {
			await vm.fs.access(toGuestPath(localCwd, filePath));
		},
		detectImageMimeType: async (filePath) => {
			const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
		},
		mkdir: async (dirPath) => {
			await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
		},
	};
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
	const readOps = createGondolinReadOps(vm, localCwd);
	const writeOps = createGondolinWriteOps(vm, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
		readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
	};
}

async function walkGuestFiles(
	vm: VM,
	root: string,
	visit: (guestPath: string, relativePath: string) => Promise<boolean>,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const stat = await vm.fs.stat(root, { signal });
	if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

	const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const entries = await vm.fs.listDir(dir, { signal });
		for (const entry of entries) {
			if (entry === ".git" || entry === "node_modules") continue;
			const guestPath = path.posix.join(dir, entry);
			const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
			let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
			try {
				entryStat = await vm.fs.stat(guestPath, { signal });
			} catch {
				continue;
			}
			if (entryStat.isDirectory()) {
				if (!(await walkDirectory(guestPath, relativePath))) return false;
			} else if (!(await visit(guestPath, relativePath))) {
				return false;
			}
		}
		return true;
	};

	return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = toPosix(pattern);
	if (normalizedPattern.includes("/")) {
		return (
			path.posix.matchesGlob(relativePath, normalizedPattern) ||
			path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
		);
	}
	return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
	return {
		exists: async (filePath) => {
			try {
				await vm.fs.access(toGuestPath(localCwd, filePath));
				return true;
			} catch {
				return false;
			}
		},
		glob: async (pattern, cwd, options) => {
			const root = toGuestPath(localCwd, cwd);
			const results: string[] = [];
			await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
				if (results.length >= options.limit) return false;
				if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
				return results.length < options.limit;
			});
			return results;
		},
	};
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
	outputLines: string[];
	lines: string[];
	relativePath: string;
	lineIndex: number;
	contextLines: number;
}): boolean {
	let linesTruncated = false;
	const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
	const end =
		params.contextLines > 0
			? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
			: params.lineIndex;

	for (let index = start; index <= end; index++) {
		const rawLine = params.lines[index] ?? "";
		const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
		if (wasTruncated) linesTruncated = true;
		const separator = index === params.lineIndex ? ":" : "-";
		params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
	}
	return linesTruncated;
}

async function executeGondolinGrep(
	vm: VM,
	localCwd: string,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = toGuestPath(localCwd, params.path ?? ".");
	const rootStat = await vm.fs.stat(root, { signal });
	const rootIsDirectory = rootStat.isDirectory();
	const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	const details: GrepToolDetails = {};
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;

	await walkGuestFiles(
		vm,
		root,
		async (guestPath, relativePath) => {
			if (matchCount >= effectiveLimit) return false;
			if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
			let content: string;
			try {
				content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
			} catch {
				return true;
			}
			const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
			for (let index = 0; index < lines.length; index++) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (!matcher(lines[index] ?? "")) continue;
				matchCount++;
				if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
					linesTruncated = true;
				}
				if (matchCount >= effectiveLimit) {
					matchLimitReached = true;
					return false;
				}
			}
			return true;
		},
		signal,
	);

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	let output = truncation.content;

	if (matchLimitReached) {
		details.matchLimitReached = effectiveLimit;
		notices.push(`${effectiveLimit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

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

function createGuestEnv(
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

function parseEnvironment(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return result;
}

function createGondolinBashOps(
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

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);

	let vm: VM | undefined;
	let vmStarting: Promise<VM> | undefined;
	let shellPath = "/bin/sh";
	let guestBaseEnv: Record<string, string> = {};

	async function ensureConfiguredImage(ctx?: ExtensionContext): Promise<void> {
		try {
			resolveImageSelector(GONDOLIN_IMAGE);
			return;
		} catch {
			if (process.env.GONDOLIN_IMAGE) throw new Error(`Gondolin image not found: ${GONDOLIN_IMAGE}`);
		}

		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: building ${OCI_IMAGE}`));
		const dockerBuild = await pi.exec(
			"docker",
			["build", "--file", path.join(EXTENSION_DIR, "bin", "Dockerfile"), "--tag", OCI_IMAGE, EXTENSION_DIR],
			{ timeout: 30 * 60 * 1000 },
		);
		if (dockerBuild.code !== 0) {
			throw new Error(`Failed to build ${OCI_IMAGE}: ${dockerBuild.stderr || dockerBuild.stdout}`);
		}

		const outputDir = fs.mkdtempSync(path.join("/tmp", "pi-gondolin-image-"));
		try {
			const result = await buildAssets(
				{
					arch: getDefaultArch(),
					distro: "alpine",
					oci: { image: OCI_IMAGE, pullPolicy: "never" },
					env: { PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
					runtimeDefaults: { rootfsMode: "cow" },
				},
				{ outputDir, verbose: true },
			);
			const imported = importImageFromDirectory(result.outputDir);
			setImageRef(GONDOLIN_IMAGE, imported.buildId, imported.arch);
		} finally {
			fs.rmSync(outputDir, { recursive: true, force: true });
		}
	}

	async function startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
		await ensureConfiguredImage(ctx);
		// Librarian manages persistent checkouts from inside the VM. Mount the host
		// cache at the guest user's default cache path so its helper can update it.
		fs.mkdirSync(HOST_LIBRARIAN_CACHE_DIR, { recursive: true });
		const mounts = {
			[GUEST_WORKSPACE]: new RealFSProvider(localCwd),
			[GUEST_LIBRARIAN_CACHE_DIR]: new RealFSProvider(HOST_LIBRARIAN_CACHE_DIR),
			[HOST_PI_DIR]: protectPiCredentials(
				new ReadonlyProvider(new RealFSProvider(HOST_PI_DIR)),
				HOST_PI_DIR,
			),
		};
		const created = await VM.create({
			sessionLabel: `pi ${path.basename(localCwd)}`,
			sandbox: { imagePath: GONDOLIN_IMAGE },
			vfs: { mounts },
		});
		const environmentProbe = await created.exec(["/usr/bin/env"]);
		guestBaseEnv = parseEnvironment(environmentProbe.stdout);
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		shellPath = bashProbe.stdout.trim() || "/bin/sh";
		vm = created;
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
		);
		ctx?.ui.notify(`Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
		return created;
	}

	async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (vm) return vm;
		if (!vmStarting) {
			vmStarting = startVm(ctx).finally(() => {
				vmStarting = undefined;
			});
		}
		return vmStarting;
	}

	const codexRouter = {
		spawn(command: string, args: string[], options: {
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			signal?: AbortSignal | null;
			stdio?: string | string[];
		} = {}) {
			if (!vm) throw new Error("Gondolin VM is not ready");
			const controller = new AbortController();
			const signal = options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal;
			const pipeStdin = options.stdio === "pipe" || Array.isArray(options.stdio) && options.stdio[0] === "pipe";
			const process = vm.exec([command, ...args], {
				cwd: toGuestPath(localCwd, options.cwd ?? localCwd),
				env: path.basename(command) === "exec_bridge"
					? { ...guestBaseEnv }
					: createGuestEnv(options.env, guestBaseEnv),
				stdin: pipeStdin,
				signal,
				stdout: "pipe",
				stderr: "pipe",
			});
			const child = new EventEmitter() as any;
			child.stdout = process.stdout;
			child.stderr = process.stderr;
			child.stdin = new Writable({
				write(chunk, _encoding, done) {
					try { process.write(chunk); done(); } catch (error) { done(error as Error); }
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
		prepareExecBridgeRequest(request: Record<string, unknown>) {
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
				env: { ...guestBaseEnv },
			};
		},
	};
	(globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER] = codexRouter;

	pi.on("session_start", async (_event, ctx) => {
		await ensureVm(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if ((globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER] === codexRouter) {
			delete (globalThis as Record<PropertyKey, unknown>)[CODEX_EXEC_ROUTER];
		}
		const activeVm = vm;
		vm = undefined;
		vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	});

	pi.registerCommand("gondolin", {
		description: "Show Gondolin VM status",
		handler: async (_args, ctx) => {
			const activeVm = await ensureVm(ctx);
			ctx.ui.notify(
				[
					`Gondolin VM: ${activeVm.id}`,
					`Host workspace: ${localCwd}`,
					`Guest workspace: ${GUEST_WORKSPACE}`,
					`Image: ${GONDOLIN_IMAGE}`,
					`Librarian cache: ${HOST_LIBRARIAN_CACHE_DIR} → ${GUEST_LIBRARIAN_CACHE_DIR}`,
					`Pi agent directory (read-only): ${HOST_PI_AGENT_DIR}`,
					`Shell: ${shellPath}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createReadTool(GUEST_WORKSPACE, {
				operations: createGondolinReadOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createWriteTool(GUEST_WORKSPACE, {
				operations: createGondolinWriteOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createEditTool(GUEST_WORKSPACE, {
				operations: createGondolinEditOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createBashTool(GUEST_WORKSPACE, {
				operations: createGondolinBashOps(activeVm, localCwd, shellPath, guestBaseEnv),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createLsTool(GUEST_WORKSPACE, {
				operations: createGondolinLsOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			const tool = createFindTool(GUEST_WORKSPACE, {
				operations: createGondolinFindOps(activeVm, localCwd),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const activeVm = await ensureVm(ctx);
			return executeGondolinGrep(activeVm, localCwd, params, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const activeVm = await ensureVm(ctx);
		return { operations: createGondolinBashOps(activeVm, localCwd, shellPath, guestBaseEnv) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureVm(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, guestLine)
			: `${event.systemPrompt}\n\n${guestLine}`;
		return { systemPrompt };
	});
}
