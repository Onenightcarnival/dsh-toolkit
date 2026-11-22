# dsh-toolkit

**English** | [中文](README.zh.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): databases, object storage, HTTP APIs, observability, browser control, AI subscriptions and a configuration center. All packages share a version and release workflow.

| Package | What it adds | Where it appears |
|---|---|---|
| [`@onenightcarnival/dsh-rdb`](packages/rdb/README.md) | Relational database workbench: SQLite / PostgreSQL / MySQL / GaussDB, data grid, structure, SQL editor, `db_*` tools | Sidebar "Database" |
| [`@onenightcarnival/dsh-s3`](packages/s3/README.md) | S3-compatible object storage browser: MinIO / OSS / COS / R2, `s3_*` tools | Sidebar "S3" |
| [`@onenightcarnival/dsh-http`](packages/http/README.md) | HTTP API client: targets with host-side credentials, request builder, response viewer, shared history, `http_*` tools | Sidebar "HTTP" |
| [`@onenightcarnival/dsh-otel`](packages/otel/README.md) | OpenTelemetry GenAI export to Langfuse and other OTLP backends | Settings → Observability |
| [`@onenightcarnival/dsh-bridge-browser`](packages/browser-bridge/README.md) | Browser bridge: `browser_*` tools driving the user's tabs through the Chrome / Firefox extension | Settings → General → Browser bridge address |
| [`@onenightcarnival/dsh-subscriptions`](packages/subscriptions/README.md) | Codex, ChatGPT, Google Antigravity and Grok models, Codex search, Grok X search, image and video tools | Sidebar "AI subscriptions" |
| [`@onenightcarnival/dsh-config-center`](packages/config-center/README.md) | MCP and skill management, dedicated uv / Python environment, common settings of built-in plugins | Sidebar → MCP / Skills; Settings → Environment dependencies / Plugins → Common settings |
| [`@onenightcarnival/dsh-memory`](packages/memory/README.md) | Layered career records, lessons, human corrections, version history and `memory_*` tools | Sidebar "Memory" |
| [`@onenightcarnival/dsh-gateway`](packages/gateway/README.md) | Local API gateway: OpenAI Chat Completions / Responses and Anthropic Messages endpoints over the configured models, API keys, usage accounting | Sidebar "API gateway" |
| [`@onenightcarnival/dsh-toolkit`](packages/toolkit/README.md) | Integrated package with all nine plugins | Each module's entry point |
| [`dsh-browser-extension`](extensions/dsh-browser/README.md) | Chrome / Firefox MV3 extension paired with the bridge | Browser side panel |

## Runtime compatibility

| Toolkit version | dsh runtime |
|---|---|
| 0.9.8+ | `0.2.2-rc.5` (workspace pin) |
| 0.9.7 | `0.2.2-rc.4` |
| 0.9.6 | `0.2.2-rc.3` |
| 0.9.2 – 0.9.5 | `0.2.2-rc.2` |
| 0.9.0 – 0.9.1 | `0.2.2-rc.1` |
| 0.8.2 | `0.2.1-rc.5` |
| 0.8.1 | `0.2.1-rc.3` |
| 0.8.0 | `0.2.1-rc.2` |
| 0.7.x | `0.2.0-rc.2` |
| 0.6.x | `0.1.7-rc.2` |
| 0.5.x | `0.1.5-rc.2` |

Plugins and hosts use the same runtime line. A mismatch causes typert validation failures and prevents UI loading.

## Installation

