// One research round, with no LLM inside: search all queries, read every result in parallel,
// let Jev judge every chunk against every probe, then score coverage by counting sources.
import { noul } from "@typesafe-ai/sdk";
import { chunkMarkdown, estimateTokens } from "./chunk.ts";
import { fetchPage } from "./fetch.ts";
import { type ChunkQuestion, evidenceQuestion, JevAccessError, judgeChunks } from "./judge-jev.ts";
import { webSearch } from "./search.ts";

export type SubQuestion = { question: string; criteria?: string; minSources?: number };
export type ResearchPlan = {
	/** The user's main question. Judged as a catch-all, and used as a search query. */
	objective?: string;
	subQuestions?: SubQuestion[];
	/** Statements to test. Each one is judged twice: passages that support it, passages that contradict it. */
	claims?: string[];
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
	fetchMs: number;
	judgeMs: number;
};
/** One thing Jev checks in every chunk: a sub-question, the main question, or one side of a claim. */
export type Coverage = {
	id: string;
	kind: "main" | "question" | "supports" | "contradicts";
	label: string;
	needed: number;
	hosts: string[];
	bestP: number;
	status: "covered" | "partial" | "open";
};
export type Evidence = { url: string; host: string; title: string; chunk: number; section: string; text: string; p: Record<string, number> };
export type Snippet = Evidence & { ids: string[] };
export type ResearchState = {
	queriesDone: number;
	queriesTotal: number;
	searchErrors: string[];
	sources: SourceState[];
	coverage: Coverage[];
	chunksJudged: number;
	/** Chunks that Jev could not judge (failed requests after retries). */
	chunksLost: number;
	pageTokens: number;
	keptTokens: number;
	jevRequests: number;
	rateLimited: number;
	/** Jev latency per request, retries included. */
	jevP50Ms: number;
	jevP95Ms: number;
	usd: number;
	searchMs: number;
	ms: number;
};

const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, jev-1.13.0, input tokens only
const KEEP = 0.5;
/** A source counts toward coverage only when Jev is this sure about one of its passages. */
const STRONG = 0.8;
const FETCH_CONCURRENCY = 24;

const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "");

/** Stance wording from bench/stance.ts: it matched meaning ("sales per employee +39.9%") with no literal overlap. */
function stanceQuestion(id: string, claim: string, verb: "supports" | "contradicts"): ChunkQuestion {
	const other = verb === "supports" ? "contradicts" : "supports";
	return {
		id,
		build: (ref) =>
			noul(`Does the text in ${ref} give evidence, data, or a reasoned argument that ${verb} this claim: "${claim}"`, {
				true: `The text reports a finding, a number, an example, or an argument that ${verb} the claim. The wording can differ from the claim.`,
				false: `The text is only on the topic without taking a side, or it ${other} the claim, or it is navigation, a list of links, or an advertisement.`,
			}),
	};
}

/** For a claim, a passage counts for one side only when that side scores higher than the other. */
const opposite = (id: string) => (id.endsWith("+") ? `${id.slice(0, -1)}-` : id.endsWith("-") ? `${id.slice(0, -1)}+` : undefined);
export const scoreFor = (p: Record<string, number>, id: string) => {
	const other = opposite(id);
	return other && p[other] >= p[id] ? 0 : p[id];
};

