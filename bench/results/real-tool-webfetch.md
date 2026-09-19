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

- The two columns do not measure the same thing. `WebFetch` "found" means the tool gave the answer with a quote. Jev "kept" means the chunk with the answer passed the filter; an LLM must still read the kept chunks and answer. Arm B with an answering LLM will close this gap.
- One tool, one run, 18 cases. Other tools cut at other sizes.
- The questions share words with their answer passages.
- Time per `WebFetch` call was not measured.
