<div align="center">

<p><strong>English</strong> · <a href="README.zh.md">简体中文</a></p>
<h1>DSH Council</h1>
<p><strong>Independent answers. Anonymous reviews. One reasoned decision.</strong></p>
<p>Multi-model deliberation inside <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>.</p>

<p>
<img src="https://img.shields.io/badge/DSH-plugin-6D5DFB?style=flat-square" alt="DSH plugin">
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square" alt="Strict TypeScript">
<img src="https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-339933?style=flat-square" alt="Node.js 22.19+ or 24+">
<img src="https://img.shields.io/badge/languages-English%20%2F%20中文-222222?style=flat-square" alt="English and Chinese">
</p>

<p><a href="#installation">Installation</a> · <a href="#how-it-works">How it works</a> · <a href="#configuration">Configuration</a> · <a href="#contributing">Contributing</a></p>

https://github.com/user-attachments/assets/e81dfa36-5d93-4efb-8c67-015a5e4d2179


</div>

---

## How it works

<table>
<tr>
<td width="33%" valign="top">
<h3>01 · Answer</h3>
<p>2–8 models respond independently in parallel.</p>
</td>
<td width="33%" valign="top">
<h3>02 · Review</h3>
<p>1–8 reviewers compare anonymous answers, identify gaps, and rank them.</p>
</td>
<td width="33%" valign="top">
<h3>03 · Decide</h3>
<p>One arbiter weighs the answers and reviews to produce a final recommendation.</p>
</td>
</tr>
<tr>
<td colspan="3">
<p><strong>Your models.</strong> Use configured DSH providers and credentials. Choose models separately for each role, with reuse across roles. English and Chinese follow DSH's language setting.</p>
<p><strong>Inspectable results.</strong> Confidence notes, consensus, disagreements, blind spots, model identities, and average rankings. Original answers and reviews remain in DSH's child sessions.</p>
</td>
</tr>
</table>

## Installation

### 1. Install DSH

