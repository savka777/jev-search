# Real tool check: Codex CLI with web search

Date: 2026-09-19. One run. `codex --search exec`, codex-cli 0.153.4, 4 deep cases from the test set in one prompt. The prompt allowed only the given page and asked for an exact quote and the tool action used.

| Case | Depth | Codex | How |
| --- | --- | --- | --- |
| won-window-tax | 88% | correct, exact quote | `open`, then `find` for "January, 1775" |
| rust-graceful-shutdown | 96% | correct, exact quote | `open`, then `find` for "two requests" |
| ww2-tokyo-b29 | 60% | correct, exact quote | `open`, then `find` for "Tokyo" |
| dpa-commissioner-term | 61% | not tested | `open` returned "Internal Error" twice |

Tokens used for the whole run: 98,375.

## What this means

- Codex does not lose deep text. Its web tool has a find-in-page action (OpenAI docs: `search`, `open_page`, `find_in_page`), so the model can jump to any part of a long page.
- The claim "AI agents read only the start of a page" is true for Claude Code `WebFetch` (see `real-tool-webfetch.md`) and false for Codex.
- Find-in-page is a keyword search. The model must guess words that appear in the answer. These test questions share words with their answers, which suits it. Questions worded differently from the source are the case where a semantic judge (Jev) should do better. That comparison is not done yet.
