import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { chunkMarkdown, estimateTokens } from "../pipeline/chunk.ts";
import { fetchPage } from "../pipeline/fetch.ts";
import { evidenceQuestion, judgeChunks, selectChunks } from "../pipeline/judge-jev.ts";
import { webSearch } from "../pipeline/search.ts";
import { type FetchView, renderFetchView } from "./view.ts";

const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, jev-1.13.0, input tokens only

// The key comes from the environment. A local checkout may keep it in the package .env instead.
function loadKey() {
	if (process.env.TYPESAFE_API_KEY) return;
	const envFile = new URL("../../.env", import.meta.url).pathname;
	if (!existsSync(envFile)) return;
	const key = parseEnv(readFileSync(envFile, "utf8")).TYPESAFE_API_KEY;
	if (key) process.env.TYPESAFE_API_KEY = key;
}

export default function (pi: ExtensionAPI) {
	loadKey();

	const totals = { sources: 0, chunks: 0, pageTokens: 0, keptTokens: 0, usd: 0, ms: 0 };
	const showTotals = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
		ctx.ui.setWidget("jev-search", [
			ctx.ui.theme.fg(
				"dim",
				`jev-search  ${totals.sources} sources · ${k(totals.chunks)} chunks judged · ${k(totals.pageTokens)} tokens read → ${k(totals.keptTokens)} kept · ${(totals.ms / 1000).toFixed(1)}s in Jev · $${totals.usd.toFixed(3)}`,
			),
		]);
	};
	pi.on("session_start", async () => {
		Object.assign(totals, { sources: 0, chunks: 0, pageTokens: 0, keptTokens: 0, usd: 0, ms: 0 });
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web. Returns titles, URLs and snippets. Read the pages with jev_fetch.",
		promptSnippet: "Search the web for pages to read with jev_fetch",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(Type.Number({ description: "Default 10" })),
		}),
		async execute(_id, params, signal) {
			const results = await webSearch(params.query, params.max_results ?? 10, signal);
			const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
			return { content: [{ type: "text", text }], details: { results } };
		},
	});

	pi.registerTool({
		name: "jev_fetch",
		label: "Jev Fetch",
		description:
			"Read a full web page of any length. The page is never cut. Jev checks every part of the page against your questions and returns only the parts that answer them, word for word, with a probability. Reading is cheap: call jev_fetch for many URLs in parallel.",
		promptSnippet: "Read a full web page and get back only the passages that answer your questions",
		promptGuidelines: [
			"Use jev_fetch to read web pages. Give jev_fetch specific, literal questions that name the entities involved; one fact per question.",
			"Call jev_fetch on many search results in parallel (8 or more) instead of picking a few: pages that do not answer the questions return nothing and cost almost nothing.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Page URL" }),
			questions: Type.Array(Type.String(), {
				description: "1 to 6 specific questions. Jev keeps the passages that answer any of them.",
				minItems: 1,
				maxItems: 6,
			}),
			budget_tokens: Type.Optional(Type.Number({ description: "Most tokens of page text to return. Default 3000." })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set. Export it, or put it in the jev-search .env file.");

			const page = await fetchPage(params.url, { signal });
			const chunks = chunkMarkdown(page.markdown);
			const view: FetchView = {
				title: page.title || params.url,
				url: params.url,
				scores: new Array(chunks.length).fill(-1),
				cutChunk: chunks.findIndex((chunk) => chunk.start >= 100_000),
				pageTokens: estimateTokens(page.markdown),
				kept: [],
				keptTokens: 0,
				ms: 0,
				usd: 0,
			};
			const update = () => onUpdate?.({ content: [{ type: "text", text: "Judging chunks..." }], details: { ...view, scores: [...view.scores] } });
			update();

			const questions = params.questions.map((question, i) => evidenceQuestion(`q${i + 1}`, question));
			const { judgments, metrics } = await judgeChunks(chunks, questions, {
				pageTitle: page.title,
				signal,
				onBatch: (batch) => {
					for (const j of batch) view.scores[j.chunk.index] = Math.max(...Object.values(j.p));
					update();
				},
			});

			const selected = selectChunks(judgments, { budgetTokens: params.budget_tokens ?? 3000 });
			view.kept = selected.map((j) => ({ index: j.chunk.index, p: Math.max(...Object.values(j.p)), preview: j.chunk.text.slice(0, 120).replace(/\s+/g, " ") }));
			view.keptTokens = selected.reduce((sum, j) => sum + estimateTokens(j.chunk.text), 0);
			view.ms = metrics.wallMs;
			view.usd = (metrics.inputTokens / 1e6) * USD_PER_MTOK;

			totals.sources++;
			totals.chunks += judgments.length;
			totals.pageTokens += view.pageTokens;
			totals.keptTokens += view.keptTokens;
			totals.usd += view.usd;
			totals.ms += metrics.wallMs;
			showTotals(ctx);

			const header = `Source: ${page.title}\nURL: ${params.url}\nPage: ${view.pageTokens} tokens in ${chunks.length} chunks, all judged. Kept ${selected.length} chunks (${view.keptTokens} tokens).${metrics.failedRequests ? ` ${metrics.failedRequests} judge requests failed; some chunks were not judged.` : ""}`;
			const best = Math.max(...judgments.map((j) => Math.max(...Object.values(j.p))), 0);
			const body =
				selected.length === 0
					? `No passage answers the questions (best probability ${best.toFixed(2)}). This page likely does not contain the answer.`
					: selected
							.map((j) => {
								const answered = params.questions.map((_, i) => `q${i + 1}`).filter((id) => j.p[id] >= 0.5);
								return `[chunk ${j.chunk.index} · p=${Math.max(...Object.values(j.p)).toFixed(2)} · ${answered.join(",")} · ${j.chunk.headingPath.join(" > ")}]\n${j.chunk.text}`;
							})
							.join("\n\n---\n\n");
			const legend = params.questions.map((question, i) => `q${i + 1}: ${question}`).join("\n");
			return { content: [{ type: "text", text: `${header}\n${legend}\n\n${body}` }], details: { ...view } };
		},

		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("jev_fetch "))}${theme.fg("muted", args.url ?? "")}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const view = result.details as FetchView | undefined;
			if (!view?.scores) return new Text(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), 0, 0);
			return new Text(renderFetchView(view, expanded, theme), 0, 0);
		},
	});
}
