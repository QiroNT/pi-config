import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Api, type FetchFunction, type Model, openAIResponsesApi } from "@earendil-works/pi-ai/compat";

const FLEX = "flex";
const STANDARD = "auto";
const FLEX_WINDOW_MS = 30_000;

const APIS = new Set(["openai-completions", "anthropic-messages"]);
// add the model id if it hits a 400 for service_tier
const SKIP = /^(gpt-3\.5|gpt-4\b|gpt-4o|gpt-4\.1|o1-mini)/;

// don't hammer flex again on the automatic retries that follow a fallback.
let flexCooldownUntil = 0;

interface FlexState {
	tier: typeof FLEX | typeof STANDARD;
	failedSince?: number;
	attempt: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlexModel(model: Model<Api> | undefined): model is Model<Api> {
	if (!model || SKIP.test(model.id)) return false;
	if (model.provider === "openai") return model.api === "openai-responses";
	if (model.provider === "openrouter") return APIS.has(model.api);
	return false;
}

function withFloorVariant(payload: unknown): unknown {
	if (!isRecord(payload) || typeof payload.model !== "string") return payload;
	if (payload.model.endsWith(":floor")) return payload;
	return { ...payload, model: `${payload.model}:floor` };
}

function parseJsonBody(body: BodyInit | null | undefined): JsonRecord | undefined {
	if (typeof body !== "string") return undefined;

	try {
		const parsed: unknown = JSON.parse(body);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function retryAfterMs(headers: Headers): number | undefined {
	const retryAfterMilliseconds = headers.get("retry-after-ms");
	if (retryAfterMilliseconds) {
		const value = Number.parseFloat(retryAfterMilliseconds);
		if (Number.isFinite(value)) return value;
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;

	const seconds = Number.parseFloat(retryAfter);
	return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

const NON_RETRYABLE = /insufficient_quota|billing|quota exceeded|out of budget|usage limit|payment required/i;
const FLEX_UNAVAILABLE = /flex|resource.{0,24}unavailable|capacity|overloaded|server.?busy|temporarily unavailable|try again/i;

async function isFlexUnavailable(response: Response): Promise<boolean> {
	if (response.status !== 429 && response.status !== 503) return false;
	if (response.headers.get("x-should-retry") === "false") return false;

	let body = "";
	try {
		body = await response.clone().text();
	} catch {
	}

	if (NON_RETRYABLE.test(body)) return false;
	if (response.headers.get("x-should-retry") === "true") return true;
	if (FLEX_UNAVAILABLE.test(body)) return true;

	return body.length === 0;
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}

		const finish = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};

		const abort = () => {
			clearTimeout(timer);
			reject(abortError());
		};

		const timer = setTimeout(finish, Math.max(0, ms));
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function createFlexFetch(state: FlexState, baseFetch: FetchFunction): FetchFunction {
	return async (input, init) => {
		const body = parseJsonBody(init?.body);
		if (!body || typeof body.model !== "string") return baseFetch(input, init);

		for (;;) {
			const requestInit: RequestInit = {
				...init,
				body: JSON.stringify({ ...body, service_tier: state.tier }),
			};
			const response = await baseFetch(input, requestInit);

			if (state.tier !== FLEX || !(await isFlexUnavailable(response))) return response;
			await response.body?.cancel().catch(() => {});

			const now = Date.now();
			state.failedSince ??= now;
			const remaining = FLEX_WINDOW_MS - (now - state.failedSince);
			const serverDelay = retryAfterMs(response.headers);

			if (remaining <= 0 || (serverDelay !== undefined && serverDelay > remaining)) {
				state.tier = STANDARD;
				flexCooldownUntil = now + FLEX_WINDOW_MS;
				continue;
			}

			const delay = serverDelay ?? Math.min(1_000 * 2 ** state.attempt, remaining);
			state.attempt++;
			await sleep(delay, init?.signal);
		}
	};
}

export default function (pi: ExtensionAPI) {
	const responsesApi = openAIResponsesApi();

	pi.registerProvider("openai", {
		api: "openai-responses",
		streamSimple(model, context, options) {
			if (!isFlexModel(model)) return responsesApi.streamSimple(model, context, options);

			const state: FlexState = {
				tier: Date.now() < flexCooldownUntil ? STANDARD : FLEX,
				attempt: 0,
			};
			const flexOptions = {
				...options,
				fetch: createFlexFetch(state, options?.fetch ?? globalThis.fetch),
			};

			return responsesApi.streamSimple(model, context, flexOptions);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!isFlexModel(model) || model.provider !== "openrouter") return;

		return withFloorVariant(event.payload);
	});
}
