export type Chunk = {
	index: number;
	text: string;
	/** Headings above this chunk, outermost first. Gives the judge context. */
	headingPath: string[];
	/** Character range in the page Markdown. */
	start: number;
	end: number;
};

type Piece = { text: string; start: number; end: number };

/** About 250 tokens. */
export const DEFAULT_MAX_CHARS = 1000;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Blocks are separated by blank lines. Fenced code keeps its blank lines. */
function splitBlocks(markdown: string): Piece[] {
	const blocks: Piece[] = [];
	let inFence = false;
	let blockStart = -1;
	let pos = 0;
	for (const line of markdown.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (line.trim() === "" && !inFence) {
			if (blockStart >= 0) {
				blocks.push({ text: markdown.slice(blockStart, pos - 1), start: blockStart, end: pos - 1 });
				blockStart = -1;
			}
		} else if (blockStart < 0) {
			blockStart = pos;
		}
		pos += line.length + 1;
	}
	if (blockStart >= 0) {
		blocks.push({ text: markdown.slice(blockStart), start: blockStart, end: markdown.length });
	}
	return blocks;
}

/** Cuts long text at sentence ends or line ends. Falls back to a hard cut. */
function splitText(block: Piece, maxChars: number): Piece[] {
	const pieces: Piece[] = [];
	const text = block.text;
	let from = 0;
	while (text.length - from > maxChars) {
		const window = text.slice(from, from + maxChars);
		let cut = -1;
		for (const match of window.matchAll(/[.!?;:]\s+|\n/g)) {
			cut = match.index + match[0].length;
		}
		if (cut <= 0) cut = maxChars;
		pieces.push({ text: text.slice(from, from + cut).trim(), start: block.start + from, end: block.start + from + cut });
		from += cut;
	}
	pieces.push({ text: text.slice(from).trim(), start: block.start + from, end: block.end });
	return pieces.filter((piece) => piece.text.length > 0);
}

/** Splits a long table by rows. Each piece repeats the header so numbers keep their column names. */
function splitTable(block: Piece, maxChars: number): Piece[] {
	const lines: Piece[] = [];
	let pos = block.start;
	for (const line of block.text.split("\n")) {
		lines.push({ text: line, start: pos, end: pos + line.length });
		pos += line.length + 1;
	}
	const hasHeader = lines.length > 2 && /^\|?\s*:?-{3,}/.test(lines[1].text);
	const header = hasHeader ? `${lines[0].text}\n${lines[1].text}\n` : "";
	const rows = hasHeader ? lines.slice(2) : lines;

	const pieces: Piece[] = [];
	let group: Piece[] = [];
	const flush = () => {
		if (group.length === 0) return;
		pieces.push({
			text: header + group.map((row) => row.text).join("\n"),
			start: group[0].start,
			end: group[group.length - 1].end,
		});
		group = [];
	};
	for (const row of rows) {
		if (row.text.length > maxChars) {
			flush();
			pieces.push(...splitText(row, maxChars));
			continue;
		}
		const size = header.length + group.reduce((sum, r) => sum + r.text.length + 1, 0);
		if (group.length > 0 && size + row.text.length > maxChars) flush();
		group.push(row);
	}
	flush();
	return pieces;
}

function isTable(text: string): boolean {
	return text.split("\n").every((line) => line.trimStart().startsWith("|"));
}

export function chunkMarkdown(markdown: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
	const chunks: Chunk[] = [];
	const headings: { level: number; text: string }[] = [];
	let parts: Piece[] = [];
	let hasBody = false;

	const flush = () => {
		if (parts.length === 0) return;
		chunks.push({
			index: chunks.length,
			text: parts.map((part) => part.text).join("\n\n"),
			headingPath: headings.map((heading) => heading.text),
			start: parts[0].start,
			end: parts[parts.length - 1].end,
		});
		parts = [];
		hasBody = false;
	};

	for (const block of splitBlocks(markdown)) {
		const heading = block.text.match(/^(#{1,6})\s+(.*)$/);
		if (heading && !block.text.includes("\n")) {
			// A heading starts a new chunk. Headings in a row stay together with the text below them.
			if (hasBody) flush();
			while (headings.length > 0 && headings[headings.length - 1].level >= heading[1].length) headings.pop();
			headings.push({ level: heading[1].length, text: heading[2].trim() });
			parts.push(block);
			continue;
		}

		const pieces =
			block.text.length <= maxChars ? [block] : isTable(block.text) ? splitTable(block, maxChars) : splitText(block, maxChars);
		for (const piece of pieces) {
			const size = parts.reduce((sum, part) => sum + part.text.length + 2, 0);
			if (hasBody && size + piece.text.length > maxChars) flush();
			parts.push(piece);
			hasBody = true;
		}
	}
	flush();
	return chunks;
}
