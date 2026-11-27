# @onenightcarnival/dsh-subscriptions

**English** | [中文](README.zh.md)

ChatGPT subscription models for DeepSeek Harness through [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source). Entry: **AI subscriptions** in the sidebar, with accounts, models and usage. The panel supports the host theme and English / Chinese.

## Installation

The standalone package and toolkit are mutually exclusive:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-<version>.tgz
```

## ChatGPT

1. Select **Continue with ChatGPT** in AI subscriptions and complete browser OAuth. Eligible Plus and Pro accounts can authorize this app to use their plan.
2. Select a model from the ChatGPT group in the conversation picker.

| Page | Features |
|---|---|
| Accounts | Add, sign in again, select default and disconnect |
| Models | Refresh account catalog, visibility, default reasoning effort and context windows |
| Usage | Plan usage guidance and the link to ChatGPT usage settings |

Model selections update immediately and save in order. Save status appears in the header; a failed save restores the saved preferences and offers Retry.

- Context accepts `256K`, `1M`, `1.5M` or a positive integer in decimal units.
- Enter or Save submits; blank or Reset to default restores the catalog value.
- Settings are shared across accounts and cannot exceed advertised limits.

Sign-in, requests and usage:

- OAuth uses PKCE, signed ID-token validation and an HTTP callback on `127.0.0.1`. Ports 1455, 1457 and an available ephemeral port are tried in order; manual mode requires the complete callback URL from the browser address bar, including when that page cannot load.
- Each host keeps a stable host ID. Each account registration keeps its issued client ID; **Sign in again** reuses it. Accounts with the same email remain separate registrations.
- Credentials stay on the host. Disconnect attempts remote session revocation, clears local tokens and retains the registration for later sign-in. A failed revocation is reported; access can also be removed in ChatGPT settings.
- The account's live model catalog comes from `GET https://api.openai.com/v1/models`. Requests use OAuth with `POST https://api.openai.com/v1/responses`, streaming enabled and response storage disabled.
- Conversations support local DSH function tools. Input modalities and reasoning efforts follow the model catalog. Hosted image generation, file search, Code Interpreter, native computer use and hosted MCP are unavailable on this route.
- ChatGPT app usage shares the plan's Codex / ChatGPT Work allowance. App limits do not provide additional quota. **Manage usage** opens [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage); this integration does not report an estimated remaining balance.

Access depends on account entitlements and quota. Offline tests do not establish live account access.

## Configuration

The toolkit enables this module by default; `subscriptions: false` disables host and UI:

```yaml
- id: toolkit
  config:
    subscriptions: false
```

Standalone plugin ID: `subscriptions`.

| Scope | Fields |
|---|---|
| General | `enabled`, `streamIdleTimeoutMs` |
| Model metadata overrides | `chatgpt.models`; live account availability remains authoritative |
| Model entry | `id`; optional `name`, `contextWindow`, `inputModalities` |

Auth and preferences use `plugins/subscriptions/` in the DSH home. The UI reads account status without tokens; RPC uses the DSH authenticated connection. The original subscription plugin shares the provider and authenticated RPC names; the two packages cannot be loaded together.

| File | Content | Entries of other providers |
|---|---|---|
| `auth.json` | Account credentials | Ignored; credential entries are absent from the next write |
| `models.json` | Account model catalogs | Ignored |
| `model-defaults.json` | Default reasoning effort per model | Ignored; absent from the next write |
| `provider-settings.json` | Visibility, context windows and account preferences | Ignored; absent from the next write |

## Source and license

`src/backend` contains OAuth PKCE, token refresh, the streaming model adapter and account routing. Provider: `chatgpt`. The backend builds from local source. Source provenance and MIT license notices reside in [SOURCE_NOTICES.txt](SOURCE_NOTICES.txt).

The build writes them, with the licenses of the bundled packages, into `THIRD_PARTY_LICENSES.txt` of the standalone and toolkit artifacts. Backend changes require rerunning the OAuth, RPC, model and store tests.

## Development

Commands run from the repository root after building:

| Command | Coverage |
|---|---|
| `pnpm --filter @onenightcarnival/dsh-subscriptions test` | OAuth, RPC, models, stores and panel interactions |
| `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` | Real host in isolated DSH homes; standalone, toolkit enabled/disabled and authentication |
| `node packages/subscriptions/test/preview.mjs` | Local UI preview with sample data |

Tests use isolated data without personal credentials or live model calls.
