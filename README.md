<p align="center">
  <img alt="jev-search" src="https://raw.githubusercontent.com/savka777/jev-search/main/assets/banner.svg" width="600">
</p>

Fast deep research for the [pi](https://github.com/earendil-works/pi) coding agent.

One round reads up to 100 web pages and PDFs **in full**, in seconds, for a few cents. [Jev](https://docs.typesafe.ai), a fast classification model from TypeSafe, judges every part of every page. Only the passages that answer your questions reach the LLM, word for word, with their source.

```
search ████████████████████████ 7/7 queries → 51 links
read   ████████████████████████ 51/51 pages · 7 blocked or failed
judge  ████████████████████████ 948/948 chunks

██ covered 25/2 sources  main Does a four-day work week improve employee productivity?
██ covered  5/2 sources  q1   By what percentage did productivity change at Microsoft Japan…
▲ supports    21 sources  c1+ A four-day work week improves employee productivity
▼ contradicts  6 sources  c1- A four-day work week improves employee productivity

▓░▒░██▒▓░▒░█▓██▒█▓▓░██▓▓▒▒▒▓█▓ 4dayjob.com 65 chunks · 28 kept
░▒░██▒█▓▒▓█▒▒▒██▓▒▓░░░░▓▒░░░░░ future-of-work.net 49 chunks · 18 kept
░▓█▓█▓▓▓█▓▓░░░░░░░░░░░░░░░░░░░ bbc.com 36 chunks · 12 kept
░░▒█▓▓▒▓▒██▓░░▓▓▓░░░░░ theguardian.com 22 chunks · 10 kept

119.6k tokens read → 7.1k kept · 13.0s · 140 Jev requests · $0.026
```

This is the live view of one round, from a real run. The strips are a map of each page: one cell per group of chunks, from the top of the page (left) to the end (right).

| Cell | Meaning |
| --- | --- |
| `█` | Jev is sure this part answers a question (p ≥ 0.8). It counts as a source. |
| `▓` | Likely answers (p ≥ 0.5). Kept. |
| `▒` `░` | Not relevant. Dropped. |
| `·` | Not judged yet |
| `✂` | 100,000 characters into the page. Tools that cut long pages stop reading here. |

One long page, read with `jev_fetch`. The answer sits far to the right of the cut:

```
RFC 9110: HTTP Semantics
▒░░░░░░░▒░░░✂░░░░░▒░░░░░░░░▒░░░░░░░▒░░░░░░░██░░░░░░░░▒░░░░░░░ 672 chunks · 1 kept · 119.8k → 400 tokens · 4.6s · $0.019
```

Expand the tool output in pi (`Ctrl+O`) to see every source and the kept passages. A line above the input box shows the totals of the session.

## Install

```bash
pi install npm:jev-search
```

Then, inside pi:

- `/jev-key` saves your TypeSafe API key. Get one at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). Required.
- `/jev-key brave` saves a [Brave Search API](https://brave.com/search/api/) key. Optional. Without it, search uses DuckDuckGo, which blocks after a few searches.

Keys stay on your machine, in `~/.pi/agent/jev-search.env`. The environment variables `TYPESAFE_API_KEY` and `BRAVE_API_KEY` also work.

## Use

```
/skill:jev-research What are the fines under the EU AI Act for general-purpose AI providers?
```

Test an idea and see both sides:

```
/skill:jev-research I believe remote work lowers team innovation. Test this thesis.
```

The agent asks you a few questions when the request is unclear, shows its plan, runs rounds until every question is covered, and writes a report with an exact quote and a link for every claim.

## How it works

1. The agent writes the plan: sub-questions, acceptance criteria, claims, search queries.
2. Code runs all searches and downloads every result at the same time. Nothing is cut.
3. Jev scores every chunk of every page against every question and claim.
4. Code counts how many independent sources answer each question.
5. The agent reads the best passages and decides: another round, or the report.

The LLM works twice per round, not once per page. Every kept passage and the telemetry of each round are saved in `~/.pi/agent/jev-search/runs/`.

## Results

| Round | Time | Jev cost |
| --- | --- | --- |
| 24 pages, 3 questions | 7.4 s | $0.01 |
| 60 pages, 3 questions and 1 claim | 15 s | $0.03 |
| Real session: 7 rounds, 466 pages, 2.19M tokens read, 39k kept | 142 s in Jev | $1.01 |

More numbers, a long-page benchmark, and a comparison with other tools: [docs/results.md](docs/results.md).

## Limits

- The score says a passage answers the question. It does not say the statement is true.
- Counts follow what the search found. Many sources can repeat one study.
- Speed is capped by Jev's rate limits.
- Blocked pages (HTTP 403, bot checks) are skipped. Pages that need JavaScript and scanned PDFs are not supported.
- Abstract questions find nothing. Ask for facts, or state a claim.

## Develop

```bash
git clone https://github.com/savka777/jev-search && cd jev-search
npm install && cp .env.example .env
npm run check
pi install "$PWD"
```

Independent project, not affiliated with TypeSafe or pi. [MIT](LICENSE)