Install [DeepSeek Harness (dsh)](https://www.deepseek.com/harness/) by following the official installation guide.

### 2. Install DSH Council

<table>
<tr>
<th>Node.js</th>
<th>pnpm</th>
<th>DeepSeek Harness</th>
</tr>
<tr>
<td><code>^22.19.0 || >=24.0.0</code></td>
<td><code>11.7.0</code></td>
<td>At least two configured, authenticated models</td>
</tr>
</table>

Install the prebuilt package from npm:

```sh
npx --yes @deepseek-ai/dsh@latest plugin --profile web add @greenhats/dsh-council@0.1.3
npx --yes @deepseek-ai/dsh@latest web
```

<blockquote><p>Restart DSH Web if it is already running.</p></blockquote>

No source checkout or compilation is required. See [Contributing](CONTRIBUTING.md) for development setup.

For Desktop DSH, install the bundle into the profile used by the desktop app; a separate CLI `web` profile is not necessarily shared. This release adapts both the legacy `start()` interface and Desktop DSH `0.2.1-rc.5`'s `startActivation()` interface. See [release readiness](docs/release-readiness.md) for qualification results.

Council requires fresh child context and explicit model/structured-output support. On the activation API it requires a managed local provider (the default `spawn`), reinstalls its persona and durable per-run tool policy before the first prompt and on cold continuation (no Web in chat-background mode; Web remains available in topic-only mode), and rejects presets that suppress the Council persona. Only reviewers and the arbiter receive `structured_output` during their original activation; shell, file, and delegation tools remain blocked.

### Chat integration in 0.1.3

Version 0.1.3 retains new sessions before model selection, records the real question, and renders a Council response in conversation order. Expand the execution panel to inspect participants' public reasoning/text; the final prose is separate from the collapsed audit. This uses the Desktop `0.2.1-rc.5` Client APIs; older clients retain a command-report fallback. The npm command above pins `0.1.3`; installing it does not restart the app or update other profiles automatically.

After adding this Client half, fully quit and reopen Desktop DSH: refreshing the page alone does not invalidate the Host's cached package manifest. See [chat integration and acceptance checks](docs/chat-integration.md).

### Context-integration MVP in 0.1.3

By default, choose **current chat background / topic only / cancel** before the roster picker. Chat mode takes a consistent cut of the exact live parent and current Inbox. Select original-text sources, then review the **complete public material and every receiving route** in the native confirmation. Reselecting invalidates earlier consent. Assistant proposals remain unverified; tool evidence is opt-in. Prior Council history contributes only a reliably separated compact result. No model summarizes your history.

- Chat mode denies Web, files, Shell and delegation. Attachments are reference-only/excluded names: no body reading or OCR.
- Oversized material fails explicitly or offers topic-only; nothing is silently truncated. Every model needs a trustworthy context window from metadata or a verified exact-key override. Unknown windows never dispatch chat requests. Older Hosts lacking capture capabilities offer explicit topic-only/cancel; missing authoritative Inbox may offer explicitly approved surface-only history.
- Only the compact ModelReturn enters the original chat: answer, decision changes, consensus/disagreements, necessary sources, anonymous coverage and limitations. Full mappings/rankings/raw process stay in audit details and separate children. No extra parent summarization request is made; the next ordinary follow-up admits the handoff.
- Only consented packets persist. Reopening does not restore cleared pending input. Records and restricted cold children remain observable, but an interrupted whole Council run is not automatically resumed. Editing original text cannot recall copies already sent to providers or child sessions.

Local engineering and isolated Host qualification are complete; npm publication does not install the bundle into your Desktop profile. Complete native-preview usability, real follow-up conversations, narrow layouts and themes still need authorized device acceptance. See the [implementation report](docs/context-integration-implementation-report.md).

## Usage

Enter this command in a DSH Web conversation:

```text
/council
```

<table>
<tr>
<td width="35%" valign="top">
<h3>Choose your panel</h3>
<p>Select answerers, reviewers, and an arbiter. Selections apply to one run.</p>
</td>
<td width="65%" valign="top">
<h3>Ask your question</h3>
<p>Each participant starts in a fresh independent session. First choose selected chat excerpts with a complete export preview, or use only the topic.</p>
</td>
</tr>
</table>

<details open>
<summary><strong>Example question</strong></summary>

> Compare PostgreSQL leasing with a managed message queue for three workers. Explain how each recovers when a worker crashes after an external side effect but before acknowledging the job. Recommend one design and state its assumptions.

</details>

<table>
<tr>
<td width="33%" valign="top">
<p><strong>Cost</strong></p>
<p>4–17 model participants per run. Each may make multiple requests; only topic-only mode permits Web tools.</p>
</td>
<td width="33%" valign="top">
<p><strong>Privacy</strong></p>
<p>Your topic, consented selected chat excerpts, and intermediate artifacts go to selected providers. No chat body is exported before consent. See <a href="SECURITY.md">Security</a>.</p>
</td>
<td width="33%" valign="top">
<p><strong>Accuracy</strong></p>
<p>Model agreement does not guarantee correctness. Review the evidence and confidence notes.</p>
</td>
</tr>
</table>

## Need more AI models?

<a href="https://app.codebestie.org/register?aff=RA3Z7CMJW2SS">
<img src="docs/assets/codebestie-banner.svg" width="100%" alt="CodeBestie — explore more model providers. Register with invitation code RA3Z7CMJW2SS.">
</a>

## Configuration

<details>
<summary><strong>Defaults and overrides</strong></summary>

The default offers chat-background selection; missing trusted windows or capture capability requires an explicit topic-only choice. To adjust limits, set `config` on the `dsh-council` entry in your DSH profile:

```yaml
- id: dsh-council
  config:
    answerMaxTokens: 16384
    reviewMaxTokens: 16384
    arbiterMaxTokens: 16384
    childTimeoutMs: 300000
    runTimeoutMs: 900000
    subagentProvider: spawn
    contextMode: chat              # topic-only skips all history capture
    contextCaptureAttempts: 3
    contextCaptureTimeoutMs: 5000
    contextPreparationTimeoutMs: 30000
    contextMaxSources: 64
    contextCandidateMaxBytes: 524288
    contextPacketMaxBytes: 65536
    contextMaxTokens: 4096
    contextAnswerArtifactTokens: 2048
    contextReviewArtifactTokens: 2048
    contextArbiterOutputTokens: 4096
    contextEnvelopeReserveTokens: 8192
    contextSafetyMarginTokens: 2048
    contextWindowOverrides: {}     # exact provider/model -> verified positive window
```

Token limits apply per model request. Timeouts are in milliseconds; `runTimeoutMs` must be at least `childTimeoutMs`.

Chat output caps are the smaller of the existing stage cap and artifact budget. UTF-8 bytes and heuristic token estimates are checked separately. Human waiting is excluded from preparation/deliberation deadlines; actual requests recheck system text, messages and tool schemas. TokenMeter is not a provider-exact tokenizer.

</details>

## Contributing

<p align="center"><a href="CONTRIBUTING.md"><strong>Development setup · Tests · Bug reports →</strong></a></p>

## Acknowledgements

<blockquote>
<p>Thanks to Andrej Karpathy for <a href="https://github.com/karpathy/llm-council"><strong>llm-council</strong></a>, which inspired this project.</p>
</blockquote>

<p><sub>Review dimensions also draw on <a href="https://openrouter.ai/docs/guides/features/plugins/fusion">OpenRouter Fusion</a>.</sub></p>
