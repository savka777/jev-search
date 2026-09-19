import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { chunkMarkdown, estimateTokens } from "../pipeline/chunk.ts";
import { fetchPage } from "../pipeline/fetch.ts";
import { evidenceQuestion, judgeChunks, selectChunks } from "../pipeline/judge-jev.ts";
import { type ResearchState, runResearch } from "../pipeline/research.ts";
import { webSearch } from "../pipeline/search.ts";
import { type FetchView, renderFetchView, renderResearchView } from "./view.ts";

const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, jev-1.13.0, input tokens only

// Keys are never part of the package. Order: environment, then the file written by /jev-key, then a .env in a local checkout.
const KEY_NAMES = ["TYPESAFE_API_KEY", "BRAVE_API_KEY"] as const;
const KEY_FILE = join(homedir(), ".pi", "agent", "jev-search.env");
const NO_KEY = "No TypeSafe API key. Run /jev-key in pi, or set TYPESAFE_API_KEY. Get a key at https://console.typesafe.ai/keys";

const readEnvFile = (file: string): Record<string, string | undefined> => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {});

function loadKeys() {
	for (const file of [KEY_FILE, new URL("../../.env", import.meta.url).pathname]) {
		const values = readEnvFile(file);
		for (const name of KEY_NAMES) if (!process.env[name] && values[name]) process.env[name] = values[name];
	}
}

export default function (pi: ExtensionAPI) {
	loadKeys();

	pi.registerCommand("jev-key", {
		description: "Save your TypeSafe API key for jev-search (or: /jev-key brave, for a Brave Search key)",
		handler: async (args, ctx) => {
			const name = args.trim().toLowerCase() === "brave" ? "BRAVE_API_KEY" : "TYPESAFE_API_KEY";
			const hint = name === "BRAVE_API_KEY" ? "Brave Search API key (optional, for reliable search)" : "TypeSafe API key, from https://console.typesafe.ai/keys";
			const key = (await ctx.ui.input(hint, ""))?.trim();
			if (!key) return;
			const values = { ...readEnvFile(KEY_FILE), [name]: key };
			writeFileSync(KEY_FILE, `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
			process.env[name] = key;
			ctx.ui.notify(`jev-search: key saved to ${KEY_FILE}`, "info");
		},
	});

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
	pi.on("session_start", async (_event, ctx) => {
		Object.assign(totals, { sources: 0, chunks: 0, pageTokens: 0, keptTokens: 0, usd: 0, ms: 0 });
		if (!process.env.TYPESAFE_API_KEY && ctx.hasUI) ctx.ui.notify(`jev-search: ${NO_KEY}`, "warning");
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
			if (!process.env.TYPESAFE_API_KEY) throw new Error(NO_KEY);

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

	pi.registerTool({
		name: "jev_research",
		label: "Jev Research",
		description:
			"One fast research round. Runs all search queries, reads every result page in full and in parallel, and lets Jev judge every part of every page against every sub-question. Returns the coverage of each sub-question (how many independent sources answer it) and the passages that answer it, word for word. A round takes seconds, so use many queries and many pages.",
		promptSnippet: "Research round: many searches and pages at once, returns coverage and exact passages per sub-question",
		promptGuidelines: [
			"Use jev_research for web research: give jev_research 2 to 8 literal sub-questions with acceptance criteria and 3 to 10 search queries. Read its coverage table, then call jev_research again with new queries for the sub-questions that are still open or partial.",
		],
		parameters: Type.Object({
			sub_questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "One literal question that a single passage can answer. Name the entities." }),
					criteria: Type.Optional(Type.String({ description: "What counts as an answer, and what does not." })),
					min_sources: Type.Optional(Type.Number({ description: "Independent sources needed to call it covered. Default 2." })),
				}),
				{ minItems: 1, maxItems: 8 },
			),
			queries: Type.Array(Type.String(), { description: "Web search queries", minItems: 1, maxItems: 12 }),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Pages to read in addition to the search results" })),
			max_pages: Type.Optional(Type.Number({ description: "Default 40" })),
			budget_tokens: Type.Optional(Type.Number({ description: "Most tokens of passages to return. Default 8000." })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			if (!process.env.TYPESAFE_API_KEY) throw new Error(NO_KEY);

			let lastUpdate = 0;
			const { state, snippets } = await runResearch(
				{
					subQuestions: params.sub_questions.map((sub) => ({ question: sub.question, criteria: sub.criteria, minSources: sub.min_sources })),
					queries: params.queries,
					urls: params.urls,
					maxPages: params.max_pages,
					budgetTokens: params.budget_tokens,
				},
				{
					signal,
					onProgress: (progress) => {
						if (performance.now() - lastUpdate < 120) return;
						lastUpdate = performance.now();
						onUpdate?.({ content: [{ type: "text", text: "Researching..." }], details: structuredClone(progress) });
					},
				},
			);

			totals.sources += state.sources.filter((source) => source.status === "done").length;
			totals.chunks += state.chunksJudged;
			totals.pageTokens += state.pageTokens;
			totals.keptTokens += state.keptTokens;
			totals.usd += state.usd;
			totals.ms += state.ms;
			showTotals(ctx);

			const done = state.sources.filter((source) => source.status === "done").length;
			const failed = state.sources.filter((source) => source.status === "failed");
			const open = state.coverage.filter((cover) => cover.status !== "covered");
			const text = [
				`Round: ${state.queriesTotal} queries → ${state.sources.length} links → ${done} pages read in full (${failed.length} blocked or failed) · ${state.chunksJudged} chunks judged · ${state.pageTokens} tokens read → ${state.keptTokens} kept · ${(state.ms / 1000).toFixed(1)} s`,
				"",
				"COVERAGE (a source counts when Jev gives p ≥ 0.8 that a passage answers the sub-question; p is not proof that the statement is true)",
				...state.coverage.map((cover) => `${cover.id} [${cover.status}, ${cover.hosts.length}/${cover.needed} sources, best p=${cover.bestP.toFixed(2)}] ${cover.question}`),
				"",
				"EVIDENCE (exact text from the pages)",
				...snippets.map((snippet, i) => `[${i + 1}] ${snippet.ids.join(",")} · p=${snippet.p.toFixed(2)} · ${snippet.title} · ${snippet.url} · chunk ${snippet.chunk}${snippet.section ? ` · ${snippet.section}` : ""}\n${snippet.text}`),
				"",
				open.length
					? `NEXT: ${open.map((cover) => cover.id).join(", ")} not covered yet. Call jev_research again with new queries for those sub-questions only, or report them as not found.`
					: "NEXT: every sub-question is covered. Check the passages for conflicts, then write the report.",
				...(state.searchErrors.length ? ["", `SEARCH ERRORS: ${state.searchErrors.join(" | ")}`] : []),
			].join("\n");
			return { content: [{ type: "text", text }], details: state };
		},

		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("jev_research "))}${theme.fg("muted", `${args.sub_questions?.length ?? 0} sub-questions · ${args.queries?.length ?? 0} queries`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const state = result.details as ResearchState | undefined;
			if (!state?.coverage) return new Text(result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), 0, 0);
			return new Text(renderResearchView(state, expanded, theme), 0, 0);
		},
	});
}
