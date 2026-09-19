---
name: jev-research
description: Fast deep web research with the jev_research tool. Use when the user asks to research a topic, do a deep search, compare sources, or answer a question that needs current or cited information from the web.
---

# Deep research with jev_research

`jev_research` runs one research round in seconds: it runs all your search queries, reads every result page in full, and Jev judges every part of every page against every sub-question. You get a coverage table and the exact passages. You do the thinking: the plan, the next round, and the report.

## 1. Grill the user first, when the objective is not clear

A research round is only as good as its sub-questions and acceptance criteria. Decide if you can write them from the request. If you cannot, ask before you search. Ask everything in one message, as numbered questions, at most 5. Offer a default for each, so the user can answer "defaults".

Ask only what changes the plan:

- **Decision.** What will the user do with the answer? What would change their mind?
- **Scope.** Which region, time period, industry, or product? What is out of scope?
- **Acceptance criteria.** What counts as an answer: a number, a date, a named source, a quote? What does not count?
- **Sources.** Which sources do they trust or reject? Primary sources only? How many independent sources are enough?
- **Depth.** A quick check (1 round) or a full report (several rounds)?

Skip this step when the request already answers these points. Do not grill for a simple factual question.

## 2. Plan

Write 2 to 8 sub-questions. Each one must be answerable by a single passage. Jev reads literally, so name the entities and the fact you want.

- Good: "What is the maximum fine for providers of general-purpose AI models under the EU AI Act?"
- Bad: "fines?" or "Tell me about enforcement."

For each sub-question write `criteria`: what counts and what does not. Example: "An amount in euros or a percentage of turnover, for GPAI providers specifically. General fines for other operators do not count."

Show the plan to the user in a short list before the first round. Continue without waiting unless they grilled you back.

## 3. Run rounds

1. Call `jev_research` with all sub-questions and 3 to 10 search queries. Vary the queries: official names, article numbers, synonyms, primary-source sites. Add known primary sources as `urls`.
2. Read the coverage table. `covered` means enough independent sources gave a passage with p ≥ 0.8.
3. For sub-questions that are `open` or `partial`, write new queries and call `jev_research` again with only those sub-questions. If a sub-question found nothing twice, reword it: the wording may not match how sources state the fact.
4. Stop when every sub-question is covered, or when 2 rounds in a row add nothing. Say which sub-questions stay open.

Use `jev_fetch` only to read one specific URL. Use `web_search` only when you need to see raw search results.

## 4. Report, with linked sources

- Lead with the answer.
- Every claim needs a source link and a short exact quote from the returned passage, in this form: claim, then `> "exact quote"` and `[Source title](URL)`.
- End with a **Sources** list: every URL you used, as links, with one line on what it supports.
- Prefer primary sources (laws, standards, official documentation, filings, papers) over pages that summarize them. When only summaries were found, say so.
- p is the probability that a passage answers the sub-question. It is not proof that the statement is true. When passages disagree, show both, with their sources, and say which is more reliable and why.
- Separate what the sources state from your own conclusions.

## Rules

- Do the research yourself, in this session, with `jev_research`. Do not hand it to sub-agents, teams, or shell commands such as `curl`: they do not have these tools and they cut long pages.
- Use only returned passages as evidence. Do not fill gaps from memory; mark them as not found.
- If pages fail (HTTP 403, 429, a bot check, a PDF), skip them. Do not try to work around a block.
- If the tool reports that no TypeSafe API key is set, tell the user to run `/jev-key`.
