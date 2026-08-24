/**
 * pi-docs-gate
 *
 * Strips the hardcoded "Pi documentation" section from the default system
 * prompt unless the workspace is inside the pi config tree (~/.pi), in which
 * case the docs are kept so they can actually be read.
 */

import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** True when cwd resolves inside the pi config directory (e.g. ~/.pi). */
export function isPiConfigWorkspace(cwd: string): boolean {
	const configRoot = realpathSync(dirname(getAgentDir()));
	const dir = realpathSync(cwd);
	return dir === configRoot || dir.startsWith(configRoot + sep);
}

/** Remove the Pi docs section (from its marker to the next blank-line boundary). */
export function stripPiDocsSection(systemPrompt: string): string {
	const idx = systemPrompt.indexOf("\nPi documentation (read only when");
	if (idx === -1) return systemPrompt;
	// The section ends at the first "\n\n" (before append-section,
	// <project_context>, skills block, or cwd line).
	const rest = systemPrompt.slice(idx).split("\n\n").slice(1).join("\n\n");
	return systemPrompt.slice(0, idx) + (rest ? "\n\n" + rest : "");
}

export default function piDocsGate(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (isPiConfigWorkspace(process.cwd())) return undefined;
		const stripped = stripPiDocsSection(event.systemPrompt);
		if (stripped === event.systemPrompt) return undefined;
		return { systemPrompt: stripped };
	});
}
