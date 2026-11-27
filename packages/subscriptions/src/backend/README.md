# Subscription backend

Host backend for `@onenightcarnival/dsh-subscriptions`, compiled from local TypeScript.

## Components

| Path | Responsibility |
|---|---|
| `auth/` | OAuth PKCE, callback validation, ChatGPT registration, token storage and refresh |
| `providers/` | ChatGPT accounts, model catalogs, account routing and failover |
| `translate/` | Streaming protocol and model message translation |
| `provider-settings.ts` | Provider configuration |
| `model-defaults.ts` | Default model settings |

## Runtime contract

| Boundary | Behavior |
|---|---|
| Providers | `chatgpt` |
| OAuth callbacks | Provider redirect URIs, callback-port fallback and state-validated manual callbacks |
| Credentials | Host storage; browser status excludes tokens |

## Validation

Changes to authentication, model translation or account routing require subscription tests and host smoke tests. Commands and coverage: [package guide](../../README.md#development).

## Source and license

| Source | Revision | Scope |
|---|---|---|
| V1ki/dsh-plugin-subscriptions | `d8ab13e91fd6747e419a1f5e965bce42bdfc3ad8` | Authentication flow, model transport and shared account configuration |

Upstream changes enter through reviewed source updates. MIT notices reside in [SOURCE_NOTICES.txt](../../SOURCE_NOTICES.txt); the build writes them into `THIRD_PARTY_LICENSES.txt` of the standalone and toolkit artifacts.
