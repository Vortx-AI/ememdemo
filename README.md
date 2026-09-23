# ememdemo

**Turn any file into a link your AI agent can read.**

The top half is one box. The bottom half is a gallery of real inputs and what they became, each re-checked live as the page loads.

The box takes anything:

| paste or drop | you get |
|---|---|
| files: PDF, scans and images (OCR), docx, pptx, xlsx, epub, html, md, txt, code, data | one link; large inputs become an **index** of sections, each listing the headings, pages or code symbols it covers |
| a URL, or a GitHub repo, folder or file | the same, read from the source (repos pinned to a commit or tag) |
| an emem link | the link re-checked: every file is re-hashed against its name |
| any emem token: `emem:fact`, `bundle`, `cell`, `entity`, `raster`, `cube`, `rasterset`, `state` | the record it names, resolved and its signature checked in the browser |
| a bare file name (26 characters) | the file, read by name over **A2A**, with its author's signature checked |
| `ask: flood risk in Chennai` | a signed answer about a place, every fact it used, and one `emem:bundle` handle for all of it |

Every result comes with tabs an agent can use directly: **preview · AGENTS.md · chat · curl · MCP · A2A · check**. The `check` tab marks each "quote" in an AI's answer as found in the source or not.

## The gallery

There are 19 cards in 7 kinds: documents, code, scans, places, agents, web, proof.

- **All cards:** on load, each card re-hashes or re-verifies its result and shows the outcome (✓ or ✗). `open` loads it into the box.
- **"Run it yourself":** on file and URL cards, this feeds the original input through the pipeline again. For fixed inputs the page confirms **"same file names as the gallery copy"**: the same bytes give the same names in any browser.
- **Places:** a signed elevation fact, a four-reading bundle, and a cube of Sentinel-2 pixels drawn from the signed grid (whose bytes hash to their name). There is also an entity, and a live question about a place.
- **Agents:** the standard two agents ratified, read by name over A2A, and **the public channel, live**: every note any agent writes, as it is written, links from this page included.
- **Proof:** emem.dev's transparency log head, with its signature checked in the browser, and **a file whose name lies**, so you can see a failed check.

The gallery's links were made with this page's own pipeline under one gallery key (`ddzmyzhn`). The sample files are in `samples/`; they were made for this page, so there are no licence strings attached.

## Proof, and who is trusted

- **Notes:** every file is named by `base32(blake3(bytes)[0:16])`. Anyone can re-hash it.
- **Receipts:** checked in the browser with **emem's own verifier** (`src/vendor/emem-verify-core.js`, Apache-2.0). It is vendored, so the page checks signatures with code it ships.
- **Signer:** the expected key is pinned in `emem.eio` (`signer 777er3yi…`). A receipt signed by any other key does not count.
- **Fact and raster bytes** are re-hashed against their ids.
- **States** have no signature; the page checks that their bytes hash to their name, and says so.
- **Notes read by name** have their author's ed25519 signature checked.
- **The log head's** signature is checked; the curl tab shows how to prove later that the log only grew.

A signature proves who wrote the bytes, not that the claim is true.

## The maths, stated

- **Names.** A file's name is the first 128 bits of BLAKE3 over its bytes, base32. Making different bytes with the same name takes about 2^128 tries (second preimage). The chance that two of a billion files collide by accident is about 1.5·10⁻²¹ (birthday bound).
- **Hash tree.** An index lists every section by its name, so the index's own name commits to the whole document. Change one byte in one section and that section's name changes, so the index's name changes too. Opening a link re-hashes the index and every section.
- **Signatures.** Ed25519 via emem's own verifier. The signer must equal the key pinned in `emem.eio`.
- **Token counts.** `tokens ≈ 1.10·words + 2.21·digit-runs + 0.57·punctuation + 0.33·newlines`. This was fitted by least squares against the o200k tokenizer on 60 of this gallery's files and tested on the other 30:

  | method | median error | 90th percentile |
  |---|---|---|
  | this fit | 4.8% | 9.8% |
  | length / 4 (before) | 15.8% | 29.8% |

  Claude's tokenizer differs from o200k, so read counts as estimates.
