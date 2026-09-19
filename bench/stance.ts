// Experiment: can Jev sort passages into "supports" and "contradicts" for a thesis, when no literal string marks the answer?
// Usage: node bench/stance.ts "<thesis>" "<query 1>" "<query 2>" ...
import { existsSync } from "node:fs";
import { noul } from "@typesafe-ai/sdk";
import { chunkMarkdown } from "../src/pipeline/chunk.ts";
import { fetchPage } from "../src/pipeline/fetch.ts";
import { type ChunkQuestion, judgeChunks } from "../src/pipeline/judge-jev.ts";
import { webSearch } from "../src/pipeline/search.ts";

const root = new URL("..", import.meta.url).pathname;
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const [thesis, ...queries] = process.argv.slice(2);

const stance = (id: string, verb: string, other: string): ChunkQuestion => ({
	id,
	build: (ref) =>
		noul(`Does the text in ${ref} give evidence, data, or a reasoned argument that ${verb} this claim: "${thesis}"`, {
			true: `The text reports a finding, a number, an example, or an argument that ${verb} the claim. The wording can differ from the claim.`,
			false: `The text is only on the topic without taking a side, or it ${other} the claim, or it is navigation, a list of links, or an advertisement.`,
		}),
});

const started = performance.now();
const results = (await Promise.all(queries.map((q) => webSearch(q, 8).catch(() => [])))).flat();
const urls = [...new Set(results.map((r) => r.url))].slice(0, 20);
const rows: { host: string; side: string; p: number; text: string }[] = [];
let chunksJudged = 0;
await Promise.all(
	urls.map(async (url) => {
		try {
			const page = await fetchPage(url);
			const { judgments } = await judgeChunks(chunkMarkdown(page.markdown), [stance("supports", "supports", "contradicts"), stance("contradicts", "contradicts", "supports")], { pageTitle: page.title });
			chunksJudged += judgments.length;
			for (const j of judgments) {
				for (const side of ["supports", "contradicts"]) if (j.p[side] >= 0.8 && j.p[side] > j.p[side === "supports" ? "contradicts" : "supports"]) rows.push({ host: new URL(url).hostname, side, p: j.p[side], text: j.chunk.text });
			}
		} catch {}
	}),
);
console.log(`thesis: ${thesis}\n${urls.length} pages, ${chunksJudged} chunks, ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
for (const side of ["supports", "contradicts"]) {
	const mine = rows.filter((r) => r.side === side).sort((a, b) => b.p - a.p);
	console.log(`== ${side.toUpperCase()}: ${mine.length} passages from ${new Set(mine.map((r) => r.host)).size} sources`);
	for (const r of mine.slice(0, 4)) console.log(`  p=${r.p.toFixed(2)} ${r.host}\n     ${r.text.replace(/\s+/g, " ").slice(0, 260)}`);
}
