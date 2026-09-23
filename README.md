# ememdemo

One link. Every AI reads the same source.

Drop a file, paste text, or paste a link. The browser extracts the text, signs it with a key it generated itself, and writes it to emem. You get back one HTTPS link that ChatGPT, Claude, or a person can read. The link's file name is the hash of its bytes. Then paste the AI's answer back in, and every "quoted" passage is checked against the source.

## Files

| file | role |
|---|---|
| `emem.eio` | the whole site, in eio. Edit this, not the runtime. |
| `src/eio.mjs` | eio runtime: parser, page, flows, emem calls |
| `src/emem.css` | the one stylesheet |

## eio

One statement per line: `verb args`. `#` starts a comment. `name <<` … `>>` is a block. `{x}` is filled from the current run.

| verb | meaning |
|---|---|
| `hero` | the only heading |
| `in` / `accept` / `limit` | what the box takes, and the text size cap in bytes |
| `flow a -> b -> c` | steps that turn input into a link. The step names show on screen as it runs. |
| `open a -> b` | steps that turn an emem link back into proof |
| `give copy\|go  label  target` | one output action. Columns are separated by 2+ spaces. |
| `check` | the answer checker |
| `prompt`, `prompt_text` | what gets handed to an AI |
| `foot` | the line shown under the box |

Steps: `take text sign put link` · `fetch hash match` · `resolve` (for `emem:fact:` tokens).

## What happens, exactly

- **Text:** extraction happens in the browser. PDF uses pdf.js, docx uses mammoth, text formats are read as-is, links go through `r.jina.ai`. Scanned PDFs are refused because this site doesn't do OCR.
- **Key:** an Ed25519 key is made in the browser and kept in `localStorage`. No account and no API key.
- **Name:** `cid = base32(blake3(bytes)[0:16])`, and the path is `/memories/by_attester/<pub8>/<cid>.md`. The same bytes always get the same link.
- **Write:** `emem_memory_create` over `POST https://emem.dev/mcp`. The signature covers `blake3("emem.memory_write.v2|create|" + path + "|" + blake3(bytes) + "|absent")`.
- **Proof:** anyone can re-hash the fetched bytes and compare the result with the file name. The signature proves who wrote the bytes, not that they are true.

## Limits

- **Everything written is public**, and deleting it only unpublishes it.
- Text is capped at 2 MB.
- Plain ChatGPT, Claude, and Gemini sessions may still decline to open a link. "Copy with text" works everywhere.

## Run

It's a static site with no build step. GitHub Pages serves the repository root. To run it locally: `python3 -m http.server`.
