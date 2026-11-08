# API gateway

[中文](README.zh.md)

`@onenightcarnival/dsh-gateway` serves the model routes configured in DeepSeek Harness over the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages protocols, on a listener of its own with API keys and per-request usage accounting. The panel opens from the sidebar row **API gateway**.

## Endpoints

The gateway listens on `127.0.0.1:23340` by default. Every request carries a key in `Authorization: Bearer <key>` or `x-api-key: <key>`.

| Endpoint | Protocol | Streaming |
|---|---|---|
| `GET /v1/models` | OpenAI list; Anthropic shape when the request carries `anthropic-version` or `x-api-key` | — |
| `POST /v1/chat/completions` | OpenAI Chat Completions | `stream: true`, `stream_options.include_usage` |
| `POST /v1/responses` | OpenAI Responses | `stream: true`, semantic events with `sequence_number` |
| `POST /v1/messages` | Anthropic Messages | `stream: true`, `message_start` … `message_stop` |

Every request is translated into one host model request and the host's stream is translated back. Cross-origin browser clients are accepted (`Access-Control-Allow-Origin: *`); the key remains the only credential.

### Models

A gateway model id is `provider:model`, built from the host's registered provider routes and their model lists; `GET /v1/models` lists the ids the presented key may use. Request model names resolve in this order:

1. An alias from the settings page.
2. A `provider:model` id of a registered provider.
3. The default model: the one chosen on the settings page, else the host's default model selection.

A request that names an unknown model therefore runs on the default model; the response reports the id actually used. No default model and no match → `404 model_not_found`.

### Supported parameters

| Protocol | Accepted | Ignored | Rejected with `400` |
|---|---|---|---|
| Chat Completions | `messages` (system / developer / user / assistant / tool), text and `image_url` parts, `tools` of type `function`, `tool_choice: none`, `temperature`, `max_tokens` / `max_completion_tokens`, `stop`, `reasoning_effort`, `stream`, `stream_options.include_usage` | `user`, `metadata`, `store`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, other `tool_choice` values, `reasoning_content` of earlier turns | `n` other than 1, `logprobs`, `top_logprobs`, `response_format` other than `text`, tools of other types, roles other than the five above |
| Responses | `input` string or items (`message`, `function_call`, `function_call_output`; `reasoning` items are dropped), `instructions`, `tools` of type `function`, `tool_choice: none`, `temperature`, `max_output_tokens`, `reasoning.effort`, `stream` | `store`, `metadata`, `truncation`, `parallel_tool_calls`, `include` | `previous_response_id`, built-in tools (`web_search`, `file_search`, `code_interpreter`, …), `text.format` other than `text`, `item_reference` |
| Messages | `system` string or text blocks, `messages` with `text`, `image`, `tool_use`, `tool_result` blocks, `tools` (`custom` / untyped), `tool_choice.type: none`, `temperature`, `max_tokens`, `stop_sequences`, `stream` | `anthropic-version`, `anthropic-beta`, `metadata`, `top_p`, `top_k`, `thinking`, other `tool_choice` values | server tools (`web_search_20250305`, …), documents and other block types |

`thinking` and `redacted_thinking` blocks of earlier turns are dropped from the history; reasoning the model produces now streams as `reasoning_content` (Chat Completions), `reasoning` summary items (Responses) or `thinking` blocks (Messages). Images arrive as `data:` URLs or `http(s)` URLs (PNG, JPEG, WebP, GIF, 20 MiB each) and are stored through the host attachment store; a host without one rejects image inputs.

### Errors

| Case | Status |
|---|---|
| Missing or invalid key | `401` |
| Key not allowed to use the resolved model | `403` |
| Malformed or unsupported request | `400` |
| No model resolves | `404` |
| Body over the limit (32 MiB) | `413` |
| Upstream provider failure | the provider's status when it is 4xx or 5xx, else `502` |

Error bodies follow the protocol of the endpoint: `{ "error": { "message", "type", "code", "param" } }` for the OpenAI endpoints, `{ "type": "error", "error": { "type", "message" } }` for Messages. A failure after a stream started arrives as an error frame on the stream (`data: {"error":…}`, `response.failed` + `error`, or an `error` event) and the connection closes. A client disconnect cancels the host request.

## API keys

Keys are stored in full in `$DSH_HOME/gateway/keys.json` (mode 0600). The first key named `default` is generated on the first start. Each key has a name, an on/off state and an optional list of allowed model ids; the settings page creates, reveals, copies, disables and deletes keys.

