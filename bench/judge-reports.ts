// Jev as a report judge. Jev does not answer "which report is better" well in one step: that needs many hops over a
// large state. So each report is cut into chunks, Jev answers literal yes/no questions per chunk, and code adds them up.
// A per-section Score and a whole-report Choice (asked in both orders) are printed as cross-checks.
// Usage: node bench/judge-reports.ts <reportA.md> <reportB.md>
import { existsSync, readFileSync } from "node:fs";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { chunkMarkdown } from "../src/pipeline/chunk.ts";
import { type ChunkQuestion, judgeChunks } from "../src/pipeline/judge-jev.ts";

const root = new URL("..", import.meta.url).pathname;
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const files = process.argv.slice(2, 4);
const reports = files.map((file) => readFileSync(file, "utf8"));
const names = ["A", "B"];

const CRITERIA: [string, string, boolean][] = [
	["numbers", "Does the text state a specific number about a business problem, such as a cost, a volume, an error rate, a fine, or a time?", true],
	["sourced", "Does the text contain an exact quotation or a statement that is attributed to a named source or a link?", true],
	["buyer", "Does the text name a specific buyer: a job role, a department, or a type of organization that has the problem and pays for a solution?", true],
	["failure", "Does the text give evidence that existing solutions fail, are inadequate, or leave the problem unsolved?", true],
	["jev_fit", "Does the text describe a concrete judgment that a classification model makes, such as a yes/no decision, a category, or a score on a given text?", true],
	["risk", "Does the text state a risk, a limitation, or evidence against its own recommendation?", true],
	["vague", "Is the text generic, without any concrete fact, number, example, or named entity?", false],
];
const questions: ChunkQuestion[] = CRITERIA.map(([id, text]) => ({ id, build: (ref) => noul(`${text} Judge only the text in ${ref}.`) }));

// 1. Chunk-level profile.
const profile: Record<string, number>[] = [];
for (const report of reports) {
	const chunks = chunkMarkdown(report);
	const { judgments } = await judgeChunks(chunks, questions, { pageTitle: "Research report" });
	profile.push(Object.fromEntries([...CRITERIA.map(([id]) => [id, judgments.filter((j) => j.p[id] >= 0.5).length / judgments.length]), ["chunks", judgments.length]]));
}
console.log("Share of chunks where Jev says yes (p ≥ 0.5):");
console.table(Object.fromEntries(CRITERIA.map(([id, , good]) => [`${id}${good ? "" : " (lower is better)"}`, { A: `${Math.round(profile[0][id] * 100)}%`, B: `${Math.round(profile[1][id] * 100)}%` }])));

// 2. Score per top-level section: how strong is the painkiller case?
const client = new TypeSafeClient();
const LEVELS = [
	"No business problem is described.",
	"A problem is asserted, with no number and no source.",
	"A problem is described with one sourced number or one named regulation.",
	"Several sourced numbers or regulations show the problem is frequent, costly, and mandatory.",
	"As the previous level, and sourced evidence shows that existing solutions fail.",
] as const;
for (const [i, report] of reports.entries()) {
	const sections = report.split(/\n(?=#{1,2} )/).filter((section) => section.length > 1500).slice(0, 8);
	const rows = [];
	for (const section of sections) {
		const { answers } = await client.systemOne({ state: { section: section.slice(0, 12_000) }, questions: { case: score("How strong is the evidence in this section that the business problem is a painkiller: frequent, costly, mandatory, and unsolved?", LEVELS) } });
		rows.push({ section: section.split("\n")[0].slice(0, 60), score: Number(answers.case.score.toFixed(2)), confidence: Number(answers.case.confidence.toFixed(2)) });
	}
	console.log(`\nReport ${names[i]} (${files[i].split("/").pop()}): painkiller score per section, 0 to 4`);
	console.table(rows);
}

// 3. Whole-report Choice, asked in both orders. When the two orders disagree, the answer is position bias, not judgment.
for (const order of [[0, 1], [1, 0]]) {
	const { answers } = await client.systemOne({
		state: { first_report: reports[order[0]].slice(0, 40_000), second_report: reports[order[1]].slice(0, 40_000) },
		questions: {
			better: choice("Which report gives stronger sourced evidence for business problems that are frequent, costly, mandatory, and unsolved?", {
				first: "The first report has stronger sourced evidence.",
				second: "The second report has stronger sourced evidence.",
			}),
		},
	});
	const picked = answers.better.choice === "first" ? order[0] : order[1];
	console.log(`Order ${names[order[0]]}→${names[order[1]]}: Jev picks report ${names[picked]} (confidence ${answers.better.confidence.toFixed(2)})`);
}
