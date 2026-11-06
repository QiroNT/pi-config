/**
 * magpie's images API, as Pi's image models: POST {gateway}/v1/images/generations.
 *
 * Adapted from the extension magpie writes for Pi itself (internal/agent/
 * pi_extension.ts): the same body, the same answer, the same zero cost.
 */

import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImagesContext,
  ImagesOptions,
  ImageModel,
  ProviderImages,
  TextContent,
} from "@earendil-works/pi-ai";

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** POST /v1/images/generations' answer, as this extension reads it. */
interface ImageAnswer {
  text?: string;
  data?: { b64_json?: string; url?: string; mime_type?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export function createDraw(): ProviderImages {
  return {
    async generateImages(model: ImageModel<ImageApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages> {
      const out: AssistantImages = {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        const input = context.input ?? [];
        const prompt = input
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const images = input
          .filter((block): block is ImageContent => block.type === "image")
          .map((image) => `data:${image.mimeType};base64,${image.data}`);

        const body: Record<string, unknown> = { model: model.id, prompt, response_format: "b64_json" };
        if (images.length) body.images = images;

        const answer = await (options?.fetch ?? fetch)(`${model.baseUrl.replace(/\/+$/, "")}/images/generations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options?.apiKey ?? ""}`,
            ...options?.headers,
          },
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        const text = await answer.text();
        let got: ImageAnswer | undefined;
        try {
          got = JSON.parse(text);
        } catch {
          got = undefined;
        }
        if (!answer.ok) {
          throw new Error(`magpie answered ${answer.status}: ${got?.error?.message ?? text.slice(0, 500)}`);
        }

        if (got?.text) out.output.push({ type: "text", text: got.text });
        for (const image of got?.data ?? []) {
          if (image.b64_json) {
            out.output.push({ type: "image", data: image.b64_json, mimeType: image.mime_type ?? "image/png" });
          } else if (image.url) {
            out.output.push({ type: "text", text: image.url });
          }
        }

        const usage = got?.usage;
        if (usage) {
          const input_tokens = usage.input_tokens ?? 0;
          const output_tokens = usage.output_tokens ?? 0;
          out.usage = {
            input: input_tokens,
            output: output_tokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: usage.total_tokens ?? input_tokens + output_tokens,
            cost: { ...NO_COST, total: 0 },
          };
        }
      } catch (error) {
        out.stopReason = options?.signal?.aborted ? "aborted" : "error";
        out.errorMessage = error instanceof Error ? error.message : String(error);
      }

      return out;
    },
  };
}