- **Index terms.** Each index entry also lists up to five distinctive terms: words frequent in that section and rare in the others, ranked by tf·idf with idf = ln(N/df). This matters most for sections with no headings.
- **Answer check.** It reports three independent measures:
  - **Quotes:** exact matches after normalizing whitespace, quote marks and markup. An ellipsis splits a quote into parts that must appear in order.
  - **Sentences:** the share of each sentence's 3-word runs that occur in the source. At 60% or more it traces word for word. A faithful paraphrase scores low, which is the honest reading: it cannot be traced mechanically.
  - **Numbers:** a number in the answer counts only if the source has it within ±250 characters of at least two of that sentence's other content words. A number that appears somewhere in the source does not count unless it sits next to what the sentence says. (Tested: "RFC 9110 defines 63 status codes" is flagged; 422, 9110, 2022 and 7231 hold.)

## Principles, as rules the page enforces

`src/eio.mjs` refuses to render if `emem.eio` breaks a rule, and names the rule:

| principle | rule |
|---|---|
| The hero says what goes in, what comes out, and who uses it. Short. | `rule words say 6..12` |
| No insider words before there is a result | `rule plain say in note blank : cid blake3 ed25519 hash signed token …` |
| Every step is declared, implemented, and its types connect | `rule typed make open resolve ask` |
| Every output carries the result | `rule carry give : {link} {index} {curl} {mcp} {a2a}` |
| Every gallery card opens something the page can open, and runs only files it can read | `rule gallery show` |

## eio: the language the site is written in

`emem.eio` is the whole site: copy, header links, the token family, file kinds, limits, typed steps, flows, output tabs, gallery and rules.

```
link   A2A  https://emem.dev/a2a
token  fact : one signed measurement at a place | POST /v1/memory_token/resolve {"token":"{token}"} | emem_memory_token_resolve
step   split : docs -> sections
flow   make  : read text split sign store link
give   A2A << … {a2a} … >>
show   places : Bengaluru, ground elevation << tag emem:fact · emem emem:fact:… · pin a signed fact >>
rule   gallery show
```

## Files

| file | role |
|---|---|
| `emem.eio` | the site |
| `src/eio.mjs` | compiler, rules, page, flows, gallery |
| `src/read.mjs` | any input becomes markdown with headings, then sections and an index |
| `src/emem.mjs` | the wire: names, keys, signed writes, reads, the token family, proofs, ask, the channel feed |
| `src/vendor/` | emem's verifier, pinned (Apache-2.0) |
| `src/img/` | the emem mark, from Vortx-AI/emem |
| `samples/` | the gallery's sample files |

## Wire, exactly

- **Write:** `POST https://emem.dev/a2a/tasks {"skill":"emem_memory_create",…}`, signed with a browser Ed25519 key. `/mcp` refuses browser origins. Writes are paced under emem's per-key limit.
- **Read:**
  - a plain `GET` of the link;
  - A2A `emem_memory_view {"file_cid"}`;
  - MCP on `https://emem.dev/mcp/full`.
- **Tokens:** resolved per the rows in `emem.eio`; receipts checked client-side.
- **Ask:** `POST /v1/ask` with `Accept: text/event-stream`. The steps stream in (the place, then the facts, then the answer), and the cited facts are bundled with `POST /v1/memory_bundle`.
- **Channel:** `EventSource /v1/memory/sse?path_prefix=/memories/by_attester/`, seeded with A2A `emem_memory_list_by_kind`.

## Limits, stated

- **Everything written is public.** Deleting only unpublishes.
- **Size:** 4 MB of text and 160 sections per link.
- **OCR:** English only, first 40 pages. The recognizer (7 MB) loads on first use.
- **Ask** only answers questions about places, and takes 2–30 s depending on how warm emem.dev is.
- **Not supported:** `emem:trace` / `emem:attestation` have no public examples, so the page does not claim to resolve them. `emem:state` has no MCP tool; the page says so.
- **Chat apps:** plain ChatGPT, Claude or Gemini sessions may decline to open links. Coding agents, MCP and A2A clients do open them.

## Run

It's a static site served by GitHub Pages from the repository root. To run it locally: `python3 -m http.server`.
