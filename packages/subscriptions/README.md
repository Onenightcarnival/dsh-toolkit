# @onenightcarnival/dsh-subscriptions

**English** | [中文](README.zh.md)

Codex, ChatGPT and Google Antigravity subscriptions for DeepSeek Harness. Entry: **AI subscriptions** in the sidebar, with providers, accounts, models, tools and usage. The panel supports the host theme and English / Chinese.

## Installation

The standalone package and toolkit are mutually exclusive:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-<version>.tgz
```

## Codex

1. Select **Connect Codex** in AI subscriptions and complete browser OAuth.
2. Select a model from the Codex group in the conversation picker.

Callbacks try local ports 1455 and 1457. If both are unavailable, manual mode accepts the complete localhost callback URL from the browser address bar, including when that page cannot load. Credentials remain on the host.

| Page | Features |
|---|---|
| Accounts | Add, select default and disconnect |
| Models | Refresh account catalog, visibility, default reasoning effort and context windows |
| Tools | Codex Web Search and image generation switches |
| Usage | Selected account's quota windows, reset times and refresh; missing data is unknown |

Model selections and tool switches update immediately and save in order. Save status appears in the header; a failed save restores the saved preferences and offers Retry.

- Context accepts `256K`, `1M`, `1.5M` or a positive integer in decimal units.
- Enter or Save submits; blank or Reset to default restores the catalog value.
- Settings are shared across accounts of the same provider and cannot exceed advertised limits.

Codex Web Search is independent of DSH's web search provider setting. Images live under `plugins/subscriptions/images/` in the DSH home; the attachment service provides inline preview, download and continued editing.

## ChatGPT

Select **ChatGPT · OpenAI**, then **Continue with ChatGPT**. Eligible Plus and Pro accounts can authorize this app to use their plan through [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source).

- OAuth uses PKCE, signed ID-token validation and an HTTP callback on `127.0.0.1`. Ports 1455, 1457 and an available ephemeral port are tried in order; manual mode requires the complete callback URL.
- Each host keeps a stable host ID. Each account registration keeps its issued client ID; **Sign in again** reuses it. Accounts with the same email remain separate registrations.
- Credentials stay on the host. Disconnect attempts remote session revocation, clears local tokens and retains the registration for later sign-in. A failed revocation is reported; access can also be removed in ChatGPT settings.
- The account's live model catalog comes from `GET https://api.openai.com/v1/models`. Requests use OAuth with `POST https://api.openai.com/v1/responses`, streaming enabled and response storage disabled.
- Conversations support local DSH function tools. Input modalities and reasoning efforts follow the model catalog. Hosted image generation, file search, Code Interpreter, native computer use and hosted MCP are unavailable on this route.
- ChatGPT app usage shares the plan's Codex / ChatGPT Work allowance. App limits do not provide additional quota. **Manage usage** opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage); this integration does not report an estimated remaining balance.
- Codex and ChatGPT credentials, model settings and catalogs are stored separately. Existing Codex accounts and model IDs remain valid.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `antigravity_web_search` | `query` | Google search summary and up to eight sources |
| `antigravity_image_generate` | `prompt`; optional `referenceImages`, `reasoningEffort` (`minimal` / `high`) | Local paths and image attachments |
| `codex_web_search` | Native `web.run` commands; compatibility shorthand `query` | Page text, line/link/reference IDs, complete sources and structured results |
| `codex_image_generate` | `prompt`; optional `transparent_background`, `referenced_image_paths`, `num_last_images_to_include` | Local paths and image attachments |

- Antigravity search uses Gemini 3 Flash with Google Search grounding and requires source citations.
- The image tool uses Gemini 3.1 Flash Image; omitted reasoning effort inherits the model setting.
- Image references use DSH attachments; read workspace images with `read_image` first.
- Tool requests refresh once on 401 and permit endpoint fallback on 403/404.
- Network errors, rate limits and server failures do not automatically resend image requests.

Tool lists use the settings at conversation creation. Disabling search also blocks calls in existing conversations immediately. Persisted switches use the capability keys `web_search` and `image_generate`.

### Codex web

| Commands | Parameters |
| --- | --- |
| `search_query`, `image_query` | `q`; optional `domains`, `recency` |
| `open` | `ref_id`; optional `lineno` |
| `click` | `ref_id`, numbered link `id` |
| `find` | `ref_id`, `pattern` |
| `screenshot` | `ref_id`, zero-based `pageno` |
| `finance`, `weather`, `sports`, `time` | Native ticker, location, league and UTC-offset fields |
| `response_length` | `short`, `medium`, `long` |

- Commands accept arrays and can share one call.
- `search_query` accepts at most four queries; four require `medium` or `long`.
- `query` is a compatibility shorthand for one search and cannot accompany other commands.
- Reference IDs belong to one conversation and remain available to subsequent page operations.
- Sources have no eight-item cap.
- Structured `results` preserve upstream fields; encrypted transport state is excluded.
- External content is untrusted; citations use source URLs.

