# jev-search plan

## Goal

Show, with numbers, that Jev can replace the lossy compression step of deep research. Standard harnesses cut a fetched page at a fixed size and let a small LLM summarize it. jev-search keeps the full page, splits it into chunks, and lets Jev decide which chunks to keep. The kept text is verbatim.

Ship it as a pi package with a live view of sources and keep/discard decisions.

## Non-goals (v1)

- JavaScript-rendered pages and PDFs.
- Embeddings or reranker arm (possible later arm D).
- Our own retry, rate-limit, or provider layer. The TypeSafe SDK and pi handle these.

## Phases

1. **Bench on fixed pages.** Hand-picked long pages, fixed questions, known answer passages. Only the compression step changes between arms. This isolates step 5 and gives the clean "what is lost" number.
2. **End to end in pi.** `/research <objective>`: plan, search, fetch, judge, synthesize. Live view. Per-step metrics.
3. **Release.** README with results and a recording. Repo goes public.

Phase 1 comes first because one end-to-end run has too much noise: search results, fetched sources, and LLM sampling all change between runs. A difference could come from luck, not from step 5.

## Arms

| Arm | Step 5 | Purpose |
| --- | --- | --- |
| A | Cut page at N characters, small LLM writes a query-focused summary | What harnesses do today |
| B | Full page, chunks, Jev keep/discard, verbatim chunks | jev-search |
| C | Full page in the lead model context, no compression | Upper bound for recall; shows cost and time |

Arm A parameters (cut size, model, prompt) are configurable and documented, so the baseline is not a strawman.

## Bench cases

Each case: URL, question, expected answer, and the exact answer passage with its character offset. Offsets are grouped by depth: first quarter, middle, last quarter, beyond the arm A cut.

- Dev set (about 3 pages): used to tune the Jev question wording.
- Test set (10 or more pages): measured once, never tuned against.
- Raw pages are cached in `bench/.cache/` (not committed). Cases commit URL plus content hash.

Candidate pages to measure first (all public, long, single page): EU AI Act and GDPR on EUR-Lex, RFC 9110, the Bash reference manual, the Rust book print page, Python "What's New" pages, long Wikipedia articles, SEC 10-K filings.

## Metrics

Per step (plan, search, fetch, convert, chunk, compress or judge, synthesize): wall time, tokens in, tokens out, cost, errors. HTTP 429 and retries are logged apart from model latency.

Per arm:

- **Evidence recall:** share of answer passages that reach the lead model. Reported by depth group.
- **Answer accuracy:** exact or regex match on the expected value where possible; LLM judge, blind to the arm, elsewhere.
- **Tokens passed to the lead model.**
- **Step 5 time and total time.** Both are reported. Synthesis time can hide a step 5 gain.
- **Cost.**

## Jev request design

Facts from the TypeSafe docs (read 2026-09-19): `jev-1.13.0`, $0.042 per million input tokens, output free; 64k tokens per request, 32k for state plus the longest question; 250k tokens per second; 1,200 requests per minute. Jev reads the state once and answers all questions in parallel. Accuracy falls when the state is large and mostly irrelevant. Jev reads instructions literally, does not count, and does not generate text.

Design that follows:

- The planner LLM writes sub-questions. For each one it also writes a literal evidence criterion: what counts and what does not.
- Chunks: split on headings, then paragraphs. Tables stay whole up to a cap; larger tables split by rows with the header row repeated. About 250 tokens per chunk. Each chunk records URL, heading path, and character offset.
- One request: 5 to 10 adjacent chunks, plus page title and heading path, as state. Adjacent chunks give context ("It rose 12%": what is "it"?) and keep the request rate below the limit.
- Questions per chunk, all Noul: one per sub-question ("Does `chunks[i]` state a fact, number, date, or quote that helps answer: ...?"), one catch-all for the research objective, one for boilerplate.
- Code combines the probabilities. Keep a chunk when its best evidence probability is at or above a threshold. When kept text exceeds the token budget, drop the lowest first.
- Notes store verbatim chunks with URL, offset, and probability. The full chunk store stays on disk. New sub-questions re-judge stored chunks; no new fetch.
- Stop rule (phase 2): code counts distinct domains with a chunk above the "directly answers" threshold. Counting stays in code.

## Pi integration

Verified against pi 0.80.10 docs (`docs/extensions.md`, `docs/packages.md`):

- Package manifest: `pi.extensions` in `package.json`. Install with `pi install git:github.com/savka777/jev-search`.
- `pi.registerCommand("research", ...)` and a tool for model-driven use.
- LLM calls use the session model: `ctx.model`, `ctx.modelRegistry.getApiKeyAndHeaders(model)`, and `complete()` from `@earendil-works/pi-ai/compat`. No separate provider code.
- Live view: `ctx.ui.setWidget(...)`. One row per source: status, chunk count, and a heat strip (one cell per chunk, shaded by probability) with a mark where arm A would have cut the page.
- Jev: `@typesafe-ai/sdk`, key from `TYPESAFE_API_KEY`.

## Layout

```
src/pipeline/    plan, search, fetch, chunk, judge-jev, compress-llm, synthesize, metrics
src/extension/   pi entry (command, tool) and the live view
bench/cases/     URLs, questions, answer passages
bench/results/   JSON and Markdown reports (committed)
bench/.cache/    raw pages (not committed)
docs/            this plan
```

`src/pipeline` has no pi dependency, so the bench and the extension call the same code.

## Open decisions

- Search provider for phase 2 (no search key is set today).
- Arm A summarizer model.
- License, before the repo goes public.