## Usage

Every authenticated request on the three protocol endpoints writes one row to `$DSH_HOME/gateway/usage.sqlite` (Node's built-in `node:sqlite`): time, key, protocol, model, streaming flag, input / output / cache / reasoning tokens from the host's `usage` chunk, time to first content byte, duration, status and error code. Rows older than 400 days are deleted on insert.

The usage tab filters the rows of today, the last 7 days or the last 30 days by key, model, protocol and outcome, shows the totals of the filtered rows and lists the newest 200 of them. Cost is computed only for models with a price in `pricing` (price per one million input and output tokens, in the deployment's own currency); without any priced row no cost is shown.

## Panel

The sidebar row **API gateway** opens a center panel with three tabs; the last tab is remembered per browser.

| Tab | Content |
|---|---|
| Overview | Listener state, enable switch, address and port; endpoint list; model, key and default-model counters |
| API keys | Key table with reveal, copy, enable / disable and delete; the model allowlist of a key is picked in a provider → model tree dialog, also for new keys |
| Usage | Filters (range, key, model, protocol, outcome), metric cards of the filtered rows, then a wide table of the newest 200 matching requests |

## Settings

| Setting | Stored as | Default |
|---|---|---|
| Enable gateway | `enabled` | `true` |
| Address | `host` | `127.0.0.1` |
| Port | `port` | `23340` |
| Default model | `defaultModel` | `null` (host default model) |
| Aliases | `aliases` | `{}` |
| Prices | `pricing` | `{}` |

The panel edits the listener fields; `defaultModel`, `aliases` and `pricing` are edited in the settings file or the plugin configuration. Cost columns appear in the usage tab once a price produces a value.

Settings are stored in `$DSH_HOME/gateway/settings.json`; saving restarts the listener. A non-loopback address is reachable from the network the host is on; every request still needs a key.

Plugin configuration supplies the initial values before the settings file exists:

| Key | Meaning | Default |
|---|---|---|
| `enabled` | `false` keeps the host out of the composition | `true` |
| `listen` | initial listener state | `true` |
| `host`, `port` | initial listener address | `127.0.0.1`, `23340` |
| `dataDir` | directory of `settings.json`, `keys.json`, `usage.sqlite` | `$DSH_HOME/gateway` |
| `maxBodyBytes` | request body limit | `33554432` |

Standalone plugin ID: `gateway`. Toolkit module key: `gateway`; `false` disables host and UI. Standalone and integrated installations are mutually exclusive.

## Management API

Loopback-only, behind the host browser session, on the host web port.

| Request | Response |
|---|---|
| `GET /api/dsh-gateway/status` | settings, listener state, model list, key list, host default model |
| `PUT /api/dsh-gateway/settings` | saves the complete settings object, restarts the listener, returns the status |
| `GET /api/dsh-gateway/keys`, `?id=` | key list; one key in full |
| `POST /api/dsh-gateway/keys` `{ name, models }` | the new key in full, once in the response and always through `?id=` |
| `PATCH /api/dsh-gateway/keys` `{ id, name?, enabled?, models? }` | updated record |
| `DELETE /api/dsh-gateway/keys?id=` | remaining keys |
| `GET /api/dsh-gateway/usage?range=today\|7d\|30d&key=&model=&protocol=&outcome=ok\|error` | facets of the range, totals and groups of the filtered rows, newest 200 filtered rows |

## Development

```sh
pnpm --filter @onenightcarnival/dsh-gateway run build
pnpm --filter @onenightcarnival/dsh-gateway run typecheck
pnpm --filter @onenightcarnival/dsh-gateway run test        # protocol translation, stores, HTTP server
pnpm --filter @onenightcarnival/dsh-gateway run test:smoke  # real host with an echo model route
```

| Path | Responsibility |
|---|---|
| `src/index.ts` | Host entry: stores, listener lifecycle, management routes |
| `src/server.ts` | `/v1` listener: authentication, dispatch, streaming relay, ledger entry |
| `src/translate/common.ts` | Protocol-independent request model and host message materialization |
| `src/translate/openai-chat.ts`, `openai-responses.ts`, `anthropic.ts` | Request parsing, stream encoders and complete objects per protocol |
| `src/models.ts` | `provider:model` catalog, aliases, default fallback |
| `src/keys.ts`, `src/settings.ts`, `src/usage.ts` | Key file, settings file, SQLite ledger |
| `src/images.ts` | Image inputs → host attachments |
| `src/client/` | Settings section |
