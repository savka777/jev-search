export type FetchView = {
	title: string;
	url: string;
	/** Best probability per chunk. -1 means not judged yet. */
	scores: number[];
	/** First chunk beyond 100,000 characters, where a cut-and-summarize tool stops reading. -1 when the page is shorter. */
	cutChunk: number;
	pageTokens: number;
	kept: { index: number; p: number; preview: string }[];
	keptTokens: number;
	ms: number;
	usd: number;
};

type Theme = { fg: (color: never, text: string) => string; bold: (text: string) => string };

const STRIP_WIDTH = 60;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One row per source: a strip with one cell per group of chunks, shaded by the best probability in the group. */
export function renderFetchView(view: FetchView, expanded: boolean, theme: Theme): string {
	const fg = (color: string, text: string) => theme.fg(color as never, text);
	const total = view.scores.length;
	const cells = Math.min(STRIP_WIDTH, Math.max(total, 1));
	const cutCell = view.cutChunk >= 0 ? Math.floor((view.cutChunk / total) * cells) : -1;

	let strip = "";
	for (let cell = 0; cell < cells; cell++) {
		if (cell === cutCell) strip += fg("accent", "✂");
		const group = view.scores.slice(Math.floor((cell / cells) * total), Math.max(Math.floor(((cell + 1) / cells) * total), Math.floor((cell / cells) * total) + 1));
		const best = Math.max(...group);
		strip += best < 0 ? fg("dim", "·") : best >= 0.8 ? fg("success", "█") : best >= 0.5 ? fg("warning", "▓") : best >= 0.2 ? fg("muted", "▒") : fg("dim", "░");
	}

	const judged = view.scores.filter((score) => score >= 0).length;
	const stats =
		judged < total || view.ms === 0
			? `judged ${judged}/${total} chunks`
			: `${total} chunks · ${view.kept.length} kept · ${k(view.pageTokens)} → ${k(view.keptTokens)} tokens · ${(view.ms / 1000).toFixed(1)}s · $${view.usd.toFixed(3)}`;

	const lines = [fg("muted", view.title), `${strip} ${fg("dim", stats)}`];
	if (expanded) for (const chunk of view.kept) lines.push(fg("dim", `  #${chunk.index} p=${chunk.p.toFixed(2)}  ${chunk.preview}`));
	return lines.join("\n");
}
