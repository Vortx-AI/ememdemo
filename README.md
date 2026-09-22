# ememdemo

A deliberately thin browser surface over emem.

## Truth rules

- The browser never fabricates an `emem:` token.
- Local files are only inspected locally until a real emem write path is used.
- Existing `emem:fact:` tokens resolve through `POST /v1/memory_token/resolve`.
- Existing `emem:bundle:` tokens resolve through `GET /v1/memory_bundle/<token>`.
- Returned receipts are sent to `POST /v1/verify_receipt` when present.
- A valid signature means the signed bytes and attester verify. It does not mean a claim is objectively true.

The hosted emem.dev memory substrate requires attestation for writes. Arbitrary browser uploads therefore do not silently become signed emem memory.

## Run

Static site. No package manager, build step, framework, or server required. GitHub Pages can publish the repository root directly.
