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
	/** Chunks in failed requests. They have no judgment. */
	chunksLost: number;
	lastError?: string;
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
	/** TypeSafe documents 1,200 requests per minute and 250,000 tokens per second for jev-1.13 (docs.typesafe.ai/models, 2026-09-19). */
	requestsPerMinute?: number;
	tokensPerSecond?: number;
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
	// The token count of a request is an estimate, so pacing aims at 80% of the documented token limit.
	// A run with 13 questions per chunk sent about 248k tokens per second and got 715 HTTP 429 responses.
	const tokensPerMs = ((options.tokensPerSecond ?? 250_000) * 0.8) / 1000;

	const metrics: JudgeMetrics = { requests: 0, failedRequests: 0, chunksLost: 0, rateLimited: 0, inputTokens: 0, wallMs: 0, latenciesMs: [] };
	const client = new TypeSafeClient({
		// The SDK retries HTTP 429 with backoff. More attempts than its default 2, so a burst does not drop chunks.
		retry: { maxRetries: 5 },
		// The SDK logs each retry to the console. Inside pi that text is drawn over the screen. HTTP 429s are counted below.
		logLevel: "off",
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
			const requestQuestions: Record<string, NoulQuestion> = {};
			batch.forEach((_, i) => {
				for (const question of questions) requestQuestions[`${question.id}.${i}`] = question.build(`chunks[${i}]`);
			});
			const state = {
				page_title: options.pageTitle,
				chunks: batch.map((chunk) => ({ section: chunk.headingPath.join(" > "), text: chunk.text })),
			};

			// Pace request starts to both documented limits: requests per minute and tokens per second.
			const estimatedTokens = (JSON.stringify(state).length + JSON.stringify(requestQuestions).length) / 3.5;
			const wait = nextStart - performance.now();
			nextStart = Math.max(performance.now(), nextStart) + Math.max(gapMs, estimatedTokens / tokensPerMs);
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

			const requestStart = performance.now();
			metrics.requests++;
			try {
				const result = await client.systemOne({ state, questions: requestQuestions }, { signal: options.signal });
				metrics.inputTokens += result.usage.input_tokens;
				const batchJudgments = batch.map((chunk, i) => ({
					chunk,
					p: Object.fromEntries(questions.map((question) => [question.id, result.answers[`${question.id}.${i}`].noul])),
				}));
				judgments.push(...batchJudgments);
				options.onBatch?.(batchJudgments);
			} catch (error) {
				// No console output here: inside pi it would be drawn over the screen. Callers read the metrics.
				metrics.failedRequests++;
				metrics.chunksLost += batch.length;
				metrics.lastError = error instanceof Error ? error.message.slice(0, 160) : String(error);
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
