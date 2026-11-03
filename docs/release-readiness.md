# Release readiness

This record preserves the historical 0.1.2 fork preparation and upstream release qualifications, and distinguishes deterministic regression checks from model-quality evaluation. The user subsequently reported publishing 0.1.2. The current 0.1.3 context-integration qualification is recorded below; see [chat integration and its verification boundary](chat-integration.md).

## Release 0.1.3 — consented chat context integration

Target: [@greenhats/dsh-council@0.1.3](https://www.npmjs.com/package/@greenhats/dsh-council/v/0.1.3), from the authorized [Green-hats fork](https://github.com/Green-hats/dsh-council). The original upstream remains separate. GitHub/npm publication is authorized; active-profile installation, app restart and real-provider calls are not part of it.

- Consent-gated deterministic chat excerpts, exact live Session/Inbox fencing, bounded canonical packets and per-stage anonymous material identities.
- Actual-request window/output/tool/route guards; independent parent/child policy binding; synchronous authorization quarantine; fail-closed cold restoration and cancellable retention.
- Compact ModelReturn enters the original chat; full audits stay separate. Strict v1/v2 Client readers, conservative command fallback, and observable/released detail bindings.
- Local checks: 446 tests in 16 files; typecheck, documentation links and build passed. Coverage thresholds remain unchanged: 93.88% lines, 90.74% statements, 95.77% functions and 87.50% branches. Peer dependency validation passed.
- macOS arm64 isolated fake-adapter Hosts: `0.1.2-rc.1` legacy has 8 calls/8 guards/2 persisted reloads; `0.2.1-rc.5` activation has the original 8 calls/10 guards/2 reloads/2 continuations plus three chat runs (12 calls, 16 guards), a valid cold continuation, three pre-adapter denials (route/output/huge system), and an ordinary parent follow-up without a repeated full audit.
- Local qualification covers the two explicit Host versions above. The fork upload retains its existing workflow because the current GitHub CLI OAuth credential does not grant workflow-edit scope; its existing Node 22/24 check/coverage/peers remain unchanged and its Host job uses the runner’s exact default `0.2.1-rc.5`. The expanded two-version workflow remains in the local development history pending that authorization. Local checks do not claim a hosted run has passed.
- Runtime `@deepseek-ai/dsh-session` is now an explicit peer because the built entry imports `SessionLogOffset`; the pinned development SDK has not been upgraded.
- The npm allowlist excludes tests, scripts, local design material, artifacts, credentials and coverage. Report source links point to the release tag instead of omitted test files.
- Native complete-preview usability, narrow layouts/themes, real model quality/cost and real profile acceptance remain unverified. See the [implementation report](context-integration-implementation-report.md).

Publication must use the reviewed `0.1.3` tarball, public access, and the npm registry's `latest` tag. Verify the GitHub commit/tag and downloaded registry SHA-512 after publication. No force-push or reuse of an occupied npm version is allowed.

## Fork candidate 0.1.2 — Desktop spawn compatibility

Prepared on 2026-11-03 for `@greenhats/dsh-council`. Registry version `0.1.1` already exists, so this fix uses the next patch version. No npm publication, Git commit/tag/push, or installation into the user's active desktop profile is part of this preparation. Repository/homepage links still identify the upstream project; confirm the intended fork support destination before publishing.

### Changes and safety invariants

- Detect the actual Service seam: legacy `start(name, request)` or managed `startActivation({ provider, label, request, signal, delivery: 'caller' })`. Preserve the selected provider/model/token limit and structured schema; normalize `childId` and bind disposal to the exact activation receipt.
- Fail closed unless the provider explicitly uses fresh context and supports model selection and structured output. Activation providers must expose managed local preparation; context-inheriting/fork and external activation providers are rejected.
- Install literal personas, intersecting Web-only restrictions, native presentation, a monotonic execution guard, and prompt-tool filtering in the pre-prompt creation window. Scoped tools cannot bypass the guard. A child preset suppressing the Council persona fails creation instead of silently changing its role.
- Keep the same Web-only policy and persona on cold continuation. Store a versioned, exact child/parent-bound policy in host-authored empty-message metadata using existing inbox events; derive it through a host-only Session projection, not new event types or prompt-text matching. Reject malformed/conflicting policy. A cold continuation does not revive the original structured-output schema.
- Retain ownership through late startup and delayed disposal even after caller cancellation/deadlines. Plugin unload joins those operations before removing initial-child guards. Cold-restored children are individually cancelled and joined, with exact managed-child drainage when available; their guards deliberately remain child-owned until the scope actually closes, so an absent/no-op drain or a creation/publication race cannot widen permissions.
- Veto marker-only blank-session retention with `reject`, so outer time/skill prompt injectors cannot turn it into a parent model request. Preserve ordinary user messages batched with the marker.

### Local qualification

- Node.js `24.21.0`, pnpm `11.7.0` on macOS.
- `pnpm check`: passed; 116 tests. `pnpm test:coverage`: 98.72% lines, 92.50% branches; thresholds remain enforced.
- `pnpm peers check`: passed. SDK peer/Host engine ranges explicitly admit the tested Desktop prerelease and exclude the next incompatible release family.
- Packed host matrix: DSH `0.1.2-rc.1` legacy and `0.2.1-rc.5` activation passed; npm `latest` also resolved to `0.2.1-rc.5` and passed in a fresh runtime installation. Each target runs two councils/eight child model requests and two persisted-result reloads. Activation adds two cold continuations and ten denied tool probes; legacy checks eight denied probes. Pinned reruns may reuse version-checked disposable runtime modules, but every run installs the candidate into a fresh DSH home. Hosted CI and Node 22 qualification have not been run locally.
- Tests use deterministic LLM adapters, not paid live model calls. They check exact cross-provider routes (distinct from the parent route), isolated history, role text, structured submission, blocked child-local tools, child cleanup, bilingual output, persisted results, and activation cold continuation.
- Legacy `0.1.2-rc.1` is tested with its release-time Cordis vendor tuple pinned in the smoke script. Its original floating `^` dependencies now select a newer Loader with incompatible HMR activation timing; that mixed upstream combination is not qualified. The default `latest` job remains a separate compatibility canary.
- The smoke test uses a disposable home, does not inherit the active DSH profile/provider credentials, and disables downloaded dependency lifecycle scripts. `DSH_TEST_KEEP_TEMP=1` retains the isolated host lock/profile/report for diagnosis; `DSH_TEST_NODE_MODULES` can reuse an explicitly version-checked test runtime, fresh installation remains the default and was used for the latest-host qualification. The public download cache is shared without inheriting user npm configuration or credentials.

### Remaining human release actions

- [ ] Review and commit the full source tree, including new adapter/policy modules and regression tests.
- [ ] Confirm fork repository/support links and npm publishing access; enable private vulnerability reporting if appropriate.
- [ ] Run hosted CI on Node 22/24 and the declared DSH matrix; review its results.
- [ ] Publish the verified `0.1.2` tarball, then verify anonymous download integrity and install it in the intended desktop profile.

## Historical npm release 0.1.0

Published [@a1exsun/dsh-council@0.1.0](https://www.npmjs.com/package/@a1exsun/dsh-council/v/0.1.0) publicly under MIT on 2026-09-08. The package is 43.3 kB compressed and includes prebuilt code, declarations, plugin configuration, the license, and documentation.

Release source: `5b6b87d0df0ab580b67ca1e00a48fa3a5e722e73`; [all CI jobs passed](https://github.com/a1exsun/dsh-council/actions/runs/34197364500). After publication, an anonymous registry download matched the uploaded tarball's SHA-512 integrity. A fresh DSH `0.1.2-rc.1` profile installed the package by its npm name and exact version, activated its bundle, and passed both Council runs and the persistence checks described below.

## Historical review findings addressed (0.1.0)

| Area | Finding | Resolution |
| :--- | :--- | :--- |
| Cancellation | A valid arbiter result could win a simultaneous cancellation. | Check cancellation at the final boundary and before reporting success. |
| Catalog discovery | One stalled provider could block the picker and plugin unload. | Bound each catalog read independently; retain healthy catalogs. |
| Child execution | A result promise could stall cleanup if it ignored abort. | Abort waiting, pass cancellation to the child, dispose published handles. |
| Timer lifetime | Native timeout signals lived beyond successful operations. | Clear the deadline timer when its operation settles. |
| New sessions | The retention hook discarded every message in the batch. | Remove only the plugin's own marker. |
| Concurrent user input | Council could rename a session the user had since activated. | Recheck blank state immediately before retention. |
| Error reporting | Projection errors escaped command handling; retention errors could lose a final answer. | Localize projection failures and preserve a completed answer with a retention warning. |
| Validation | Duplicate selection IDs and blank evidence fields were accepted. | Reject malformed selections and whitespace-only evidence. |
| Diagnostics | Empty answers and stopped reviewers were reported misleadingly. | Distinguish empty text, invalid structures, stop reasons, and deadlines. |
| Configuration | Oversized timers could overflow into near-immediate timeouts. | Validate positive integers and the platform timer range at startup. |
| Packaging | Runtime and declaration imports lacked host peer declarations. | Declare Cordis, DSH LLM, and DSH tools peers; test a packed installation. |
| Real host prompts | Prompt/skill injection could turn a marker-only retention turn into a model request. | Short-circuit marker-only turns before synthetic prompt assembly. |
| Real host tools | Child-local delegation tools survived DSH's inherited-tool filter. | Install a child-specific execution guard and native prompt-tool filter during creation. |
| Provider semantics | A context-inheriting provider could defeat independent answers. | Reject providers that inherit parent history or cannot select model routes. |

## Historical verification (0.1.0)

- Unit and adapter tests: `pnpm test:coverage`; thresholds are enforced in `vitest.config.ts`.
- Type checking and production build: `pnpm check`.
- Local coverage after the review: 62 tests; 98.1% lines, 90.58% branches. Coverage thresholds are lower bounds, not claims that untested behavior is correct.
- Peer dependency validation: `pnpm peers check`.
- Packed integration: `pnpm test:host` installs the scoped tarball through `dsh plugin --profile web add` in a disposable home and checks automatic bundle activation. The runtime checks cover two complete councils, eight child model requests, eight denied out-of-scope tool probes, and two cold session reloads: a blank English session, an existing Chinese conversation, structured submission, parent-history isolation, and model-free retention. The README configuration example is applied in the actual host.
- Provider responses in the host test are deterministic fixtures. This does not certify live API availability, benchmark performance, model quality, or adherence to the advisory Web-call budget.
- GitHub Actions checks Node.js 22 and 24 and includes a separate latest-DSH integration job. CI runs on pushes and pull requests; local checks do not imply a hosted CI run has passed.

## Historical initial-release checklist (0.1.0)

- [x] Choose the MIT license and add `LICENSE` plus package metadata.
- [x] Confirm the GitHub owner/repository and add repository, homepage, and issue links.
- [x] Upload the demo video; replace the `DEMO VIDEO` placeholder in both READMEs.
- [ ] Enable private vulnerability reporting on GitHub.
- [x] Review the tarball contents and run the complete verification commands above.
- [x] Push the reviewed commits, allow CI to finish, then publish the initial npm release.

## Publish to npm

The original 0.1.0 release above belongs to `@a1exsun/dsh-council`. The current release targets `@greenhats/dsh-council@0.1.3`; it does not update the original package. Authenticate as `greenhats` or an account explicitly granted publishing access to this package. After the checks above pass for the release:

```sh
npm login --registry=https://registry.npmjs.org/
npm publish ./greenhats-dsh-council-0.1.3.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

The `prepack` script builds `lib/` before packing or publishing. Registry installations use that prebuilt output and do not run a plugin build. `publishConfig` selects the public npm registry and public visibility. CI validates changes without publishing automatically.

SDK dependencies record a tested snapshot. The host integration test defaults to `0.2.1-rc.5` and accepts only an exact `DSH_TEST_VERSION` for pinned matrix runs. Desktop/Web profiles must provide the session-list metadata projection used for new-session retention; a bare headless profile does not. Publish the exact reviewed tarball after hosted CI and repository/support ownership are confirmed; do not treat historical checkboxes above as completion of the fork release.
