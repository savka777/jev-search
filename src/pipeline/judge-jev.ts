import { type NoulQuestion, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { type Chunk, estimateTokens } from "./chunk.ts";

/** One literal yes/no question that is asked about every chunk. `build` gets the chunk position in the request. */
export type ChunkQuestion = {
	id: string;
	build: (ref: string) => NoulQuestion;
};

export type Judgment = {
	chunk: Chunk;
	/** Probability of yes, keyed by question id. */
	p: Record<string, number>;
};

export type JudgeMetrics = {
	requests: number;
	failedRequests: number;
	/** HTTP 429 responses seen. The SDK retries them; they are counted apart so waits are not read as model latency. */
	rateLimited: number;
	inputTokens: number;
	wallMs: number;
	/** Per request, retries included. */
	latenciesMs: number[];
};

export type JudgeOptions = {
	pageTitle: string;
	/** Adjacent chunks per request. Neighbours give context; more chunks mean fewer requests but a larger state. */
	batchSize?: number;
	concurrency?: number;
	/** TypeSafe documents 1,200 requests per minute for jev-1.13 (docs.typesafe.ai/models, 2026-09-19). */
	requestsPerMinute?: number;
	signal?: AbortSignal;
	onBatch?: (judgments: Judgment[]) => void;
};

// Request starts are paced across all running judgeChunks calls: pi runs tool calls in parallel, and the rate limit is per account.
let nextStart = 0;

/** Evidence question for one research sub-question. Wording is literal because Jev reads literally. */
export function evidenceQuestion(id: string, subQuestion: string, criteria?: string): ChunkQuestion {
	return {
		id,
		build: (ref) =>
			noul(`Does the text in ${ref} contain information that answers this question: "${subQuestion}"`, {
				true: `The text itself states the answer or a part of the answer.${criteria ? ` What counts as an answer: ${criteria}` : ""}`,
				false:
					"The text does not state the answer. This includes text that is only on a similar topic, and navigation, tables of contents, indexes, and reference lists.",
			}),
	};
}

export async function judgeChunks(
	chunks: Chunk[],
	questions: ChunkQuestion[],
	options: JudgeOptions,
): Promise<{ judgments: Judgment[]; metrics: JudgeMetrics }> {
	const batchSize = options.batchSize ?? 8;
	const concurrency = options.concurrency ?? 16;
	const gapMs = 60_000 / (options.requestsPerMinute ?? 1200);

	const metrics: JudgeMetrics = { requests: 0, failedRequests: 0, rateLimited: 0, inputTokens: 0, wallMs: 0, latenciesMs: [] };
	const client = new TypeSafeClient({
		fetch: async (input, init) => {
			const response = await fetch(input, init);
			if (response.status === 429) metrics.rateLimited++;
			return response;
		},
	});

	const batches: Chunk[][] = [];
	for (let i = 0; i < chunks.length; i += batchSize) batches.push(chunks.slice(i, i + batchSize));

	const judgments: Judgment[] = [];
	let nextBatch = 0;
	const started = performance.now();

	const worker = async () => {
		while (nextBatch < batches.length && !options.signal?.aborted) {
			const batch = batches[nextBatch++];
			// Pace request starts to the documented rate limit.
			const wait = nextStart - performance.now();
			nextStart = Math.max(performance.now(), nextStart) + gapMs;
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

			const requestQuestions: Record<string, NoulQuestion> = {};
			batch.forEach((_, i) => {
				for (const question of questions) requestQuestions[`${question.id}.${i}`] = question.build(`chunks[${i}]`);
			});

			const requestStart = performance.now();
			metrics.requests++;
			try {
				const result = await client.systemOne(
					{
						state: {
							page_title: options.pageTitle,
							chunks: batch.map((chunk) => ({ section: chunk.headingPath.join(" > "), text: chunk.text })),
						},
						questions: requestQuestions,
					},
					{ signal: options.signal },
				);
				metrics.inputTokens += result.usage.input_tokens;
				const batchJudgments = batch.map((chunk, i) => ({
					chunk,
					p: Object.fromEntries(questions.map((question) => [question.id, result.answers[`${question.id}.${i}`].noul])),
				}));
				judgments.push(...batchJudgments);
				options.onBatch?.(batchJudgments);
			} catch (error) {
				metrics.failedRequests++;
				console.error(`judge request failed (chunks ${batch[0].index}-${batch[batch.length - 1].index}):`, error);
			} finally {
				metrics.latenciesMs.push(performance.now() - requestStart);
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
	metrics.wallMs = performance.now() - started;
	judgments.sort((a, b) => a.chunk.index - b.chunk.index);
	return { judgments, metrics };
}

/** Keeps chunks at or above the threshold, best first, until the token budget is full. Returns them in page order. */
export function selectChunks(
	judgments: Judgment[],
	options: { threshold?: number; budgetTokens?: number; questionIds?: string[] } = {},
): Judgment[] {
	const { threshold = 0.5, budgetTokens = 3000, questionIds } = options;
	const score = (j: Judgment) => Math.max(...(questionIds ?? Object.keys(j.p)).map((id) => j.p[id]));
	const kept: Judgment[] = [];
	let tokens = 0;
	for (const j of judgments.filter((j) => score(j) >= threshold).sort((a, b) => score(b) - score(a))) {
		tokens += estimateTokens(j.chunk.text);
		if (tokens > budgetTokens && kept.length > 0) break;
		kept.push(j);
	}
	return kept.sort((a, b) => a.chunk.index - b.chunk.index);
}
