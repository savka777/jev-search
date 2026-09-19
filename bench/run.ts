// Arm B bench: does the chunk with the answer passage survive the Jev filter?
// Usage: npm run bench -- [--set dev|test] [--page <id>] [--batch 8] [--threshold 0.5] [--answer]
// --answer: the kept chunks go to the LLM (through pi) and the final answer is checked against the expected value.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chunkMarkdown, estimateTokens } from "../src/pipeline/chunk.ts";
import { fetchPage } from "../src/pipeline/fetch.ts";
import { evidenceQuestion, type Judgment, judgeChunks, selectChunks } from "../src/pipeline/judge-jev.ts";
import { askPi } from "./llm.ts";

type PageRef = { id: string; url: string; set: "dev" | "test" };
type Case = { id: string; page: string; question: string; answer: string; answerPattern: string; passage: string };

const root = new URL("..", import.meta.url).pathname;
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg("set", "dev");
const onlyPage = arg("page", "");
const batchSize = Number(arg("batch", "8"));
const threshold = Number(arg("threshold", "0.5"));
const withAnswer = process.argv.includes("--answer");
const ARM_A_CUT = 100_000;
const USD_PER_MTOK = 0.042; // docs.typesafe.ai/models, jev-1.13.0, input tokens only

const pages: PageRef[] = JSON.parse(await readFile(`${root}bench/cases/pages.json`, "utf8"));
const cases: Case[] = JSON.parse(await readFile(`${root}bench/cases/cases.json`, "utf8"));

const percentile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
};

// Same prompt as the WebFetch check in bench/results/real-tool-webfetch.md, so both sides give a final answer.
async function answer(c: Case, judgments: Judgment[], url: string) {
	const selected = selectChunks(judgments, { threshold, questionIds: [c.id] });
	const content = selected.map((j) => `[chunk ${j.chunk.index}] ${j.chunk.headingPath.join(" > ")}\n${j.chunk.text}`).join("\n\n---\n\n");
	const prompt = `Use only the page content below. Do not use your own knowledge. Question: ${c.question} Give the answer and quote the exact sentence from the page that states it. If the page content does not state the answer, reply exactly: NOT FOUND.\n\nPage: ${url}\n\n${content}`;
	const reply = await askPi(prompt);
	return {
		sentTokens: estimateTokens(content),
		correct: !/NOT FOUND/.test(reply.text) && new RegExp(c.answerPattern, "i").test(reply.text),
		llmMs: Math.round(reply.ms),
	};
}

const caseRows: Record<string, string | number | boolean>[] = [];
const pageRows: Record<string, string | number>[] = [];

for (const ref of pages.filter((page) => page.set === set && (!onlyPage || page.id === onlyPage))) {
	const page = await fetchPage(ref.url, { cacheDir: `${root}bench/.cache` });
	const chunks = chunkMarkdown(page.markdown);
	const pageCases = cases.filter((c) => c.page === ref.id);

	// All cases of a page go in one pass: Jev reads the state once and answers every question.
	const { judgments, metrics } = await judgeChunks(
		chunks,
		pageCases.map((c) => evidenceQuestion(c.id, c.question)),
		{ pageTitle: page.title, batchSize },
	);

	await Promise.all(pageCases.map(async (c) => {
		const offsets: number[] = [];
		for (let at = page.markdown.indexOf(c.passage); at >= 0; at = page.markdown.indexOf(c.passage, at + 1)) offsets.push(at);
		if (offsets.length === 0) throw new Error(`Case ${c.id}: passage not found in ${ref.id}`);

		const isNeedle = (start: number, end: number) => offsets.some((at) => start < at + c.passage.length && end > at);
		const needleP = Math.max(...judgments.filter((j) => isNeedle(j.chunk.start, j.chunk.end)).map((j) => j.p[c.id]), -1);
		const kept = judgments.filter((j) => j.p[c.id] >= threshold);
		caseRows.push({
			case: c.id,
			depth: `${Math.round((offsets[0] / page.markdown.length) * 100)}%`,
			beyondCut: offsets[0] > ARM_A_CUT,
			needleP: Number(needleP.toFixed(3)),
			rank: 1 + judgments.filter((j) => j.p[c.id] > needleP).length,
			keptChunks: kept.length,
			keptTokens: kept.reduce((sum, j) => sum + estimateTokens(j.chunk.text), 0),
			pageTokens: estimateTokens(page.markdown),
			hit: needleP >= threshold,
			...(withAnswer ? await answer(c, judgments, page.url) : {}),
		});
	}));

	pageRows.push({
		page: ref.id,
		chunks: chunks.length,
		questions: pageCases.length,
		requests: metrics.requests,
		failed: metrics.failedRequests,
		http429: metrics.rateLimited,
		inputTokens: metrics.inputTokens,
		usd: Number(((metrics.inputTokens / 1e6) * USD_PER_MTOK).toFixed(4)),
		wallMs: Math.round(metrics.wallMs),
		p50Ms: percentile(metrics.latenciesMs, 0.5),
		p95Ms: percentile(metrics.latenciesMs, 0.95),
	});
	console.log(`${ref.id}: judged ${judgments.length}/${chunks.length} chunks in ${Math.round(metrics.wallMs)} ms`);
}

console.log(`\nArm B (Jev filter). set=${set} batch=${batchSize} threshold=${threshold}`);
console.table(caseRows);
console.table(pageRows);
const hits = caseRows.filter((row) => row.hit).length;
console.log(`Evidence recall: ${hits}/${caseRows.length}`);
if (withAnswer) console.log(`Correct final answers: ${caseRows.filter((row) => row.correct).length}/${caseRows.length}`);

await mkdir(`${root}bench/results`, { recursive: true });
await writeFile(
	`${root}bench/results/arm-b-${set}${withAnswer ? "-answer" : ""}.json`,
	`${JSON.stringify({ date: new Date().toISOString(), set, batchSize, threshold, cases: caseRows, pages: pageRows }, null, 2)}\n`,
);
