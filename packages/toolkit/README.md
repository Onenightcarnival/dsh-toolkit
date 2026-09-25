# @onenightcarnival/dsh-toolkit

**English** | [中文](README.zh.md)

One package carrying the four [dsh-toolkit](https://github.com/Onenightcarnival/dsh-toolkit) plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): `dsh-rdb` (databases), `dsh-s3` (object storage), `dsh-otel` (OpenTelemetry export) and `dsh-bridge-browser` (browser bridge). Same panels, tools, settings, data files and API paths as the standalone packages; install either this package or the standalone ones.

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<version>.tgz
```

Desktop app: Plugins → Config center… → Plugins → Install from .tgz.

## Modules

The web profile gets one `toolkit` row. Its config has one key per module, taking that module's standalone config; `false` leaves the module out on host and client alike. An override in `~/.dsh/profiles/web/cordis.patch.yml` replaces the whole `config`:

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

`GET /api/dsh-toolkit/modules` returns the mounted set, e.g. `{"rdb":true,"s3":true,"otel":false,"browser":true}`; the client half mounts the surfaces listed there.

## Layout

```
src/index.ts     host half: mounts the module plugins as children, serves /api/dsh-toolkit/modules
src/client.ts    client half: mounts each module's client plugin per the module map
src/typert.ts    otel's typert manifest regenerated under this package's name
src/modules.ts   module names and the API path, shared by both halves
build.mjs        bundles straight from ../rdb, ../s3, ../otel and ../browser-bridge sources
```

MIT
