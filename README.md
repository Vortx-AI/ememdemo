# ememdemo

Experimental one-action surface for emem.

**The world is shared. Its memory should be too.**

The browser prototype is intentionally dependency-free: native Web Components, CSS cascade layers, CSS math, Web Crypto and semantic HTML. It accepts files or pasted text/links and creates a local deterministic content address as a UX prototype.

> The generated `emem:bundle:sha256:...` in this prototype is **not** a production emem protocol token or signed receipt. It exists to test the interaction before wiring the real emem ingestion/resolution APIs.

## Product rule

One action: **drop anything → emem it**.

The human surface stays simple. Provenance, token typing, world referents, curation and verification belong underneath and are progressively disclosed.

## Run

Serve this directory with any static HTTP server, or GitHub Pages. No build step and no package install are required.
