# vendor

`emem-verify-core.js` is emem's own receipt verifier, copied byte for byte from
[Vortx-AI/emem](https://github.com/Vortx-AI/emem) `web/emem-verify-core.js` (commit 5e031f5, identical to
https://emem.dev/emem-verify-core.js on 2026-09-23). Apache-2.0, see `LICENSE-emem`; its bundled noble
libraries are MIT. It is pinned here so a page checks signatures with code it ships, not code fetched from
the server whose signatures it is checking.
