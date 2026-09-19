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

/** Web search without an API key, through the DuckDuckGo HTML page. */
export async function webSearch(query: string, maxResults = 10, signal?: AbortSignal): Promise<SearchResult[]> {
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
	if (results.length === 0) throw new Error("Search returned no results. The search site may be limiting requests; try again or change the query.");
	return results;
}
