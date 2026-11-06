/**
 * The provider: magpie's catalog as Pi models, with the credential `/login`
 * stores and nothing in magpie.json.
 *
 * Chat models are dispatched by the API their `native_endpoints` name, so
 * magpie relays a request instead of translating it; classifier and image
 * models carry their own API ids and go through the maps below.
 */

import {
  createProvider,
  type AnyModel,
  type Api,
  type AuthResult,
  type Provider,
  type ProviderAuth,
  type ProviderAuthInteraction,
  type ProviderClassifier,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { fetchCatalog } from "./catalog.ts";
import { PROVIDER_ID, type Features } from "./config.ts";
import { gatewayFromCredential, gatewayOf, headersOf, normalizeUrl } from "./gateway.ts";
import { createDraw } from "./images.ts";

export interface ProviderOptions {
  /** The toggles as they stand; read on every refresh, so they can change. */
  features: () => Features;
  /** Whether Pi here has classifier models to hand a decision to. */
  classifier: boolean;
  /** magpie's decision models go to Pi's own System One implementation. */
  classify?: ProviderClassifier;
}

export function buildProvider(options: ProviderOptions): Provider<Api> {
  const auth: ProviderAuth = {
    apiKey: {
      name: "magpie gateway (URL + key)",
      async login(interaction: ProviderAuthInteraction) {
        const url = normalizeUrl(
          await interaction.prompt({
            type: "text",
            message: "magpie gateway URL",
            placeholder: "http://127.0.0.1:3425",
          }),
        );
        const key = (
          await interaction.prompt({
            type: "secret",
            message: "gateway key (Settings → Network and sharing)",
          })
        ).trim();

        const version = await verify(url, key);
        interaction.notify({ type: "info", message: `magpie ${version} at ${url} answers` });

        // the URL rides in the credential's env, which is what ProviderEnv is
        // for: one credential, both halves, nothing secret in magpie.json
        return { type: "api_key", key, env: { MAGPIE_URL: url } };
      },
      async resolve(input): Promise<AuthResult | undefined> {
        const url =
          input.credential?.env?.MAGPIE_URL ?? (await input.ctx.env("MAGPIE_URL")) ?? "";
        const key = input.credential?.key ?? (await input.ctx.env("MAGPIE_API_KEY")) ?? "";

        const gateway = gatewayOf(url, key);
        if (!gateway) return undefined;

        return {
          auth: { apiKey: key },
          env: { MAGPIE_URL: gateway.url },
          source: `magpie at ${gateway.url}`,
        };
      },
    },
  };

  return createProvider({
    id: PROVIDER_ID,
    name: "magpie",
    auth,
    models: [],
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
    },
    images: { "magpie-images": createDraw() },
    ...(options.classify ? { classifiers: { "typesafe-system-one": options.classify } } : {}),
    fetchModels: async (context: RefreshModelsContext): Promise<readonly AnyModel[]> => {
      // no credential: nothing to offer, and the models go with it
      const gateway = gatewayFromCredential(context.credential);
      if (!gateway) return [];

      // a gateway that is down must throw: what fetchModels returns replaces
      // (and is persisted over) the list Pi last published, so `[]` would
      // empty it. Pi keeps the restored list when this rejects.
      return fetchCatalog(gateway, options.features(), { classifier: options.classifier }, context.signal);
    },
  });
}

/** GET /v1 then /v1/models: a wrong key or an unreachable host fails the login. */
async function verify(url: string, key: string): Promise<string> {
  const gateway = gatewayOf(url, key);
  if (!gateway) throw new Error("no gateway URL: run `magpie serve` and give its address");

  const get = (target: string): Promise<Response> =>
    fetch(target, { headers: headersOf(gateway), signal: AbortSignal.timeout(10_000) }).catch((error: Error) => {
      throw new Error(`magpie at ${gateway.url} is unreachable: ${error.message}`);
    });

  const info = await get(`${gateway.url}/v1`);
  if (!info.ok) {
    throw new Error(`magpie at ${gateway.url} answered ${info.status}: ${(await info.text()).slice(0, 200)}`);
  }
  const body: { version?: string } | undefined = await info.json().catch(() => undefined);

  const models = await get(`${gateway.v1}/models`);
  if (models.status === 401 || models.status === 403) {
    throw new Error(`magpie at ${gateway.url} refused the key (${models.status})`);
  }

  return body?.version ?? "an unversioned build";
}
