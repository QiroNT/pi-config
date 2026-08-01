import path from "node:path";
import {
	createShadowPathPredicate,
	ShadowProvider,
	type VirtualProvider,
} from "@earendil-works/gondolin";
import { HOST_PI_DIR } from "./vm.ts";

export const GUEST_WORKSPACE = "/workspace";

const HOST_PI_CREDENTIAL_PATHS = [
	path.join(HOST_PI_DIR, "agent", "auth.json")
];

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

export function protectPiCredentials(provider: VirtualProvider, hostRoot: string): VirtualProvider {
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

export function toGuestPath(localCwd: string, inputPath: string): string {
	const trimmed = stripAtPrefix(inputPath.trim());
	if (!trimmed) return GUEST_WORKSPACE;
	if (path.isAbsolute(trimmed)) {
		if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
		return path.posix.resolve("/", toPosix(trimmed));
	}
	return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}
