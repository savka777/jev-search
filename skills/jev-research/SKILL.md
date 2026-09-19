---
name: jev-research
description: Deep web research with the web_search and jev_fetch tools. Use when the user asks to research a topic, do a deep search, compare sources, or answer a question that needs current or cited information from the web.
---

# Deep research with jev_fetch

`jev_fetch` reads a full page of any length. Jev judges every part of the page against your questions and returns only the passages that answer them, word for word. A page that does not answer returns nothing and costs almost nothing. So read widely.

## Steps

1. **Plan.** Split the objective into 3 to 6 sub-questions. Write each one so it can be answered by one passage. Name the entities and the fact you want: "What is the maximum fine for prohibited AI practices under the EU AI Act?" and not "fines?". Jev reads questions literally.
2. **Search.** Run `web_search` with 2 to 4 different queries. Prefer primary sources (laws, standards, papers, official documentation, filings) over summaries of them.
3. **Read widely.** Call `jev_fetch` on 8 or more results in parallel. Pass all sub-questions that the page could answer, in every call. Do not pick only the 2 or 3 best-looking results: a bad page costs about a cent.
4. **Record.** For each sub-question, note the passages that answer it, with the URL and the chunk number. Passages are exact quotes from the page; quote them exactly.
5. **Fill gaps.** For a sub-question without an answer, or with only one source, write a new query and repeat steps 2 to 4. When sources disagree, read more sources on that point.
6. **Stop** when every sub-question has passages from 2 independent sources, or when 2 more rounds found nothing new. Say which sub-questions stay open.
7. **Report.** Lead with the answer. Support each claim with a short exact quote and its URL. Separate what the sources state from your own conclusions.

## Rules

- Do the research yourself, in this session, with `web_search` and `jev_fetch`. Do not hand it to sub-agents, teams, or shell commands such as `curl`: they do not have these tools and they cut long pages.
- Use only the returned passages as evidence. Do not fill gaps from memory; mark them as not found.
- A reply of "No passage answers the questions" means the page does not contain the answer. Move on.
- Very long pages are fine. The page is never cut.
- If a fetch fails (HTTP 403, 429, or a bot check), skip that source. Do not try to work around the block.
