# ememdemo

**Turn any file into a link your AI agent can read.**

Drop files, paste text, or paste a URL or GitHub repo. You get one link. Large inputs become an **index**: one line per section, with the headings, pages or code symbols it covers. Your agent reads the index (a few thousand tokens), then opens only the sections the task needs.

## Why developers use it

- **Your agent can't see your docs, so it guesses.** A 200-page spec doesn't fit in its context. A converter gives you text you paste everywhere and that goes stale. This gives you an address.
- **Same bytes for every agent.** Claude Code, Cursor, Codex, ChatGPT and a teammate's agent all read the same files.
- **Checkable.** Each file is named by the hash of its bytes. Opening a link re-hashes the index and every section, and names any file that doesn't match. The `check` tab marks each quote in an AI's answer as found in the source or not.
- **No account.** The browser makes its own signing key.

## Tested with a real agent

On RFC 9110 (194 pages, ~126k tokens), given the task *"What does this spec say about 422, and what does 'idempotent' mean?"*:

- **First version:** the index listed sections by page range, and the agent said it couldn't choose.
- **This version:** from the ~3k-token index, the agent picked the 2 right sections out of 26 and quoted them word for word.
- **The check tab:** it passed the real quotes and flagged an invented one.

## What it reads

| input | how |
|---|---|
| PDF | pdf.js. Headings come from the PDF's bookmarks, then numbered headings, then font size. Running headers and footers are dropped, and `[page N]` markers are kept for citations. |
| Scanned PDF, images | OCR with tesseract.js (first 40 pages) |
| docx, pptx (with speaker notes), xlsx (per sheet), epub (per chapter), html | mammoth, JSZip, SheetJS, DOM |
| md, txt, rst | headings from `#`, underlines, and numbered lines (`4.2.1. http URI Scheme`) |
| code and data | kept whole; covers show the symbols (`app.use`, `res.send`, `def parse` …) |
| URL | `r.jina.ai` (its title and preamble become metadata, not content) |
| GitHub repo, folder or file URL | listed and served by jsDelivr, pinned to the commit when the GitHub API answers. The README comes first; changelogs, tests and lockfiles are ranked last. If a repo doesn't fit in one link, the index says what was left out. |

## Principles, as rules the page enforces

`src/eio.mjs` refuses to render if `emem.eio` breaks a rule, and names the rule:

| principle | rule |
|---|---|
| The hero says what goes in, what comes out, and who uses it. Short. | `rule words say 6..12` |
| No insider words before there is a result | `rule plain say in note empty blank : cid blake3 ed25519 hash signed token …` |
| Every step is declared, implemented, and its types connect | `rule typed make open` |
| Every output carries the link or the index | `rule carry give : {link} {index}` |

These hold by construction:

- **Output before input.** The index tab shows a real excerpt before anything is dropped.
- **Nothing is called a link until emem has stored it.**
- **Public is said up front,** before anything is dropped.
- **Every step is visible while it runs.** Every failure names its cause.

## eio: the language the site is written in

`emem.eio` is the whole site: copy, file kinds, limits, typed steps, flows, output tabs and rules. `src/eio.mjs` compiles it, checks it, draws it and runs it. `src/read.mjs` turns inputs into markdown and sections.

```
say   Turn any file into a link your AI agent can read.
kind  docs : pdf docx pptx xlsx epub html md txt …
step  split : docs -> sections
flow  make  : read text split sign store link
give  AGENTS.md << … {link} … >>
rule  typed make open
```

## Wire, exactly

- **Name:** `cid = base32(blake3(bytes)[0:16])`. The path is `/memories/by_attester/<pub8>/<cid>.md`, so the same bytes always get the same link.
- **Signature:** `blake3("emem.memory_write.v2|create|" + path + "|" + blake3(bytes) + "|absent")`, signed with a browser Ed25519 key kept in `localStorage`.
- **Write:** `POST https://emem.dev/a2a/tasks {"skill":"emem_memory_create",…}`.
  - `/mcp` refuses browser origins.
  - Writes are paced under emem's per-key limit (about 60 burst, then about 4 per second).
- **Read:**
  - a plain `GET` of the link;
  - `curl` plus a one-line re-hash (in the `curl` tab);
  - MCP `emem_memory_view` on `https://emem.dev/mcp/full`.

## Limits, stated

- **Everything is public.** Deleting only unpublishes; the bytes stay readable by hash.
- **Size:** 4 MB of text, 160 sections of about 6k tokens each, per link.
- **Big repos:** a large repo takes about a minute (reading, then paced writes). The progress count shows while it runs.
- **Stale branches:** without the GitHub API (60 requests an hour per IP), repos fall back to jsDelivr's branch listing, which can be stale. Missing files are listed under "Not included".
- **OCR** is English only.
- **Audio and video** are not read.
- **Chat apps:** plain ChatGPT, Claude or Gemini sessions may decline to open links. Coding agents and MCP clients do open them.

## Run

It's a static site served by GitHub Pages from the repository root. To run it locally: `python3 -m http.server`.
