# Security

Council runs inside DeepSeek Harness and uses its provider credentials, tools, and session storage. Review and arbitration inputs contain model-generated text. Prompts treat that text as untrusted; prompt instructions are not a security boundary.

Topic-only children retain `web_search` and `web_fetch`. Chat-background children have no global tools: files, Shell, Web and further delegation are denied both in presentation and by the final execution guard. Reviewers and the arbiter receive only activation-scoped `structured_output`, which is not restored on cold continuation.

Chat background is an explicit export, not inherited authority. The exact live root and authoritative current Inbox are fenced before capture. Only selected plain text from allowed provenance is previewed and exported after explicit consent to all routes. System/developer/runtime prompts, reasoning, unknown producers and inseparable historical audit text are excluded. Assistant text is unverified advice, not a confirmed user decision. No files or attachment bodies are read or OCRed. A preview is not a guarantee that text contains no secrets: inspect it carefully.

The consented public packet, private local references and per-stage material identities are durably recorded. Private source references and provider metadata never enter public packets. Packet hashes are integrity identities, not signatures, factual verification or consent by themselves. Actual child requests check approved routes, output ceilings, allowed schemas and heuristic context-window budgets before dispatch. Cold chat continuation restores these ceilings or fails closed; it cannot silently switch providers.

Only a compact producer-owned ModelReturn is queued into the original chat. Full audits remain UI metadata/child history. Cleared pending input is not reinserted by reopening, and interrupted full runs do not automatically restart. Editing a source cannot recall copies already exported to providers or child sessions. Old admitted v1 audits are not migrated out of parent history by this change.

For vulnerabilities, use GitHub private vulnerability reporting once enabled on the published repository. Until a private channel is available, contact the maintainer privately. Do not post exploit details or credentials in public issues. Ordinary bugs follow [CONTRIBUTING.md](CONTRIBUTING.md).

Redact API keys, Web access tokens, private prompts, and sensitive provider responses from diagnostics. Revoke any disclosed credential through its provider.
