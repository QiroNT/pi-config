import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildAssets,
	getDefaultArch,
	importImageFromDirectory,
	RealFSProvider,
	ReadonlyProvider,
	resolveImageSelector,
	setImageRef,
	VM,
} from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUEST_WORKSPACE, protectPiCredentials } from "./paths.ts";
import { parseEnvironment } from "./shell.ts";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUEST_LIBRARIAN_CACHE_DIR = "/root/.cache/checkouts";
const HOST_LIBRARIAN_CACHE_DIR = path.join(process.env.HOME ?? "", ".cache", "checkouts");
export const HOST_PI_DIR = path.join(process.env.HOME ?? "", ".pi");
const HOST_PNPM_STORE_DIR = path.join(process.env.HOME ?? "", ".local", "share", "pnpm");

const OCI_IMAGE = "pi-gondolin-rootfs:latest";
const DEFAULT_IMAGE = "pi-gondolin:latest";
export const GONDOLIN_IMAGE = process.env.GONDOLIN_IMAGE ?? DEFAULT_IMAGE;

export interface GondolinRuntime {
	readonly vm: VM | undefined;
	readonly shellPath: string;
	readonly guestBaseEnv: Readonly<Record<string, string>>;
	ensureVm(ctx?: ExtensionContext): Promise<VM>;
	shutdown(ctx: ExtensionContext): Promise<void>;
}

class DefaultGondolinRuntime implements GondolinRuntime {
	#vm: VM | undefined;
	#vmStarting: Promise<VM> | undefined;
	#shellPath = "/bin/sh";
	#guestBaseEnv: Record<string, string> = {};
	readonly #pi: ExtensionAPI;
	readonly #localCwd: string;

	constructor(pi: ExtensionAPI, localCwd: string) {
		this.#pi = pi;
		this.#localCwd = localCwd;
	}

	get vm(): VM | undefined {
		return this.#vm;
	}

	get shellPath(): string {
		return this.#shellPath;
	}

	get guestBaseEnv(): Readonly<Record<string, string>> {
		return this.#guestBaseEnv;
	}

	async #ensureConfiguredImage(ctx?: ExtensionContext): Promise<void> {
		try {
			resolveImageSelector(GONDOLIN_IMAGE);
			return;
		} catch {
			if (process.env.GONDOLIN_IMAGE) throw new Error(`Gondolin image not found: ${GONDOLIN_IMAGE}`);
		}

		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: building ${OCI_IMAGE}`));
		const dockerBuild = await this.#pi.exec(
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

	async #startVm(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("gondolin", ctx.ui.theme.fg("accent", `Gondolin: starting ${GUEST_WORKSPACE}`));
		await this.#ensureConfiguredImage(ctx);
		const mounts = {
			[GUEST_WORKSPACE]: new RealFSProvider(this.#localCwd),
			[GUEST_LIBRARIAN_CACHE_DIR]: new RealFSProvider(HOST_LIBRARIAN_CACHE_DIR),
			[HOST_PI_DIR]: protectPiCredentials(new ReadonlyProvider(new RealFSProvider(HOST_PI_DIR)), HOST_PI_DIR),
			[HOST_PNPM_STORE_DIR]: new RealFSProvider(HOST_PNPM_STORE_DIR),
		};
		const created = await VM.create({
			sessionLabel: `pi ${path.basename(this.#localCwd)}`,
			sandbox: { imagePath: GONDOLIN_IMAGE },
			vfs: { mounts },
		});
		const environmentProbe = await created.exec(["/usr/bin/env"]);
		this.#guestBaseEnv = parseEnvironment(environmentProbe.stdout);
		const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
		this.#shellPath = bashProbe.stdout.trim() || "/bin/sh";
		this.#vm = created;
		ctx?.ui.setStatus(
			"gondolin",
			ctx.ui.theme.fg("accent", `Gondolin: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
		);
		ctx?.ui.notify(`Gondolin VM ready. ${this.#localCwd} is mounted at ${GUEST_WORKSPACE}.`, "info");
		return created;
	}

	async ensureVm(ctx?: ExtensionContext): Promise<VM> {
		if (this.#vm) return this.#vm;
		if (!this.#vmStarting) {
			this.#vmStarting = this.#startVm(ctx).finally(() => {
				this.#vmStarting = undefined;
			});
		}
		return this.#vmStarting;
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		const activeVm = this.#vm;
		this.#vm = undefined;
		this.#vmStarting = undefined;
		if (!activeVm) return;
		ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: stopping"));
		try {
			await activeVm.close();
		} finally {
			ctx.ui.setStatus("gondolin", undefined);
		}
	}
}

export function createGondolinRuntime(pi: ExtensionAPI, localCwd: string): GondolinRuntime {
	return new DefaultGondolinRuntime(pi, localCwd);
}
