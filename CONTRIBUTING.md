# Contributing

[English README](README.md) · [中文说明](README.zh.md)

Use Node.js `^22.19.0 || >=24.11.0` and pnpm 11.7.0 for development (the build toolchain requires Node 24.11+ on the 24.x line). The prebuilt plugin's runtime engine remains `^22.19.0 || >=24.0.0`.

```sh
git clone https://github.com/a1exsun/dsh-council.git
cd dsh-council
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
pnpm test:host
```

To load your local checkout into DSH Web:

```sh
pnpm build
npx --yes @deepseek-ai/dsh@latest plugin --profile web add .
npx --yes @deepseek-ai/dsh@latest web
```

Rebuild after source changes and restart DSH Web to load them.

The host test downloads npm's current DSH release into a disposable environment. It uses fixture responses and needs no API credentials. Never include credentials or personal DSH profiles in tests.

For a bug fix, add a reproducing test. Keep English and Chinese copy in `src/locales.ts` and update both READMEs when behavior changes. Preserve anonymous payloads and the Web-only tool allowlist. Prefer the current DSH API over compatibility branches.

Pull requests should explain the user-visible problem, resulting behavior, and verification. Include the DSH version and tests run. Claims about model quality or live providers require a separately labelled live test.

## Reporting bugs

Include DSH, Node.js, and plugin versions; operating system; locale; reproduction steps; and redacted diagnostics. For failed model calls, include the stage and provider/model identifier. Do not include API keys, private prompts, or personal session archives. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

## Updating DSH

The development dependencies and lockfile record a tested SDK snapshot. `pnpm test:host` defaults to top-level `@deepseek-ai/dsh@latest`; set `DSH_TEST_VERSION=0.1.2-rc.1` or `DSH_TEST_VERSION=0.2.1-rc.5` for the pinned compatibility jobs. CI runs all three. The legacy job pins its release-time Cordis vendor tuple because the old CLI's floating vendor dependencies now have an upstream HMR activation incompatibility. `DSH_TEST_KEEP_TEMP=1` retains the disposable runtime lockfile and report for diagnosis; no live profile is used. Immutable public npm downloads may use the shared cache, while npm configuration and credentials remain isolated. Update SDK packages together to the host release and run all checks before committing the lockfile. Some DSH interface packages have a different `latest` tag from the host; resolve the host version first, then align its SDK family.

CI validates pull requests and pushes without publishing. See [release readiness](docs/release-readiness.md) before publishing.
