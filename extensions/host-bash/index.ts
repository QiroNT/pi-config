import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

const VM_COMMAND_NOT_FOUND = /(?:command not found|Command exited with code 127)/i;
const HOST_BASH_HINT =
	"[Hint: This command appears to be unavailable in the VM. If it may be installed on the host, retry with host_bash.]";

/**
 * Adds an explicitly approved escape hatch for commands that must run on the
 * host instead of in the Gondolin VM.
 */
export default function (pi: ExtensionAPI) {
	const hostCwd = process.cwd();
	const commaPicker = fileURLToPath(new URL("./bin/comma-picker", import.meta.url));

	// Pi's modal UI supports only one prompt at a time. Tool calls may execute
	// concurrently, so queue approval prompts while allowing approved commands
	// to continue running in parallel.
	let approvalQueue: Promise<void> = Promise.resolve();
	const requestApproval = (command: string, signal: AbortSignal, ctx: ExtensionContext) => {
		const approval = approvalQueue.then(async () => {
			if (signal.aborted) throw signal.reason ?? new Error("Host command cancelled");
			return ctx.ui.confirm(
				"Run command outside the VM?",
				[`Host working directory: ${hostCwd}`, "", command].join("\n"),
				{ signal },
			);
		});
		approvalQueue = approval.then(
			() => undefined,
			() => undefined,
		);
		return approval;
	};

	// Use the definition rather than the SDK-wrapped tool so host_bash keeps
	// bash's renderCall/renderResult, including collapsed output previews.
	const hostBash = createBashToolDefinition(hostCwd, {
		spawnHook(context) {
			return {
				...context,
				env: { ...context.env, COMMA_PICKER: commaPicker },
			};
		},
	});

	pi.registerTool({
		...hostBash,
		name: "host_bash",
		label: "host bash",
		description:
			"Execute a bash command on the host machine, outside the VM. Returns stdout and stderr using the same truncation limits as bash.",
		promptSnippet: "Execute a command on the host outside the VM",
		promptGuidelines: [
			"Use host_bash only when a required command is unavailable in the Gondolin VM or the user explicitly asks for host execution.",
			"When host_bash is appropriate, call it directly without asking for approval in chat; the tool displays its own approval prompt in the UI.",
		],
		async execute(id, params, signal, onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("Host command denied: interactive user approval is unavailable");
			}

			const approved = await requestApproval(params.command, signal, ctx);
			if (!approved) throw new Error("Host command denied by user");

			return hostBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !event.isError) return;

		const output = event.content
			.filter((item): item is Extract<(typeof event.content)[number], { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		if (!VM_COMMAND_NOT_FOUND.test(output) || output.includes(HOST_BASH_HINT)) return;

		return {
			content: [...event.content, { type: "text" as const, text: HOST_BASH_HINT }],
		};
	});
}
