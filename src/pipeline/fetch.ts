import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import gfmPlugin from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";

const FETCH_TIMEOUT_MS = 20_000;
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
// The GFM plugin keeps tables with lists, headings or code blocks as raw HTML. Raw HTML is noise for the judge,
// so these tables become one text line per row.
turndown.addRule("complexTable", {
	filter: (node) => node.nodeName === "TABLE" && node.querySelector("ul,ol,h1,h2,h3,h4,h5,h6,hr,blockquote,pre") !== null,
	replacement: (_content, node) => {
		const rows = Array.from((node as HTMLTableElement).rows, (row) =>
			Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
				.filter(Boolean)
				.join(" | "),
		).filter(Boolean);
		return `\n\n${rows.join("\n")}\n\n`;
	},
});

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
	let isHtml = true;
	const fetchStart = performance.now();

	if (cacheFile) {
		html = await readFile(cacheFile, "utf8").catch(() => undefined);
		cached = html !== undefined;
	}

	if (html === undefined) {
		const response = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
			redirect: "follow",
			signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		status = response.status;
		if (status !== 200) {
			throw new Error(`HTTP ${status} for ${url}`);
		}
		// PDFs and other binary files read as HTML give garbage chunks that still cost judge tokens.
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType && !/html|xml|^text\//i.test(contentType)) {
			throw new Error(`Unsupported content type "${contentType}" for ${url}. Only HTML and text pages can be read.`);
		}
		isHtml = !contentType || /html|xml/i.test(contentType);
		html = await response.text();
		if (cacheFile && options.cacheDir) {
			await mkdir(options.cacheDir, { recursive: true });
			await writeFile(cacheFile, html);
		}
	}
	const fetchMs = performance.now() - fetchStart;

	const convertStart = performance.now();
	const { markdown, links } = isHtml ? htmlToMarkdown(html, url) : { markdown: html.trim(), links: [] };
	const convertMs = performance.now() - convertStart;

	return {
		url,
		status,
		title: isHtml ? titleOf(html) : (html.match(/^#\s+(.+)$/m)?.[1] ?? ""),
		markdown,
		links,
		htmlBytes: Buffer.byteLength(html),
		fetchMs,
		convertMs,
		cached,
	};
}
