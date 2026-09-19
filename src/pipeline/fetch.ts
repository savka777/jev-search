import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import gfmPlugin from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";

const USER_AGENT = "jev-search/0.0.1 (+https://github.com/savka777/jev-search)";

export type Link = {
	text: string;
	href: string;
	/** Position of the link text in the page Markdown. */
	offset: number;
};

export type Page = {
	url: string;
	status: number;
	title: string;
	/** Full page as Markdown. Never cut. Link targets are moved to `links`, so the text is what a reader sees. */
	markdown: string;
	links: Link[];
	htmlBytes: number;
	fetchMs: number;
	convertMs: number;
	cached: boolean;
};

export type FetchOptions = {
	/** Raw HTML is stored here and reused, so bench runs see identical input. */
	cacheDir?: string;
	signal?: AbortSignal;
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfmPlugin.gfm);
// Only non-text elements are removed. Navigation, footers and other boilerplate stay: the judge decides.
turndown.remove(["script", "style", "noscript", "iframe", "template"]);
turndown.remove((node) => node.nodeName.toLowerCase() === "svg");

const IMAGE = /!\[((?:\\.|[^\[\]\\])*)\]\((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*\)/g;
const LINK =
	/\[((?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*)\]\(\s*((?:\\.|[^()\s\\]|\((?:\\.|[^()\s\\])*\))*)(?:\s+"(?:\\.|[^"\\])*")?\s*\)/g;

/** Link URLs were 37% of a Wikipedia page. They cost tokens and carry no evidence, so they leave the text. */
function extractLinks(markdown: string, baseUrl: string): { markdown: string; links: Link[] } {
	const links: Link[] = [];
	let out = "";
	// Odd segments are fenced code and stay as they are.
	markdown.split(/(^```[\s\S]*?^```$)/m).forEach((segment, i) => {
		if (i % 2 === 1) {
			out += segment;
			return;
		}
		const source = segment.replace(IMAGE, "$1");
		let last = 0;
		for (const match of source.matchAll(LINK)) {
			out += source.slice(last, match.index);
			const href = match[2].replace(/\\(.)/g, "$1");
			if (href && !href.startsWith("#") && URL.canParse(href, baseUrl)) {
				links.push({ text: match[1], href: new URL(href, baseUrl).href, offset: out.length });
			}
			out += match[1];
			last = match.index + match[0].length;
		}
		out += source.slice(last);
	});
	return { markdown: out, links };
}

export function htmlToMarkdown(html: string, baseUrl: string): { markdown: string; links: Link[] } {
	const markdown = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
	return extractLinks(markdown, baseUrl);
}

function titleOf(html: string): string {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

export async function fetchPage(url: string, options: FetchOptions = {}): Promise<Page> {
	const cacheFile = options.cacheDir
		? join(options.cacheDir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.html`)
		: undefined;

	let html: string | undefined;
	let status = 200;
	let cached = false;
	const fetchStart = performance.now();

	if (cacheFile) {
		html = await readFile(cacheFile, "utf8").catch(() => undefined);
		cached = html !== undefined;
	}

	if (html === undefined) {
		const response = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
			redirect: "follow",
			signal: options.signal,
		});
		status = response.status;
		if (status !== 200) {
			throw new Error(`HTTP ${status} for ${url}`);
		}
		html = await response.text();
		if (cacheFile && options.cacheDir) {
			await mkdir(options.cacheDir, { recursive: true });
			await writeFile(cacheFile, html);
		}
	}
	const fetchMs = performance.now() - fetchStart;

	const convertStart = performance.now();
	const { markdown, links } = htmlToMarkdown(html, url);
	const convertMs = performance.now() - convertStart;

	return {
		url,
		status,
		title: titleOf(html),
		markdown,
		links,
		htmlBytes: Buffer.byteLength(html),
		fetchMs,
		convertMs,
		cached,
	};
}
