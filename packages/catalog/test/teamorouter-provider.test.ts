import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { teamorouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.teamorouter.com/v1";

type Call = { url: string; authorization: string | null; clientSource: string | null };

function priceListFetch(models: unknown[], calls?: Call[]): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls?.push({
			url: String(input),
			authorization: headers.get("authorization"),
			clientSource: headers.get("x-client-source"),
		});
		return new Response(JSON.stringify({ models }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

// Rows in the shape `/v1/models/pricing` serves (USD per million tokens).
const SONNET = {
	id: "claude-sonnet-4-6",
	launch_at: "2026-02-17T00:00:00Z",
	billing_mode: "token",
	display_name: "Claude sonnet 4.6",
	owned_by: "Anthropic",
	context_window: 1000000,
	max_output_tokens: null,
	cost: { input: 0.861, output: 4.305, cached_input: 0.0861, cache_creation: 1.07625, cache_read: 0.0861 },
};
const DEEPSEEK = {
	id: "deepseek-v4-flash",
	launch_at: "2026-04-24T00:00:00Z",
	billing_mode: "token",
	display_name: "DeepSeek V4 Flash",
	owned_by: "deepseek",
	context_window: 1000000,
	max_output_tokens: null,
	cost: { input: 0.37444, output: 1.12332, cached_input: 0.011914, cache_read: 0.011914 },
};
const QWEN = {
	id: "qwen3.8-flash",
	billing_mode: "token",
	display_name: "Qwen3.8 Flash",
	owned_by: "qwen",
	context_window: 1000000,
	max_output_tokens: 65536,
	cost: { input: 0.1, output: 0.4 },
};

describe("TeamoRouter discovery", () => {
	test("reads the public price list without the key and tags the request", async () => {
		const calls: Call[] = [];
		const options = teamorouterModelManagerOptions({ apiKey: "sk-test", fetch: priceListFetch([DEEPSEEK], calls) });
		await options.fetchDynamicModels?.();
		expect(calls).toEqual([
			{ url: `${BASE_URL}/models/pricing`, authorization: null, clientSource: "omp-teamorouter" },
		]);
	});

	test("routes Claude to the Anthropic endpoint and everything else to chat completions", async () => {
		const options = teamorouterModelManagerOptions({ fetch: priceListFetch([SONNET, DEEPSEEK, QWEN]) });
		const byId = new Map(((await options.fetchDynamicModels?.()) ?? []).map(model => [model.id, model]));

		expect(byId.get("claude-sonnet-4-6")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.teamorouter.com",
			provider: "teamorouter",
			headers: { "X-Client-Source": "omp-teamorouter" },
			cost: { input: 0.861, output: 4.305, cacheRead: 0.0861, cacheWrite: 1.07625 },
		});
		expect(byId.get("deepseek-v4-flash")).toMatchObject({
			api: "openai-completions",
			baseUrl: BASE_URL,
			headers: { "X-Client-Source": "omp-teamorouter" },
			cost: { input: 0.37444, output: 1.12332, cacheRead: 0.011914, cacheWrite: 0 },
		});
		// No first-party row: text-only, non-reasoning, price-list limits.
		expect(byId.get("qwen3.8-flash")).toMatchObject({
			api: "openai-completions",
			name: "Qwen3.8 Flash",
			reasoning: false,
			input: ["text"],
			contextWindow: 1000000,
			maxTokens: 65536,
		});
	});

	test("takes reasoning and modalities from the first-party row and keeps the smaller window", async () => {
		const vendor = getBundledModels("anthropic").find(model => model.id === "claude-haiku-4-5");
		expect(vendor).toBeDefined();
		const options = teamorouterModelManagerOptions({
			fetch: priceListFetch([{ ...SONNET, id: "claude-haiku-4-5", context_window: 1000000 }]),
		});
		const [haiku] = (await options.fetchDynamicModels?.()) ?? [];
		expect(haiku).toMatchObject({
			id: "claude-haiku-4-5",
			reasoning: vendor!.reasoning,
			input: vendor!.input,
			contextWindow: Math.min(1000000, vendor!.contextWindow ?? Infinity),
			maxTokens: vendor!.maxTokens,
		});
	});

	test("drops rows that cannot serve a chat request", async () => {
		const options = teamorouterModelManagerOptions({
			fetch: priceListFetch([
				DEEPSEEK,
				{ ...DEEPSEEK, id: "gpt-image-2", billing_mode: "per_image" },
				{ ...DEEPSEEK, id: "gemini-3.1-flash-image" },
				{ ...DEEPSEEK, id: "deepseek-v4-flash-free" },
				{ ...DEEPSEEK, id: "gpt-6-astra (fast)" },
				{ ...DEEPSEEK, id: "claude-next", launch_at: "2999-01-01T00:00:00Z" },
			]),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];
		expect(models.map(model => model.id)).toEqual(["deepseek-v4-flash"]);
	});

	test("returns null when the price list is unavailable", async () => {
		const options = teamorouterModelManagerOptions({
			fetch: async () => new Response("bad gateway", { status: 502 }),
		});
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});

	test("accepts a base URL with or without /v1", async () => {
		for (const baseUrl of ["https://gw.example.com", "https://gw.example.com/v1/"]) {
			const calls: Call[] = [];
			const options = teamorouterModelManagerOptions({ baseUrl, fetch: priceListFetch([SONNET], calls) });
			const [sonnet] = (await options.fetchDynamicModels?.()) ?? [];
			expect(calls[0]?.url).toBe("https://gw.example.com/v1/models/pricing");
			expect(sonnet?.baseUrl).toBe("https://gw.example.com");
		}
	});
});
