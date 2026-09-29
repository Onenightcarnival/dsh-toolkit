# Subscription backend

Host backend for `@onenightcarnival/dsh-subscriptions`, compiled from local TypeScript.

## Components

| Path | Responsibility |
|---|---|
| `auth/` | OAuth PKCE, callback validation, token storage and refresh |
| `providers/` | Codex and Google Antigravity accounts, model catalogs, quota and request routing |
| `translate/` | Streaming protocol and model message translation |
| `tools/` | Web search and image generation tool registration |
| `provider-settings.ts` | Provider configuration |
| `model-defaults.ts` | Default model settings |

## Runtime contract

| Boundary | Behavior |
|---|---|
| Providers | `codex`, `antigravity` |
| Search | `codex_web_search`, `antigravity_web_search` |
| Images | `codex_image_generate`, `antigravity_image_generate` |
| OAuth callbacks | Provider redirect URIs, callback-port fallback and state-validated manual callbacks |
| Credentials | Host storage; browser status excludes tokens |

## Validation

Changes to authentication, model translation, search or images require subscription tests and host smoke tests. Commands and coverage: [package guide](../../README.md#development).

## Source and license

| Source | Revision | Scope |
|---|---|---|
| V1ki/dsh-plugin-subscriptions | `d8ab13e91fd6747e419a1f5e965bce42bdfc3ad8` | ChatGPT authentication, model transport, search, images and shared account configuration |
| LiZhenNet/dsh-antigravity | `94957767c5e247d86cec8833fb1b67f659078af6` | Antigravity protocol reference |

Upstream changes enter through reviewed source updates. MIT notices reside in [THIRD_PARTY_LICENSES.txt](../../THIRD_PARTY_LICENSES.txt) and ship with standalone and toolkit artifacts.