PDF screenshot requests reach the subscription endpoint. Image bytes and native desktop media widgets are not guaranteed by that endpoint; a page reference alone is not a screenshot image. Model and account availability remain provider-controlled.

### Codex images

| Setting | Contract |
| --- | --- |
| Model | `gpt-image-2` |
| Dimensions / quality | `auto` / `auto`; composition and dimensions in `prompt` |
| Background | `transparent_background: true` for transparency; default `false` |
| File references | `referenced_image_paths`: 1–5 absolute paths, read through the agent's scoped `read_image` permission pipeline |
| Conversation references | `num_last_images_to_include`: 1–5 most recent distinct images on the current conversation surface, in chronological order |
| Compatibility fields | `referenceImages`, `size`, `quality`; existing values remain accepted |

- Reference modes are mutually exclusive.
- Missing, denied or invalid edit references fail before the image request.
- Recent references require the session query and attachment services.
- Generated files retain the provider's bytes; inline attachments follow the host's image limits and model capabilities.
- Automatic dimensions do not establish a fixed 4K output guarantee.

Native contracts: [Codex search commands](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/search.rs), [Codex image tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs).

## Google Antigravity

Select **Antigravity · Google** in the sidebar, then **Connect Google Antigravity**. Google OAuth uses PKCE and `http://localhost:51121/oauth-callback`; occupied or blocked ports support the same manual callback flow. Account credentials remain on the host.

| Capability | Behavior |
| --- | --- |
| Models | Live Cloud Code Assist catalog; Gemini, Claude and GPT-OSS conversation and image models available to the account |
| Configuration | Visibility, reasoning effort and context windows per provider |
| Usage | Quota groups, short-term and weekly windows, reset times; per-model fallback |
| Image models | Gemini 3.1 Flash Image returns DSH image attachments for preview and continued editing; supports Minimal / High thinking (provider default: Minimal); requires the attachment service |
| Tools | Conversation models use DSH tools; image models produce text and images without function calls. Independent `antigravity_web_search` and `antigravity_image_generate` tools use the default Google account, with switches in the Antigravity Tools tab |

- Model catalogs merge results from the default and fallback Google endpoints.
- Requests preserve the Antigravity client identity; an endpoint-specific 403 permits fallback.
- Available quota windows remain visible when model catalog or plan lookups fail.

Disable the legacy plugin before enabling this integration: both register the `antigravity` provider.

OAuth client configuration, in precedence order:

1. `antigravity.clientId` and optional `antigravity.clientSecret` in plugin configuration.
2. `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` environment variables (`NOAGY_` aliases supported).
3. `$DSH_HOME/plugins/subscriptions/antigravity-oauth-client.json`, with `clientId` and optional `clientSecret`.
4. Default client configuration from the pinned runtime dependency `@cortexkit/antigravity-auth-core@2.2.0`.

Resolved OAuth client configuration is stored locally for subsequent token refreshes. The pinned runtime dependency provides client constants.

- Project selection uses `antigravity.projectId`, then account discovery.
- Missing discovery endpoints (404) or absent project fields use an account-specific compatibility identifier.
- This identifier does not create a Google Cloud project or grant access.
- Configure `antigravity.projectId` if the service requires a provisioned project.
- Authentication, permission and quota errors remain failures.

Access depends on account entitlements and quota. Offline tests do not establish live account access.

## Configuration

The toolkit enables this module by default; `subscriptions: false` disables host and UI. Standalone plugin ID: `subscriptions`.

| Scope | Fields |
|---|---|
| General | `enabled`, `codexClientVersion`, `streamIdleTimeoutMs`, `rateLimit` |
| Codex models | `models` |
| ChatGPT model metadata overrides | `chatgpt.models`; live account availability remains authoritative |
| Antigravity models | `antigravity.models` |
| Model entry | `id`; optional `name`, `contextWindow`, `inputModalities` |
| Antigravity connection | `clientId`, `clientSecret`, `baseURL`, `userAgent`, `projectId`, `onboard` (off by default), under `antigravity` |

Auth and preferences use `plugins/subscriptions/` in the DSH home. The original subscription plugin shares the provider and authenticated RPC names; the two packages cannot be loaded together.

## Source and license

`src/backend` contains OAuth PKCE, token refresh, streaming model adapters, Codex search and image attachment handling. Providers: `codex`, `chatgpt`, `antigravity`. The backend builds from local source. Antigravity protocol reference: [LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity/tree/94957767c5e247d86cec8833fb1b67f659078af6). Source provenance and MIT license notices reside in `THIRD_PARTY_LICENSES.txt`.

Third-party notices are included in both standalone and toolkit artifacts. Backend changes require rerunning the OAuth, RPC, model and tool-policy integration tests.

## Development

Commands run from the repository root after building:

| Command | Coverage |
|---|---|
| `pnpm --filter @onenightcarnival/dsh-subscriptions test` | OAuth, RPC, models, tool policy and panel interactions |
| `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` | Real host in isolated DSH homes; standalone, toolkit enabled/disabled and authentication |
| `node packages/subscriptions/test/preview.mjs` | Local UI preview with sample data |

Tests use isolated data without personal credentials or live model calls.
