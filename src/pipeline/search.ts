export type SearchResult = { title: string; url: string; snippet: string };

const decode = (html: string) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();

// Brave Search API: used when BRAVE_API_KEY is set. Endpoint and fields: api-dashboard.search.brave.com documentation.
async function braveSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}`, {
		headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY ?? "", accept: "application/json" },
		signal,
	});
	// Brave states the plan's limit in each response ("50, 0" = 50 per second). Later searches are paced to it.
	const perSecond = Number(response.headers.get("x-ratelimit-limit")?.split(",")[0]);
	if (perSecond > 0) braveGapMs = 1000 / perSecond + 5;
	if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
	const body = (await response.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
	return (body.web?.results ?? []).map((r) => ({ title: decode(r.title), url: r.url, snippet: decode(r.description ?? "") }));
}

// The search site rejects bursts: 10 parallel searches in one second all failed, bursts of 8 mostly passed.
// Starts are spaced across all parallel calls, and an empty result is tried once more.
const GAP_MS = 700;
/** Unknown until the first Brave response. Until then one search runs alone and the others wait for it. */
let braveGapMs: number | undefined;
let braveProbe: Promise<unknown> | undefined;
let nextStart = 0;

/** Web search: Brave when BRAVE_API_KEY is set, otherwise the DuckDuckGo HTML page (no key, but it blocks after a few searches). */
export async function webSearch(query: string, maxResults = 10, signal?: AbortSignal): Promise<SearchResult[]> {
	for (let attempt = 0; ; attempt++) {
		const brave = Boolean(process.env.BRAVE_API_KEY);
		if (brave && braveGapMs === undefined) {
			if (braveProbe) await braveProbe.catch(() => {});
			else {
				braveProbe = braveSearch(query, maxResults, signal);
				const probed = (await braveProbe.catch(() => [])) as SearchResult[];
				if (probed.length > 0) return probed;
			}
		}
		const wait = nextStart - Date.now();
		nextStart = Math.max(Date.now(), nextStart) + (brave ? (braveGapMs ?? 1100) : GAP_MS);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		const results = await (brave ? braveSearch : searchOnce)(query, maxResults, signal);
		if (results.length > 0) return results;
		if (attempt === 1) throw new Error("Search returned no results. The search site may be limiting requests; try again or change the query.");
	}
}

async function searchOnce(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
		headers: { "user-agent": "Mozilla/5.0 (compatible; jev-search/0.0.1; +https://github.com/savka777/jev-search)" },
		signal,
	});
	if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
	const html = await response.text();

	const results: SearchResult[] = [];
	const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/).slice(1);
	for (const block of blocks) {
		const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!link) continue;
		const href = decode(link[1]);
		const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
		if (!/^https?:\/\//.test(target) || target.includes("duckduckgo.com/y.js")) continue;
		const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
		results.push({ title: decode(link[2]), url: target, snippet: snippet ? decode(snippet[1]) : "" });
		if (results.length >= maxResults) break;
	}
	return results;
}
