# Results

All numbers are from real runs on 19 September 2026. Scripts and raw results are in [`bench/`](../bench).

## Speed and cost of a round

| Round | Time | Jev cost |
| --- | --- | --- |
| 24 pages, 3 sub-questions | 7.4 s | $0.01 |
| 60 pages, 592 chunks, 3 sub-questions and 1 claim | 15 s | $0.03 |
| 40 pages with a 54-page PDF, 13 checks per chunk | 14.9 s | $0.08 |
| A real 15-minute research session: 7 rounds, 466 pages, 2.19M tokens read, 39k tokens kept | 142 s in Jev | $1.01 |

In that session the LLM cost $2.28. Jev was never the bottleneck.

## Long pages

6 pages of 56k to 554k tokens, 21 questions with a known answer passage, 16 of them deeper than 100,000 characters.

| Reader | Correct final answers |
| --- | --- |
| Jev filter, then an LLM answers from the kept chunks | 21 of 21 |
| Claude Code `WebFetch` (cuts the page, then a small model summarizes) | 4 of 18; 0 of 14 for answers deeper than the first 10% of the page |
| Codex CLI web search (has find-in-page) | 3 of 3 deep questions tested |

Read this table with care. `WebFetch` loses deep text. Codex does not: its find-in-page action is a real alternative, and the Claude API web fetch tool has code-based filtering. The test questions share words with their answers, which suits keyword search. jev-search matches meaning ("sales per employee +39.9%" supports "improves productivity") and works without the LLM in the loop. A test with questions worded differently from the sources is not done yet.

Details: [real-tool-webfetch.md](../bench/results/real-tool-webfetch.md), [real-tool-codex.md](../bench/results/real-tool-codex.md).

## Claims

Thesis: "A four-day work week improves employee productivity". 20 pages, 440 chunks, 5.9 s: 41 supporting passages from 11 sources, 3 contradicting passages from 2 sources. Script: `bench/stance.ts`.

## Rate limits

Jev allows 1,200 requests per minute and 250,000 tokens per second (`jev-1.13`). A round with 13 checks per chunk first got 715 HTTP 429 responses. Requests are now paced to both limits: the same load gives 0.
