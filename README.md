# ememdemo

**Turn any file into a link your AI agent can read.**

Drop files, paste text, or paste a URL or GitHub repo. You get one link. Paste it into `AGENTS.md`, `CLAUDE.md`, a chat, or an MCP call. Large inputs become an index of sections, so the agent reads the short list and fetches only what the task needs.

## Who it is for, and why

Coding agents guess when they can't see the docs, and a 300-page spec doesn't fit in their context. Converters (markitdown, gitingest, Firecrawl) produce text. You still have to paste it everywhere, and it goes stale. This produces an **address**:

- **Same bytes for every agent.** Claude Code, Cursor, Codex and ChatGPT all read the same file.
- **Sections on demand.** An llms.txt-style index points to sections of about 6k tokens each, and the agent fetches only the ones it needs.
- **Checkable.** Every file is named by the hash of its bytes, so anyone can re-hash it and prove nothing changed. The `check` tab marks each quote in an AI's answer as found in the source or not.
- **No account.** The browser makes its own signing key.

## Principles, as rules the page enforces

`src/eio.mjs` refuses to render if `emem.eio` breaks one of these rules:

| principle | rule in `emem.eio` |
|---|---|
| The hero says what goes in, what comes out, and who uses it. Short. | `rule words say 6..12` |
| No insider words before there is a result | `rule plain say in note empty : cid blake3 ed25519 hash signed token emem: …` |
| Every step is declared, implemented, and type-checked end to end | `rule typed make open` |

These hold by construction, in the runtime:

- The output is visible before any input. Each tab shows its template with `‹your link›`.
- Every output is text that works when pasted, never an explanation.
- Nothing is shown as a link until emem has stored it (or it already exists with a matching hash).
- The page says the link is public before anything is dropped.
- Every step shows on screen while it runs. Every failure names the cause and the limit.

## eio: the language the site is written in

`emem.eio` is the whole site. `src/eio.mjs` compiles it, checks its rules, draws it, and runs it.

```
say   Turn any file into a link your AI agent can read.      # the one heading
step  split : docs -> sections                               # typed IO step
flow  make  : read text split sign store link                # must type-check
give  AGENTS.md << … {link} … >>                             # one output tab
rule  words say 6..12                                        # a broken rule stops the page
```

Statements go one per line. `<<` … `>>` is a block, and `{x}` is filled from the run.

**Flows:**

- `make`: `read` (files / text / URL / GitHub repo) → `text` (pdf.js, mammoth, raw) → `split` (headings, pages, ≤24k characters) → `sign` (Ed25519 over the emem write digest) → `store` → `link`
- `open`: `fetch` (the link plus every section it lists) → `prove` (re-hash each file against its name)

## Wire, exactly

- **Name:** `cid = base32(blake3(bytes)[0:16])`. The path is `/memories/by_attester/<pub8>/<cid>.md`.
- **Signature:** `blake3("emem.memory_write.v2|create|" + path + "|" + blake3(bytes) + "|absent")`, signed with a browser Ed25519 key kept in `localStorage`.
- **Write:** `POST https://emem.dev/a2a/tasks {"skill":"emem_memory_create","args":{path,file_text,kind,attester}}`. `/mcp` refuses browser origins (`EMEM_MCP_ALLOWED_ORIGINS`); `/a2a/tasks` runs the same tool.
- **Read:** a plain `GET` of the link, or MCP `emem_memory_view {"file_cid": …}` on `https://emem.dev/mcp/full`.

## Limits, stated

- **Everything is public.** Deleting only unpublishes; the bytes stay readable by hash.
- **Size:** 4 MB of text and 160 sections per drop.
- **Scans:** scanned PDFs are refused because there's no OCR.
- **GitHub:** repos use the unauthenticated API, which allows 60 requests an hour.
- **URLs** are read through `r.jina.ai`.
- **Chat apps:** plain ChatGPT, Claude or Gemini sessions may decline to open links. Coding agents and MCP clients do open them.

## Run

It's a static site served by GitHub Pages from the repository root. To run it locally: `python3 -m http.server`.
