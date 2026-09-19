// Page stats for bench candidates: how long is each page, and how much text sits beyond the arm A cut.
// Usage: npm run pages -- [--cut 100000]
import { readFile } from "node:fs/promises";
import { chunkMarkdown, estimateTokens } from "../src/pipeline/chunk.ts";
import { fetchPage } from "../src/pipeline/fetch.ts";

const root = new URL("..", import.meta.url).pathname;
const cutFlag = process.argv.indexOf("--cut");
const cut = cutFlag > 0 ? Number(process.argv[cutFlag + 1]) : 100_000;

const pages: { id: string; url: string }[] = JSON.parse(await readFile(`${root}bench/cases/pages.json`, "utf8"));

const rows: Record<string, string | number>[] = [];
for (const { id, url } of pages) {
	try {
		const page = await fetchPage(url, { cacheDir: `${root}bench/.cache` });
		const chunks = chunkMarkdown(page.markdown);
		const chars = page.markdown.length;
		rows.push({
			id,
			htmlKB: Math.round(page.htmlBytes / 1024),
			mdChars: chars,
			estTokens: estimateTokens(page.markdown),
			links: page.links.length,
			chunks: chunks.length,
			maxChunk: Math.max(...chunks.map((chunk) => chunk.text.length)),
			beyondCut: `${Math.round((Math.max(0, chars - cut) / chars) * 100)}%`,
			fetchMs: page.cached ? "cache" : Math.round(page.fetchMs),
			convertMs: Math.round(page.convertMs),
		});
	} catch (error) {
		rows.push({ id, error: error instanceof Error ? error.message : String(error) });
	}
}

console.log(`Arm A cut: ${cut} characters`);
console.table(rows);
