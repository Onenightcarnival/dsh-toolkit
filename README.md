# dsh-toolkit

**English** | [中文](README.zh.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): databases, object storage, observability, browser control and AI subscriptions. All packages share a version and release workflow.

| Package | What it adds | Where it appears |
|---|---|---|
| [`@onenightcarnival/dsh-rdb`](packages/rdb/README.md) | Relational database workbench: SQLite / PostgreSQL / MySQL / GaussDB, data grid, structure, SQL editor, `db_*` tools | Sidebar "Database" |
| [`@onenightcarnival/dsh-s3`](packages/s3/README.md) | S3-compatible object storage browser: MinIO / OSS / COS / R2, `s3_*` tools | Sidebar "S3" |
| [`@onenightcarnival/dsh-otel`](packages/otel/README.md) | OpenTelemetry GenAI export to Langfuse and other OTLP backends | Settings → Plugins → Observability |
| [`@onenightcarnival/dsh-bridge-browser`](packages/browser-bridge/README.md) | Browser bridge: `browser_*` tools driving the user's tabs through the Chrome / Firefox extension | Settings → General → Browser bridge address |
| [`@onenightcarnival/dsh-subscriptions`](packages/subscriptions/README.md) | ChatGPT and Google Antigravity models, Codex search and image tools | Sidebar "AI subscriptions" |
| [`@onenightcarnival/dsh-toolkit`](packages/toolkit/README.md) | Integrated package with all five plugins | Each module's entry point |
| [`dsh-browser-extension`](extensions/dsh-browser/README.md) | Chrome / Firefox MV3 extension paired with the bridge | Browser side panel |

## Runtime compatibility

| Toolkit version | dsh runtime |
|---|---|
| 0.6.x | `0.1.7-rc.2` (workspace pin) |
| 0.5.x | `0.1.5-rc.2` |

Plugins and hosts use the same runtime line. A mismatch causes typert validation failures and prevents UI loading.

## Installation

Every [release](https://github.com/Onenightcarnival/dsh-toolkit/releases) carries:

| File | Purpose |
|---|---|
| `onenightcarnival-dsh-toolkit-<version>.tgz` | All five plugins in one install |
| `onenightcarnival-dsh-rdb-<version>.tgz` and the other four | One plugin on its own |
| `dsh-browser-extension-chrome-<version>.zip` | Chrome extension, loaded unpacked |
| `SHA256SUMS.txt` | Checksums |

Installation modes: the integrated toolkit or standalone plugins. The two modes are mutually exclusive.

**Desktop app**: Plugins → Config center… → Plugins → Install from .tgz, pick the file, restart when prompted.

**dsh CLI**:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<version>.tgz
dsh web
```

**Chrome extension**: extract to a permanent directory → `chrome://extensions` → Developer mode → Load unpacked. Local Chrome connections discover the bridge automatically and require no token entry. Firefox requires a source build and token configuration; see [browser control](docs/browser.md).

### Module configuration

The web profile uses plugin ID `toolkit`. Configuration resides in `~/.dsh/profiles/web/cordis.patch.yml`.

| Module value | Host and UI behavior |
|---|---|
| Omitted or `{}` | Enabled with default configuration |
| Configuration object | Enabled with the standalone plugin's configuration |
| `false` | Disabled |

An override replaces the entire `config` object; retained custom values must be included. This configuration disables observability, sets browser discovery to port `43189`, and uses defaults for the remaining modules:

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

The keys take the standalone packages' config: `rdb` and `s3` per their READMEs, `browser` per the [bridge configuration](packages/browser-bridge/README.md#config).

### Migrating from the standalone packages

Packages use the `@onenightcarnival/` scope from 0.5.0. Migration order: remove the old `dsh-rdb`, `dsh-s3` and `dsh-otel` packages → install their replacements. Connections, credentials and settings remain under `~/.dsh`.

## Layout

| Path | Responsibility |
|---|---|
| `packages/{rdb,s3,otel,browser-bridge,subscriptions}` | Five standalone plugins |
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
pnpm run package      # dist/: six tarballs, the extension zip, SHA256SUMS.txt

pnpm --filter @onenightcarnival/dsh-rdb run build      # one package
pnpm --filter dsh-browser-extension run build:firefox
```

### Build contract

| Item | Contract |
|---|---|
| Host dependencies | dsh provides `@deepseek-ai/*`; package build configurations select other dependencies for inlining |
| Subscription authentication | `@cortexkit/antigravity-auth-core` remains a runtime dependency of subscriptions and toolkit |
| Integrated package | Bundles the five packages' sources directly; typechecking covers the same sources |
| Runtime versions | Pinned through `pnpm-workspace.yaml` overrides |

### Installation validation

1. Set `DSH_HOME` to a temporary directory and run `dsh plugin --profile web add file:<tgz>`.
2. Start `dsh web --no-open --port 0` and exchange the ready log's token URL for a cookie. Each token permits one exchange.
3. Use the cookie to check `/api/dsh-toolkit/modules`, `/api/dsh-rdb/profiles`, `/api/dsh-s3/profiles` and `/ext/bridge-config`.

pnpm caches same-version `file:` packages in its store. Repeat validation requires `plugin remove` before reinstallation.

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

MIT. Third-party notices: [OTel](packages/otel/THIRD-PARTY-NOTICES), [Subscriptions](packages/subscriptions/THIRD_PARTY_LICENSES.txt), [Toolkit](packages/toolkit/THIRD_PARTY_LICENSES.txt).