export async function runResearch(
	plan: ResearchPlan,
	options: { signal?: AbortSignal; onProgress?: (state: ResearchState) => void } = {},
): Promise<{ state: ResearchState; snippets: Snippet[]; evidence: Evidence[] }> {
	const started = performance.now();
	const maxPages = plan.maxPages ?? 100;

	const questions: ChunkQuestion[] = [];
	const coverage: Coverage[] = [];
	const probe = (question: ChunkQuestion, kind: Coverage["kind"], label: string, needed: number) => {
		questions.push(question);
		coverage.push({ id: question.id, kind, label, needed, hosts: [], bestP: 0, status: "open" });
	};
	if (plan.objective) probe(evidenceQuestion("main", plan.objective), "main", plan.objective, 2);
	(plan.subQuestions ?? []).forEach((sub, i) => probe(evidenceQuestion(`q${i + 1}`, sub.question, sub.criteria), "question", sub.question, sub.minSources ?? 2));
	(plan.claims ?? []).forEach((claim, i) => {
		probe(stanceQuestion(`c${i + 1}+`, claim, "supports"), "supports", claim, 2);
		probe(stanceQuestion(`c${i + 1}-`, claim, "contradicts"), "contradicts", claim, 2);
	});
	if (questions.length === 0) throw new Error("Give an objective, sub-questions, or claims.");

	const queries = [...new Set([...(plan.objective ? [plan.objective] : []), ...plan.queries])];
	const state: ResearchState = {
		queriesDone: 0,
		queriesTotal: queries.length,
		searchErrors: [],
		sources: [],
		coverage,
		chunksJudged: 0,
		chunksLost: 0,
		pageTokens: 0,
		keptTokens: 0,
		jevRequests: 0,
		rateLimited: 0,
		jevP50Ms: 0,
		jevP95Ms: 0,
		usd: 0,
		searchMs: 0,
		ms: 0,
	};
	const latencies: number[] = [];
	const progress = () => {
		state.ms = performance.now() - started;
		options.onProgress?.(state);
	};

	// 1. Search. Results are taken in turns from each query so no single query fills the page budget.
	const perQuery = await Promise.all(
		queries.map((query) =>
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
	state.searchMs = performance.now() - started;
	const urls = new Set(plan.urls ?? []);
	for (let rank = 0; urls.size < maxPages && perQuery.some((results) => rank < results.length); rank++) {
		for (const results of perQuery) if (results[rank] && urls.size < maxPages) urls.add(results[rank].url.split("#")[0]);
	}
	state.sources = [...urls].map((url) => ({ url, host: hostOf(url), title: url, status: "queued", scores: [], cutChunk: -1, pageTokens: 0, kept: 0, fetchMs: 0, judgeMs: 0 }));
	progress();

	// 2. Read and judge. Each page goes to Jev as soon as it arrives.
	const evidence: Evidence[] = [];
	let next = 0;
	let accessError: JevAccessError | undefined;
	const worker = async () => {
		while (next < state.sources.length && !options.signal?.aborted && !accessError) {
			const source = state.sources[next++];
			try {
				source.status = "fetching";
				progress();
				const fetchStarted = performance.now();
				const page = await fetchPage(source.url, { signal: options.signal });
				source.fetchMs = Math.round(performance.now() - fetchStarted);
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
							const best = Math.max(...coverage.map((cover) => scoreFor(j.p, cover.id)));
							source.scores[j.chunk.index] = best;
							state.chunksJudged++;
							if (best >= KEEP) {
								source.kept++;
								evidence.push({ url: source.url, host: source.host, title: source.title, chunk: j.chunk.index, section: j.chunk.headingPath.join(" > "), text: j.chunk.text, p: j.p });
							}
							for (const cover of coverage) {
								const p = scoreFor(j.p, cover.id);
								cover.bestP = Math.max(cover.bestP, p);
								if (p >= STRONG && !cover.hosts.includes(source.host)) cover.hosts.push(source.host);
								cover.status = cover.hosts.length >= cover.needed ? "covered" : cover.hosts.length > 0 ? "partial" : "open";
							}
						}
						progress();
					},
				});
				source.judgeMs = Math.round(metrics.wallMs);
				latencies.push(...metrics.latenciesMs);
				state.chunksLost += metrics.chunksLost;
				state.jevRequests += metrics.requests;
				state.rateLimited += metrics.rateLimited;
				state.usd += (metrics.inputTokens / 1e6) * USD_PER_MTOK;
				source.status = "done";
			} catch (error) {
				// No credits or a bad key: every page would fail the same way. Stop, and tell the user, not "0 sources".
				if (error instanceof JevAccessError) accessError = error;
				source.status = "failed";
				source.error = error instanceof Error ? error.message.slice(0, 80) : String(error);
			}
			progress();
		}
	};
	await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
	if (accessError) throw accessError;
	latencies.sort((a, b) => a - b);
	state.jevP50Ms = Math.round(latencies[Math.floor(latencies.length * 0.5)] ?? 0);
	state.jevP95Ms = Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0);

	// 3. Select what the agent reads now: per probe, best first, at most 2 per page, within an equal share of the budget.
	// Nothing is deleted: `evidence` holds every kept passage.
	const share = (plan.budgetTokens ?? 8000) / coverage.length;
	const chosen = new Map<Evidence, string[]>();
	for (const { id } of coverage) {
		let tokens = 0;
		const perPage = new Map<string, number>();
		for (const item of evidence.filter((e) => scoreFor(e.p, id) >= KEEP).sort((a, b) => scoreFor(b.p, id) - scoreFor(a.p, id))) {
			const used = perPage.get(item.url) ?? 0;
			if (used >= 2) continue;
			if (!chosen.has(item)) {
				tokens += estimateTokens(item.text);
				if (tokens > share && tokens > estimateTokens(item.text)) break;
			}
			perPage.set(item.url, used + 1);
			chosen.set(item, [...(chosen.get(item) ?? []), id]);
		}
	}
	const snippets = [...chosen].map(([item, ids]) => ({ ...item, ids }));
	state.keptTokens = snippets.reduce((sum, snippet) => sum + estimateTokens(snippet.text), 0);
	progress();
	return { state, snippets, evidence };
}
