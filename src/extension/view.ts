import type { ResearchState } from "../pipeline/research.ts";

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
const paint = (theme: Theme) => (color: string, text: string) => theme.fg(color as never, text);

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One cell per group of chunks, shaded by the best probability in the group. ✂ marks the 100,000 character cut. */
function renderStrip(scores: number[], cutChunk: number, theme: Theme, width: number): string {
	const fg = paint(theme);
	const total = scores.length;
	const cells = Math.min(width, Math.max(total, 1));
	const cutCell = cutChunk >= 0 ? Math.floor((cutChunk / total) * cells) : -1;
	let strip = "";
	for (let cell = 0; cell < cells; cell++) {
		if (cell === cutCell) strip += fg("accent", "✂");
		const from = Math.floor((cell / cells) * total);
		const best = Math.max(...scores.slice(from, Math.max(Math.floor(((cell + 1) / cells) * total), from + 1)));
		strip += best < 0 ? fg("dim", "·") : best >= 0.8 ? fg("success", "█") : best >= 0.5 ? fg("warning", "▓") : best >= 0.2 ? fg("muted", "▒") : fg("dim", "░");
	}
	return strip;
}

const bar = (done: number, total: number, width = 24) => {
	const filled = total > 0 ? Math.round((done / total) * width) : 0;
	return "█".repeat(filled) + "░".repeat(width - filled);
};

/** One source: title, strip, numbers. */
export function renderFetchView(view: FetchView, expanded: boolean, theme: Theme): string {
	const fg = paint(theme);
	const total = view.scores.length;
	const judged = view.scores.filter((score) => score >= 0).length;
	const stats =
		judged < total || view.ms === 0
			? `judged ${judged}/${total} chunks`
			: `${total} chunks · ${view.kept.length} kept · ${k(view.pageTokens)} → ${k(view.keptTokens)} tokens · ${(view.ms / 1000).toFixed(1)}s · $${view.usd.toFixed(3)}`;
	const lines = [fg("muted", view.title), `${renderStrip(view.scores, view.cutChunk, theme, 60)} ${fg("dim", stats)}`];
	if (expanded) for (const chunk of view.kept) lines.push(fg("dim", `  #${chunk.index} p=${chunk.p.toFixed(2)}  ${chunk.preview}`));
	return lines.join("\n");
}

/** One research round: progress of each phase, coverage per sub-question, one strip per source. */
export function renderResearchView(state: ResearchState, expanded: boolean, theme: Theme): string {
	const fg = paint(theme);
	const sources = state.sources;
	const settled = sources.filter((s) => s.status === "done" || s.status === "failed").length;
	const failed = sources.filter((s) => s.status === "failed").length;
	const chunksTotal = sources.reduce((sum, s) => sum + s.scores.length, 0);

	const lines = [
		`${fg("muted", "search")} ${fg("accent", bar(state.queriesDone, state.queriesTotal))} ${fg("dim", `${state.queriesDone}/${state.queriesTotal} queries → ${sources.length} links${state.searchErrors.length ? ` · ${state.searchErrors.length} failed` : ""}`)}`,
		`${fg("muted", "read  ")} ${fg("accent", bar(settled, sources.length))} ${fg("dim", `${settled}/${sources.length} pages${failed ? ` · ${failed} blocked or failed` : ""}`)}`,
		`${fg("muted", "judge ")} ${fg("accent", bar(state.chunksJudged, chunksTotal))} ${fg("dim", `${k(state.chunksJudged)}/${k(chunksTotal)} chunks`)}`,
		"",
	];

	for (const cover of state.coverage) {
		const mark = cover.status === "covered" ? fg("success", "██ covered") : cover.status === "partial" ? fg("warning", "▓▓ partial") : fg("dim", "░░ open   ");
		const question = cover.question.length > 70 ? `${cover.question.slice(0, 69)}…` : cover.question;
		lines.push(`${mark} ${fg("dim", `${cover.hosts.length}/${cover.needed} sources`)}  ${fg("muted", `${cover.id} ${question}`)}`);
	}
	lines.push("");

	// Pages with evidence first. Collapsed: the best 8. Expanded: every page and its state.
	const ranked = [...sources].sort((a, b) => b.kept - a.kept);
	for (const source of expanded ? ranked : ranked.filter((s) => s.kept > 0).slice(0, 8)) {
		const strip = source.scores.length ? renderStrip(source.scores, source.cutChunk, theme, 30) : fg("dim", source.status === "failed" ? "✗" : "·");
		const note = source.status === "failed" ? fg("error", source.error ?? "failed") : fg("dim", `${source.scores.length} chunks · ${source.kept} kept`);
		lines.push(`${strip} ${fg("muted", source.host)} ${note}`);
	}

	lines.push("", fg("dim", `${k(state.pageTokens)} tokens read → ${k(state.keptTokens)} kept · ${(state.ms / 1000).toFixed(1)}s · ${state.jevRequests} Jev requests · $${state.usd.toFixed(3)}`));
	return lines.join("\n");
}
