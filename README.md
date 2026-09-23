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

## A website that proves itself

Most websites ask you to trust whoever serves them. This one checks itself before it runs.

- **Sealed.** `tools/seal.mjs` stores every file the page runs on emem.dev, each named by the hash of its bytes and signed by the site key. It also stores a **manifest** listing each file's sha256, plus the sha256 of every third-party reader the page may load (pdf.js, mammoth, SheetJS, JSZip, tesseract's entry module). `index.html` pins the manifest by its link and sha256.
- **Checked before running.** The loader in `index.html` uses only the browser's built-in SHA-256, so it trusts no library first. It then:
  - verifies the manifest against the pin;
  - verifies each file;
  - runs modules only from their verified bytes (blob URLs, with relative imports pointed at the verified copies);
  - checks third-party readers against the manifest before they run.
- **Self-healing.** If this site's copy of a file has been altered (a bad deploy, a compromised host), the loader fetches the true bytes from emem.dev and says so in the footer. If the manifest itself doesn't match the pin, the page refuses to run and says why. All three cases were tested: a normal load, a tampered `emem.mjs` (restored), and a tampered manifest (refused).
- **Host-independent.** `?boot=emem` runs the whole page from emem.dev alone; GitHub Pages only has to serve `index.html`.
- **Signed.** The footer shows `sealed · 9 of 9 files checked · signed by ddzmyzhn`. The manifest's author signature is checked over A2A.
- **In its own gallery.** The proof section has "This website, sealed"; opening it re-hashes the manifest the page is running from.
- **Exceptions, stated:**
  - `index.html` is the trust root and cannot seal itself; it is 60 lines and readable.
  - Tesseract fetches its worker, WASM core and language data itself, so only its entry module is pinned.
  - Images are not sealed.

**Changing the site:** edit, then run `EMEM_KEY_FILE=<site key backup> node tools/seal.mjs`, then commit. Without that, a sealed page restores the last sealed code from emem, which is the point. `?boot=local` runs unsealed code for development, and the footer says so.

## For agents: the same source, compiled twice

`emem.eio` compiles into the human page and, through `tools/seal.mjs`, into two files an agent can read:

- **`llms.txt`:** every flow as the emem.dev call an agent can make itself (store, read and re-hash, check with emem-guard, ask), the token family table, the signer key, and the worked examples.
- **`.well-known/agent-card.json`:** an A2A agent card whose skills run at emem.dev's A2A endpoint. The site has no server of its own.

Both are sealed with the site, so an agent can check them the same way.

## Checks that leave proof

- **emem-guard.** When an answer cites emem tokens, the check tab sends it to emem-guard, which resolves every citation and returns a signed **allow** or **deny** with a reason code. The page checks that verdict against the pinned key. Tested: "Bengaluru's elevation is 915.07 m (emem:fact:…)" gets **allow**; the same sentence with 870 gets **deny PROV_VALUE**.
- **Seal this check.** One click publishes the findings as a signed, hash-named note (`emem: check.v1`). It holds the answer, a pointer to the source, the guard verdict and every finding, so anyone can recompute it. The chat prompt asks the AI to cite the emem token next to each number, so answers become guard-checkable.
- **Your key.** The footer can **back up** the browser's key to a file and **restore** it elsewhere. Whoever holds the file can write as you.

## The gallery

There are 20 cards in 7 kinds (19 when unsealed): documents, code, scans, places, agents, web, proof.

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
| `index.html` | the loader: checks every file against the pinned seal before running it |
| `src/lang.mjs` | the eio compiler, pure, shared by the page and the seal tool |
| `src/eio.mjs` | rules, page, flows, gallery, checks |
| `tools/seal.mjs` | seals the site on emem and compiles `llms.txt` and the agent card |
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
