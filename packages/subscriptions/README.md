# @onenightcarnival/dsh-subscriptions

**English** | [中文](README.zh.md)

ChatGPT and Google Antigravity subscriptions for DeepSeek Harness. The **AI subscriptions** sidebar contains provider selection, accounts, model settings and usage, with the S3 / RDB layout, host theme and English / Chinese translations.

Install this package or the toolkit:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-0.6.0.tgz
```

Connect ChatGPT through browser OAuth. The callback tries local ports 1455 and 1457. If both are reserved or occupied, login automatically switches to manual callback mode: finish authorization, then copy the complete `localhost` URL from the browser address bar into the panel, even if that browser page cannot load. Credentials stay on the host. Add accounts, select the default, or disconnect them from the panel.

- **Models:** account-discovered models in the conversation picker; refresh, visibility controls, default reasoning effort and editable context windows. Enter `256K`, `1M`, `1.5M` or a positive integer (decimal units), then press Enter or Save. Clear and save or choose Reset to default to inherit the catalog value. Context settings are shared across accounts within each provider; explicitly advertised maximums still apply.
- **Web Search:** `codex_web_search` uses the ChatGPT subscription directly, with DSH search cards and source URLs. DSH's web search provider setting is independent.
- **Images:** `codex_image_generate` supports generation and attachment-based editing, local files and inline image previews/downloads. Files live under `plugins/subscriptions/images/` in the DSH home.
- **Usage:** per-account quota windows and reset times, refreshed on demand. Missing usage is shown as unknown.

| Tool | Input | Result |
| --- | --- | --- |
| `antigravity_web_search` | `query` | Google search summary and up to eight sources |
| `antigravity_image_generate` | `prompt`; optional `referenceImages`, `reasoningEffort` (`minimal` / `high`) | Local paths and image attachments |
| `codex_web_search` | `query` | Summary and up to eight sources |
| `codex_image_generate` | `prompt`; optional `referenceImages`, `size`, `quality` | Local paths and image attachments |

Antigravity search uses Gemini 3 Flash with Google Search grounding and requires source citations. The image tool uses Gemini 3.1 Flash Image; omitted reasoning effort inherits the model setting. Image references use DSH attachments; read workspace images with `read_image` first. Tool requests refresh once on 401 and permit endpoint fallback on 403/404. Network errors, rate limits and server failures do not automatically resend image requests.

Tool lists use the settings at conversation creation. Disabling search also blocks calls in existing conversations immediately. Persisted switches use the capability keys `web_search` and `image_generate`.

## Google Antigravity

Select **Antigravity · Google** in the sidebar, then **Connect Google Antigravity**. Google OAuth uses PKCE and `http://localhost:51121/oauth-callback`; occupied or blocked ports support the same manual callback flow. Account credentials remain on the host.

| Capability | Behavior |
| --- | --- |
| Models | Live Cloud Code Assist catalog; Gemini, Claude and GPT-OSS conversation and image models available to the account |
| Configuration | Visibility, reasoning effort and context windows per provider |
| Usage | Quota groups, short-term and weekly windows, reset times; per-model fallback |
| Image models | Gemini 3.1 Flash Image returns DSH image attachments for preview and continued editing; supports Minimal / High thinking (provider default: Minimal); requires the attachment service |
| Tools | Conversation models use DSH tools; image models produce text and images without function calls. Independent `antigravity_web_search` and `antigravity_image_generate` tools use the default Google account, with switches in the Antigravity Tools tab |

Model catalogs merge results from the default and fallback Google endpoints. Requests preserve the Antigravity client identity; an endpoint-specific 403 permits fallback. Available quota windows remain visible when model catalog or plan lookups fail.

Disable the legacy plugin before enabling this integration: both register the `antigravity` provider.

OAuth client configuration, in precedence order:

1. `antigravity.clientId` and optional `antigravity.clientSecret` in plugin configuration.
2. `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` environment variables (`NOAGY_` aliases supported).
3. `$DSH_HOME/plugins/subscriptions/antigravity-oauth-client.json`, with `clientId` and optional `clientSecret`.
4. Default client configuration from the pinned runtime dependency `@cortexkit/antigravity-auth-core@2.2.0`.

Login preserves the resolved client configuration locally for subsequent token refreshes. Plugin source and build artifacts retain the core package import; client constants reside in the dependency. Login does not download reference-project source.

Project selection uses `antigravity.projectId`, then account discovery. Missing discovery endpoints (404) or absent project fields use the reference plugin’s account-specific compatibility identifier. This identifier does not create a Google Cloud project or grant access. Configure `antigravity.projectId` if the service requires a provisioned project. Authentication, permission and quota errors remain failures.

Access depends on account entitlements and quota. Offline tests do not establish live account access.

The toolkit enables this module by default; `subscriptions: false` disables host and UI. Standalone plugin ID: `subscriptions`. Configuration: `enabled`, `codexClientVersion`, `streamIdleTimeoutMs`, `rateLimit`, `models` for Codex, and `antigravity.models` for Antigravity. Model entries accept `id`, `name`, `contextWindow`, and `inputModalities`. Antigravity also accepts `clientId`, `clientSecret`, `baseURL`, `userAgent`, `projectId` and `onboard` (off by default).

Auth and preferences use `plugins/subscriptions/` in the DSH home. The original subscription plugin shares the provider and authenticated RPC names; the two packages cannot be loaded together.

`src/backend` contains OAuth PKCE, token refresh, streaming model adapters, Codex search and image attachment handling. Providers: `codex`, `antigravity`. The backend builds from local source. Antigravity protocol reference: [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity/tree/94957767c5e247d86cec8833fb1b67f659078af6). Source provenance and MIT license notices reside in `THIRD_PARTY_LICENSES.txt`.

Third-party notices are included in both standalone and toolkit artifacts. Backend changes require rerunning the OAuth, RPC, model and tool-policy integration tests.

After building, run `pnpm --filter @onenightcarnival/dsh-subscriptions test` for RPC and panel regression tests, and `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` for the real web host in isolated DSH homes (standalone, toolkit enabled/disabled and authentication). No personal credentials or live model calls are used. `node packages/subscriptions/test/preview.mjs` serves a local UI fixture with sample data only.