Every [release](https://github.com/Onenightcarnival/dsh-toolkit/releases) carries:

| File | Purpose |
|---|---|
| `onenightcarnival-dsh-toolkit-<version>.tgz` | All nine plugins in one install |
| `onenightcarnival-dsh-rdb-<version>.tgz` and the other eight | One plugin on its own |
| `dsh-browser-extension-chrome-<version>.zip` | Chrome extension, loaded unpacked |
| `SHA256SUMS.txt` | Checksums |

Installation modes: the integrated toolkit or standalone plugins. The two modes are mutually exclusive.

The integrated toolkit is also published on npm as [`@onenightcarnival/dsh-toolkit`](https://www.npmjs.com/package/@onenightcarnival/dsh-toolkit), with the same versions as the releases; standalone plugins are distributed as release files only. Install the version that matches the dsh runtime: [runtime compatibility](#runtime-compatibility).

**Desktop app**: Plugins → Config center… → Plugins, install the npm package `@onenightcarnival/dsh-toolkit@<version>`, or Install from .tgz and pick the file; restart when prompted.

**dsh CLI**:

```sh
# npm
dsh plugin --profile web add @onenightcarnival/dsh-toolkit@<version>
# or the release file
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<version>.tgz
dsh web
```

**Chrome extension**: extract to a permanent directory → `chrome://extensions` → Developer mode → Load unpacked. Local Chrome connections discover the bridge automatically and require no token entry. Firefox requires a source build and token configuration; see [browser control](docs/browser.md).

### Module configuration

Module keys, defaults and override examples: [integrated package configuration](packages/toolkit/README.md#module-configuration).

### Migrating from the standalone packages

Packages use the `@onenightcarnival/` scope from 0.5.0. Migration order: remove the old `dsh-rdb`, `dsh-s3` and `dsh-otel` packages → install their replacements. Connections, credentials and settings remain under `~/.dsh`.

## Layout

| Path | Responsibility |
|---|---|
| `packages/{rdb,s3,http,otel,browser-bridge,subscriptions,config-center,memory,gateway}` | Nine standalone plugins |
| `packages/toolkit` | Module configuration, host and UI mounting, typert registration |
| `extensions/dsh-browser` | Chrome / Firefox MV3 extension |
| `benchmark` | Playwright comparison benchmark |
| `docs/browser.md` | Browser installation, capabilities, troubleshooting and security boundaries |
| `scripts/build-plugin.mjs` | Shared esbuild configuration for host and client bundles |
| `scripts/version.mjs` | Package, extension manifest and OTel version synchronization |
| `scripts/package.mjs` | Release artifacts and checksums |
| `scripts/check-runtime.mjs` | Runtime version validation |
| `scripts/smoke-runtime.mjs` | Real host validation in an isolated data directory |

## Development

Node.js `^22.19 || >=24`, pnpm 11. Every command runs at the repository root.

```sh
pnpm install
pnpm run build        # all packages, in dependency order
pnpm run typecheck
pnpm run test
pnpm run lint         # rule check, format rules included
pnpm run format       # rewrite to the format rules
pnpm run format:check # format check without rewriting
pnpm run package      # dist/: ten tarballs, the extension zip, SHA256SUMS.txt

pnpm --filter @onenightcarnival/dsh-rdb run build      # one package
pnpm --filter dsh-browser-extension run build:firefox
```

### Lint and format

The tool is oxlint; the rule set comes from [`.oxlintrc.json` of deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/.oxlintrc.json).

| Item | Contract |
|---|---|
| `.oxlintrc.format.json` | Format rules with an automatic fix: 2-space indent, no semicolons, single quotes, multiline trailing commas, arrow parameter parentheses, type member delimiters |
| `.oxlintrc.json` | Extends the format rules; TypeScript uses type-aware rules, JavaScript uses syntax rules; the rule groups whose comment starts with `Official … not enforced` list the official rules this repository leaves off |
| Scope | `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` under `packages`, `extensions`, `benchmark`, `scripts` |
| Ignored | `lib/`, `dist/`, `dist-firefox/`, `coverage/`, `node_modules/`, `*.config.ts` |
| Runtime | Type-aware rules in `lint` read each package's `tsconfig.json` and the installed dependencies; `format` and `format:check` run without type analysis |
| `lint:fix` | Applies the safe automatic fixes of every rule |
| `.git-blame-ignore-revs` | Format-only commits; `git blame --ignore-revs-file .git-blame-ignore-revs` skips them |

### Build contract

| Item | Contract |
|---|---|
| Host dependencies | dsh provides `@deepseek-ai/*`; package build configurations select other dependencies for inlining |
| Inlined client library | `@deepseek-ai/dsh-util-crypto` compiles into client bundles; each importing package lists it in devDependencies |
| Subscription authentication | `@cortexkit/antigravity-auth-core` is a runtime dependency of subscriptions and toolkit |
| Integrated package | Bundles the nine packages' sources directly; typechecking covers the same sources |
| Typecheck scope | Each package's `typecheck` covers its TypeScript sources and TypeScript tests; browser-bridge tests use `tests/tsconfig.json` |
| Indexed access | Each package's `tsconfig.json` enables `noUncheckedIndexedAccess`; index and index-signature reads include `undefined` |
| Runtime versions | Pinned through `pnpm-workspace.yaml` overrides |

### Installation validation

1. Set `DSH_HOME` to a temporary directory and run `dsh plugin --profile web add file:<tgz>`.
2. Start `dsh web --no-open --port 0` and exchange the ready log's token URL for a cookie. Each token permits one exchange.
3. Use the cookie to check `/api/dsh-toolkit/modules`, `/api/dsh-rdb/profiles`, `/api/dsh-s3/profiles`, `/api/dsh-http/targets`, `/api/dsh-config-center/mcp` and `/ext/bridge-config`.

Same-version `file:` packages install from the pnpm store cache; repeat validation requires `plugin remove` before reinstallation.

## Release

The release version comes from the `v<version>` tag:

```sh
git tag v<version>
git push origin v<version>
```

| Stage | Result |
|---|---|
| Install | Dependencies installed from the lockfile |
| Version synchronization | `scripts/version.mjs set` writes the tag version into packages, extension manifests and OTel `PLUGIN_VERSION` |
| Validation and build | Typecheck → build → test → package |
| Release | All files in `dist/` attached to the matching GitHub Release |

Workflow: [release.yml](.github/workflows/release.yml). Artifact versions follow the tag; `pnpm version:set <version>` synchronizes repository versions. Tags with prerelease suffixes create prereleases; browser manifests retain only the numeric version.

## License

MIT. `THIRD_PARTY_LICENSES.txt` in each artifact is generated by the build from the bundled modules and lists the licenses of the third-party packages it contains. Notices for source derived from other projects: [subscription backend](packages/subscriptions/SOURCE_NOTICES.txt), [browser bridge](packages/browser-bridge/SOURCE_NOTICES.txt), [browser extension](extensions/dsh-browser/SOURCE_NOTICES.txt); they are also written into `THIRD_PARTY_LICENSES.txt` of the matching artifacts.
