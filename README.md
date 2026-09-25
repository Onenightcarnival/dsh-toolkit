# dsh-toolkit

**English** | [中文](README.zh.md)

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): one repository, one version, one release.

| Package | What it adds | Where it appears |
|---|---|---|
| [`@onenightcarnival/dsh-rdb`](packages/rdb/README.md) | Relational database workbench: SQLite / PostgreSQL / MySQL / GaussDB, data grid, structure, SQL editor, `db_*` tools | Sidebar "Database" |
| [`@onenightcarnival/dsh-s3`](packages/s3/README.md) | S3-compatible object storage browser: MinIO / OSS / COS / R2, `s3_*` tools | Sidebar "S3" |
| [`@onenightcarnival/dsh-otel`](packages/otel/README.md) | OpenTelemetry GenAI export to Langfuse and other OTLP backends | Settings → Plugins → Observability |
| [`@onenightcarnival/dsh-bridge-browser`](packages/browser-bridge/README.md) | Browser bridge: `browser_*` tools driving the user's tabs through the Chrome / Firefox extension | Settings → General → Browser bridge address |
| [`@onenightcarnival/dsh-toolkit`](packages/toolkit) | All four in one package | As above |
| [`dsh-browser-extension`](extensions/dsh-browser/README.md) | Chrome / Firefox MV3 extension paired with the bridge | Browser side panel |

Built against dsh `0.1.5-rc.2`, the runtime bundled by [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop).

## Installation

Every [release](https://github.com/Onenightcarnival/dsh-toolkit/releases) carries:

| File | Purpose |
|---|---|
| `onenightcarnival-dsh-toolkit-<version>.tgz` | All four plugins in one install |
| `onenightcarnival-dsh-rdb-<version>.tgz` and the other three | One plugin on its own |
| `dsh-browser-extension-chrome-<version>.zip` | Chrome extension, loaded unpacked |
| `SHA256SUMS.txt` | Checksums |

Install either the toolkit or the single packages, not both.

**Desktop app**: Plugins → Config center… → Plugins → Install from .tgz, pick the file, restart when prompted.

**dsh CLI**:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<version>.tgz
dsh web
```

**Chrome extension**: unzip into a directory that stays put, open `chrome://extensions`, enable Developer mode, Load unpacked, pick the directory. The bridge address is discovered automatically; loopback needs no token. Firefox builds from source: [docs/browser.md](docs/browser.md).

### Toolkit module switches

The toolkit is one `toolkit` row in the web profile with one config key per module; `false` leaves the module out on both host and client. An override in `~/.dsh/profiles/web/cordis.patch.yml` replaces the whole `config`, so restate the keys you keep:

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

The keys take the standalone packages' config: `rdb` and `s3` per their READMEs, `browser` per the [bridge configuration](packages/browser-bridge/README.md#config).

### Migrating from the standalone packages

From 0.5.0 the packages carry the `@onenightcarnival/` scope; the old `dsh-rdb`, `dsh-s3` and `dsh-otel` do not upgrade in place: remove them in the plugin manager, then install the new ones. Connections, credentials and settings live under `~/.dsh`, independent of the package name, and survive the switch.

## Layout

```
packages/rdb              @onenightcarnival/dsh-rdb
packages/s3               @onenightcarnival/dsh-s3
packages/otel             @onenightcarnival/dsh-otel
packages/browser-bridge   @onenightcarnival/dsh-bridge-browser
packages/toolkit          @onenightcarnival/dsh-toolkit: the host half mounts the four modules and serves
                          /api/dsh-toolkit/modules, the client half mounts their surfaces from that map,
                          the typert manifest is regenerated under this package's name
extensions/dsh-browser    Chrome / Firefox extension (vite)
benchmark                 Playwright comparison benchmark for browser operation
docs/browser.md           Full browser-operation guide (desktop discovery beacon, troubleshooting, security model)
scripts/build-plugin.mjs  esbuild driver shared by the plugins: host bundle + module-loader-wrapped client bundle
scripts/version.mjs       One version into every package.json, both extension manifests and otel's PLUGIN_VERSION
scripts/package.mjs       Every release artifact into dist/
scripts/check-runtime.mjs Checks the dsh runtime locked at the root
scripts/smoke-runtime.mjs Boots a real web host in a temporary DSH home and exercises the bridge
```

## Development

Node.js `^22.19 || >=24`, pnpm 11. Every command runs at the repository root.

```sh
pnpm install
pnpm run build        # all packages, in dependency order
pnpm run typecheck
pnpm run test
pnpm run package      # dist/: five tarballs, the extension zip, SHA256SUMS.txt

pnpm --filter @onenightcarnival/dsh-rdb run build      # one package
pnpm --filter dsh-browser-extension run build:firefox
```

Each plugin's host bundle inlines its third-party dependencies (`@deepseek-ai/*` stay external, provided by the dsh runtime), so a tarball installs without reaching the npm registry. The toolkit bundles straight from the four packages' sources; the packages typecheck themselves and the toolkit has no typecheck of its own.

Install check: `DSH_HOME=<temp dir> dsh plugin --profile web add file:<tgz>` into a temporary profile, start `dsh web --no-open --port 0`, exchange the ready line's token URL for the cookie, then call `/api/dsh-toolkit/modules`, `/api/dsh-rdb/profiles`, `/api/dsh-s3/profiles`, `/ext/bridge-config`. A token exchanges once; pnpm reuses the store copy of a `file:` package with an unchanged version, so `plugin remove` before re-adding.

## Release

One version, written by `scripts/version.mjs` into every package, both extension manifests and otel's `PLUGIN_VERSION`:

```sh
node scripts/version.mjs set 0.5.1
git commit -am "v0.5.1" && git tag v0.5.1 && git push origin main v0.5.1
```

The pushed tag triggers `.github/workflows/release.yml`: a tag that differs from the committed version fails; otherwise install, typecheck, build, test, package, and attach everything in `dist/` to the GitHub Release of the same name. A prerelease suffix (`v0.5.1-rc.1`) marks the release as pre-release; browser manifests take the numeric part only.

## License

MIT. Bundled third-party code keeps its own license; see each package's `THIRD-PARTY-NOTICES`.
