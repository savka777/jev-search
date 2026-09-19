// One research round, with no LLM inside: search all queries, read every result in parallel,
// let Jev judge every chunk against every sub-question, then score coverage by counting sources.
import { chunkMarkdown, estimateTokens } from "./chunk.ts";
import { fetchPage } from "./fetch.ts";
import { evidenceQuestion, judgeChunks } from "./judge-jev.ts";
import { webSearch } from "./search.ts";

export type SubQuestion = { question: string; criteria?: string; minSources?: number };
export type ResearchPlan = {
	subQuestions: SubQuestion[];
	queries: string[];
	/** Pages to read in addition to the search results. */
	urls?: string[];
	maxPages?: number;
	budgetTokens?: number;
};

export type SourceState = {
	url: string;
	host: string;
	title: string;
	status: "queued" | "fetching" | "judging" | "done" | "failed";
	error?: string;
	/** Best probability per chunk. -1 means not judged yet. */
	scores: number[];
	cutChunk: number;
	pageTokens: number;
	kept: number;
};
export type Coverage = { id: string; question: string; needed: number; hosts: string[]; bestP: number; status: "covered" | "partial" | "open" };
export type Snippet = { ids: string[]; url: string; title: string; chunk: number; section: string; p: number; text: string };
export type ResearchState = {
	queriesDone: number;
	queriesTotal: number;
	searchErrors: string[];
	sources: SourceState[];
	coverage: Coverage[];
	chunksJudged: number;
	pageTokens: number;
	keptTokens: number;
	jevRequests: number;
	rateLimited: number;
	usd: number;
	ms: number;
};

const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, jev-1.13.0, input tokens only
const KEEP = 0.5;
/** A source counts toward coverage only when Jev is this sure that a passage answers the sub-question. */
const STRONG = 0.8;
const FETCH_CONCURRENCY = 12;

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

export async function runResearch(
	plan: ResearchPlan,
	options: { signal?: AbortSignal; onProgress?: (state: ResearchState) => void } = {},
): Promise<{ state: ResearchState; snippets: Snippet[] }> {
	const started = performance.now();
	const maxPages = plan.maxPages ?? 40;
	const ids = plan.subQuestions.map((_, i) => `q${i + 1}`);
	const questions = plan.subQuestions.map((sub, i) => evidenceQuestion(ids[i], sub.question, sub.criteria));

	const state: ResearchState = {
		queriesDone: 0,
		queriesTotal: plan.queries.length,
		searchErrors: [],
		sources: [],
		coverage: plan.subQuestions.map((sub, i) => ({ id: ids[i], question: sub.question, needed: sub.minSources ?? 2, hosts: [], bestP: 0, status: "open" })),
		chunksJudged: 0,
		pageTokens: 0,
		keptTokens: 0,
		jevRequests: 0,
		rateLimited: 0,
		usd: 0,
		ms: 0,
	};
	const progress = () => {
		state.ms = performance.now() - started;
		options.onProgress?.(state);
	};

	// 1. Search. Results are taken in turns from each query so no single query fills the page budget.
	const perQuery = await Promise.all(
		plan.queries.map((query) =>
			webSearch(query, 20, options.signal)
				.catch((error: Error) => {
					state.searchErrors.push(`${query}: ${error.message}`);
					return [];
				})
				.finally(() => {
					state.queriesDone++;
					progress();
				}),
		),
	);
	const urls = new Set(plan.urls ?? []);
	for (let rank = 0; urls.size < maxPages && perQuery.some((results) => rank < results.length); rank++) {
		for (const results of perQuery) if (results[rank] && urls.size < maxPages) urls.add(results[rank].url.split("#")[0]);
	}
	state.sources = [...urls].map((url) => ({ url, host: hostOf(url), title: url, status: "queued", scores: [], cutChunk: -1, pageTokens: 0, kept: 0 }));
	progress();

	// 2. Read and judge. Each page goes to Jev as soon as it arrives.
	const candidates: { source: SourceState; chunk: number; section: string; text: string; p: Record<string, number> }[] = [];
	let next = 0;
	const worker = async () => {
		while (next < state.sources.length && !options.signal?.aborted) {
			const source = state.sources[next++];
			try {
				source.status = "fetching";
				progress();
				const page = await fetchPage(source.url, { signal: options.signal });
				const chunks = chunkMarkdown(page.markdown);
				source.title = page.title || source.url;
				source.scores = new Array(chunks.length).fill(-1);
				source.cutChunk = chunks.findIndex((chunk) => chunk.start >= 100_000);
				source.pageTokens = estimateTokens(page.markdown);
				source.status = "judging";
				state.pageTokens += source.pageTokens;
				progress();

				const { metrics } = await judgeChunks(chunks, questions, {
					pageTitle: page.title,
					signal: options.signal,
					onBatch: (batch) => {
						for (const j of batch) {
							const best = Math.max(...Object.values(j.p));
							source.scores[j.chunk.index] = best;
							state.chunksJudged++;
							if (best >= KEEP) {
								source.kept++;
								candidates.push({ source, chunk: j.chunk.index, section: j.chunk.headingPath.join(" > "), text: j.chunk.text, p: j.p });
							}
							for (const cover of state.coverage) {
								const p = j.p[cover.id];
								cover.bestP = Math.max(cover.bestP, p);
								if (p >= STRONG && !cover.hosts.includes(source.host)) cover.hosts.push(source.host);
								cover.status = cover.hosts.length >= cover.needed ? "covered" : cover.hosts.length > 0 ? "partial" : "open";
							}
						}
						progress();
					},
				});
				state.jevRequests += metrics.requests;
				state.rateLimited += metrics.rateLimited;
				state.usd += (metrics.inputTokens / 1e6) * USD_PER_MTOK;
				source.status = "done";
			} catch (error) {
				source.status = "failed";
				source.error = error instanceof Error ? error.message.slice(0, 80) : String(error);
			}
			progress();
		}
	};
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));

	// 3. Select snippets: per sub-question, best first, at most 2 per page, within an equal share of the budget.
	const share = (plan.budgetTokens ?? 8000) / ids.length;
	const chosen = new Map<(typeof candidates)[number], string[]>();
	for (const id of ids) {
		let tokens = 0;
		const perPage = new Map<string, number>();
		for (const candidate of candidates.filter((c) => c.p[id] >= KEEP).sort((a, b) => b.p[id] - a.p[id])) {
			const used = perPage.get(candidate.source.url) ?? 0;
			if (used >= 2) continue;
			if (!chosen.has(candidate)) {
				tokens += estimateTokens(candidate.text);
				if (tokens > share && tokens > estimateTokens(candidate.text)) break;
			}
			perPage.set(candidate.source.url, used + 1);
			chosen.set(candidate, [...(chosen.get(candidate) ?? []), id]);
		}
	}
	const snippets = [...chosen].map(([c, answered]) => ({
		ids: answered,
		url: c.source.url,
		title: c.source.title,
		chunk: c.chunk,
		section: c.section,
		p: Math.max(...answered.map((id) => c.p[id])),
		text: c.text,
	}));
	state.keptTokens = snippets.reduce((sum, snippet) => sum + estimateTokens(snippet.text), 0);
	progress();
	return { state, snippets };
}
