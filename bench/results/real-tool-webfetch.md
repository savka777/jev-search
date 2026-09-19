# Real tool check: Claude Code WebFetch

Date: 2026-09-19. One run. Test set only (21 cases).

## Method

`WebFetch` fetches a URL, converts the page to Markdown, and lets a small model answer a prompt from that content. Each case was one call with the page URL and this prompt:

> Use only the page content you received. Do not use your own knowledge. Question: `<question>` Give the answer and quote the exact sentence from the page that states it. If the page content does not state the answer, reply exactly: NOT FOUND.

7 calls came from the main Claude Code session. 14 came from an Opus sub-agent that only relayed the tool output.

## Result

18 cases could be tested. `WebFetch` answered 4. The Jev filter kept the answer chunk in all 18 (see `arm-b-test.json`).

| Case | Depth | WebFetch | Jev filter |
| --- | --- | --- | --- |
| rust-version | 0% | found | kept |
| won-pin-operations | 1% | found | kept |
| dpa-child-age | 2% | found | kept |
| rfc-uri-length | 10% | found | kept |
| ww2-denmark | 18% | NOT FOUND | kept |
| dpa-max-penalty | 28% | NOT FOUND | kept |
| rust-orphan-rule | 34% | NOT FOUND | kept |
| ww2-bretton-woods | 41% | NOT FOUND | kept |
| won-invisible-hand | 45% | NOT FOUND | kept |
| ww2-tokyo-b29 | 60% | NOT FOUND | kept |
| dpa-commissioner-term | 61% | NOT FOUND | kept |
| won-spinners | 66% | NOT FOUND | kept |
| rfc-305 | 70% | NOT FOUND | kept |
| rfc-418 | 73% | NOT FOUND | kept |
| rust-unsafe-superpowers | 82% | NOT FOUND | kept |
| won-window-tax | 88% | NOT FOUND | kept |
| rfc-60-second | 92% | NOT FOUND | kept |
| rust-graceful-shutdown | 96% | NOT FOUND | kept |

By depth: `WebFetch` answered 4 of 4 cases in the first 10% of the page and 0 of 14 cases deeper than that.

Not tested: `bash-huponexit`, `bash-tmout`, `bash-enable-restricted`. gnu.org returned HTTP 429 to the tool on every call, so no page content was read.

## What the tool said

The replies name the cause:

- rfc-305: "the detailed content for that section is not included in the truncated page excerpt provided."
- rust-unsafe-superpowers: "The content ends abruptly in the 'Data Types' section of Chapter 3".
- dpa-max-penalty: "The excerpt ends before reaching the sections that would address administrative fines or penalty notices."

## Limits of this check

- The table compares a final answer (`WebFetch`) with a kept chunk (Jev). The section below closes that gap.
- One tool, one run, 18 cases. Other tools cut at other sizes.
- The questions share words with their answer passages.
- Time per `WebFetch` call was not measured.

## Final answers from the Jev path

Run: `npm run bench -- --set test --answer` (results in `arm-b-test-answer.json`). The chunks that Jev kept (best first, 3,000 token budget) went to the LLM with the same prompt as above. The LLM was `openai/gpt-5.6-sol` through `pi -p` with no tools.

- Correct final answers: 21 of 21 (18 of 18 on the cases `WebFetch` could test, where `WebFetch` gave 4).
- Text sent to the LLM: median 469 tokens per question. The pages hold 56k to 554k tokens.
- LLM answer time: median 2.1 s per question, pi start-up included.

The answering models differ: `WebFetch` uses a small fast model, this run used the pi default model. The 14 `WebFetch` misses are not model errors; the tool reported that the text was not in the content it received.
