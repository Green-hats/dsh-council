# Chat and context integration — 0.1.3

This version has local engineering and isolated Host qualification, not completed real-device visual acceptance. Publishing it does not install it into an active profile. The [implementation report](context-integration-implementation-report.md) records current validation results and remaining device checks.

## Expected conversation

1. `/council` retains a blank session through the existing AgentLoop-driven zero-step marker turn, without a parent model completion or fabricated turn events.
2. Unless configured `contextMode: topic-only`, choose current chat background, topic only, or cancel. Chat capture occurs immediately after this choice, before roster selection. It reads the exact idle live runtime root's effective messages and a synchronous authoritative Inbox cut. It never reconstructs an old snapshot by filtering today's Surface or scans old inserts as pending.
3. Select 2–8 answerers, 1–8 reviewers, one arbiter, and the original topic. Each role uses a fresh independent child session; there is no fork or reuse of previous agents.
4. In chat mode, explicitly choose all exportable non-tool text or individual aliases. Tool evidence is opt-in. System/developer/runtime context, reasoning, unknown producers, progress/policy markers and inseparable legacy audits are excluded. Attachments remain reference-only/excluded metadata: no file reading or OCR.
5. The ordinary native question flow shows the **entire actual public packet**, all receiving routes, Web/file restrictions and recall limitations. It uses no plan-review summary intent and does not inject preview questions into parent history. Return/reselect invalidates consent. Missing capabilities, unstable capture, unknown windows or oversized material require an explicit fallback or cancel; there is no silent truncation or successful-background label on topic-only runs.
6. On agreement, Host revalidates current selected source identities, content and provenance; freezes canonical packet/export hashes; and durably commits the packet before launching the first child. Each initial request rechecks source withdrawal before adapter dispatch. New ordinary messages are never automatically added to the packet.
7. Answer, review and arbitration materials are each built once. Reviewers and the arbiter share the same anonymized AnswerCorpus; the ReviewCorpus is similarly frozen. Artifacts exceeding byte/token ceilings fail as participants, rather than being handed onward truncated. At least one valid answer and one valid review are required; arbiter failure is not substituted with a top-ranked answer.
8. Only a compact producer-owned ModelReturn is queued into the main chat: answer, decision deltas, consensus/disagreements, blind spots, confidence, reported sources, anonymous coverage and limitations. Full mappings, rankings, diagnostics and child public output remain in UI/audit details. A later ordinary follow-up admits the real question and ModelReturn; no extra parent summary request is sent.

## Records, permissions and compatibility

- UI progress and the original picker question retain their v1 source readers. New terminal sources are v2 with a strict ModelReturn and separate presentation metadata. Old logs are not rewritten, nor are old admitted full audits removed from parent history. Markdown headings never determine prose/audit boundaries.
- Packet and stage entities are stored through existing empty producer records and a pure host-only Projection. The legitimate log is authoritative; hashes are revalidated on reads. The cache is not a replacement source of truth.
- One real producer result is the canonical terminal, with its actual Inbox event sequence. Final UI follows the terminal commit, not the reverse. Cross-instance duplicate/late finishes reuse that terminal; a later cancellation cannot publish an opposite one. Unknown interrupted runs do not automatically restart.
- The parent pre-step filter removes only strictly validated empty UI, run-record and policy markers, retaining genuine question/result and ordinary messages and preserving request-series fields.
- Current pending Council question/success records may be captured once. Admitted/pending identities and logical records are deduplicated. Inbox clear/remove/replace is authoritative; reopening does not reinsert cleared pending input.
- Chat children deny global tools including Web, files, Shell and delegation. Only original reviewer/arbiter activations receive scoped `structured_output`; its execution permission and schema are not cold-restored. Historical structured submissions may be read and budgeted as history, not exposed as current tools.
- A parent run manifest and an independent child binding carry the hash of the complete v2 child policy. Removing the entire policy, or even both child markers, cannot make a parent-manifest-owned child silently become an unrestricted ordinary agent. Live parent reads use the Projection; offline reads use a disposable SessionQuery observation and the public projection registry fold.
- Child tool execution is quarantined synchronously before any asynchronous ownership/window lookup. Quarantine is lifted only after permanent policy installation; failed setup keeps it until factory rollback.
- v2 cold chat restoration requires the persisted approved route, window, estimator version, output ceiling and tool policy. The intersection with current restrictions cannot widen authorization. Missing/conflicting/unknown policies fail closed. Topic-only v2 records keep exact routing/output/tool ceilings without inventing an unknown context window; old v1 policy behavior is retained explicitly.
- The actual `llm/stream` guard reads real system/messages/tools/tool history before `next()`/adapter, without changing the frozen request. It is a heuristic TokenMeter/window check, not a provider-exact tokenizer or byte-level guarantee.
- Only a valid matching ANSWER presentation hides that run's raw command report. A question/progress row or source-event reference alone cannot swallow an error or unknown-version fallback.
- Expanding public process uses only Client retain/bind/subscription. `ready` can resolve while `binding.session.getSnapshot().openState` is `error`; the renderer observes that state and releases subscriptions/references on collapse. No expansion resumes an Agent or sends a model prompt.

## Deployment and acceptance boundary

Installation into a real profile, application restart and real-provider model calls require separate authorization. The source and npm publishing step does not perform them. Do not assume source changes update the current GUI, or promise client hot reload without the matching checkout's `dev:web` watcher.

The installed native question package passes ordinary `question.detail` unchanged to MarkdownText, and its README documents a shared internal scroll region for long details/options. This is source-level evidence, not a pixel-level test of a 64 KiB confirmation. Current Client Inspect queries timed out; component fixtures are not real device acceptance.

After authorized installation, use a non-sensitive test conversation and check:

- blank-session retention, mode choice, roster and separate source selection;
- the complete native preview, every export recipient, long text, narrow widths and both themes;
- chat-mode tool denial, three-stage progress, one visible final body and collapsed audit;
- two consecutive Councils while the prior result remains pending, then clear/remove without resurrection;
- “continue with the recommendation” in a normal parent turn, without a second audit transcript or summary request;
- cancellation, reload/reopen, preserved packet identity, no automatic whole-run restart;
- detail retain errors, collapse/reopen, released references and no extra model request.
