# dsh-http

**English** | [中文](README.zh.md)

HTTP API client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Entry: **HTTP** in the web sidebar.

## Capabilities

| Surface | Behavior |
|---|---|
| Targets | Base URL, authentication (bearer / basic / header / query), fixed headers, `{{variables}}`, secret variables, extra allowed hosts, mutation switch, private-network switch, timeout |
| Sidebar | Scope selector: **No target** or one of the targets, with **New target…** as its last entry, plus edit and connection test of the selected target. Below it two tabs for the scope. **Requests**: saved request forms with a filter; **+** adds a blank request and puts the caret in its URL bar; rename (double-click or menu), duplicate, **Copy as cURL**, delete. **History**: every exchange, newest first; selecting one shows it, and an entry can be saved as a request |
| Request pane | The form of the selected saved request, edited in place and saved automatically: method, a full URL (no target) or a path below the base URL, and Send. Pasting a cURL command into the URL bar fills the whole form. Tabs: Params (URL preview, **Import parameters from URL**), Body (JSON / text / form; JSON syntax highlighting; Tab indents), Headers (plus the target's fixed headers, read-only), Auth, Capture |
| Name/value tables | Params, Headers and form fields: a blank row follows the last one; **Add**, **Bulk edit** (one `name: value` per line, `#` switches a line off) and **Delete all**; a checkbox per row; repeated names are kept |
| Auth tab | A target with authentication: shown read-only. A target without, or no target: the request's own authentication — bearer, basic, custom header or query parameter |
| Capture tab | The request's [capture rules](#captured-variables), one card each: variable, value source and path, lifetime, [auto refresh](#auto-refresh); **Add rule** appends one. Below them the captured variables of the scope: name, masked hint, expiry, **Clear**, source request and capture time |
| Response pane | The latest response of the selected request, with a picker for its earlier responses, or an exchange picked from the history. Status, duration and size; tabs Preview (pretty / raw JSON; syntax highlighting for JSON, HTML, XML, JavaScript, CSS and YAML; capture and refresh results; images shown; HTML as source or rendered in a sandbox without scripts; event streams as they arrive; **Copy**; **Download**), Headers, Request (URL, headers and body as sent, secrets masked). A request in flight shows its elapsed time and a cancel button |
| History | Every exchange of the panel and the agent, per target, the refresh requests sent by the host included (tagged **refresh**); requests sent by the agent appear within a few seconds; delete one entry or clear the target |
| Import / export | **Export** and **Import** in the title bar: see [Import and export](#import-and-export) |
| Agent | `http_targets`, `http_request`, `http_history` |

Layout: sidebar, request pane and response pane side by side; the two panes stack when the panel is narrow, and the divider between them drags (double-click resets it). `Ctrl` / `⌘` + `Enter` sends the request.

## Event streams

A response with the content type `text/event-stream` is read event by event.

| Aspect | Behavior |
|---|---|
| While receiving | The response pane shows the status, the event count and the elapsed time, appends each event as it arrives and keeps the list scrolled to the end; **Stop** ends the stream |
| Events view | One row per event: number, arrival time after the request started, event type (`message` when unnamed) and data; a row expands to the data, pretty-printed when it is JSON, with `id` and `retry` |
| Text view | The text assembled from model output streams: OpenAI Chat Completions and Responses, Anthropic Messages, Gemini. Shown when the stream carries such increments |
| Raw view | The stream text, once the stream has ended |
| End of stream | The server closes it; **Stop**; no data within the target timeout; or the 1 MiB body cap. In every case what arrived is kept and recorded, and the request does not count as failed |
| Timeout | For the panel the target timeout restarts with every chunk; for the agent it covers the whole stream |
| History | The stream text (32 KiB cap) and the arrival time of each event |
| Agent | `http_request` returns the stream text read until the stream ends, the 64 KiB cap or the target timeout |

## Captured variables

A saved request can carry capture rules: after the panel sends it, or the host sends it as a [refresh](#auto-refresh), and a 2xx response arrives, the host reads values from the response into variables of the request's scope.

| Aspect | Behavior |
|---|---|
| Rule | Variable name, source and path, plus lifetime and auto refresh; each rule can be switched off; up to 20 per request |
| Source | JSON body: a path such as `data.access_token`, `items[0].id` or `$.a["b.c"]`. Header: a response header name |
| Values | Strings, numbers and booleans; an empty value, an object, an array, a value with line breaks or above 16 KiB is not captured |
| Trigger | The panel sends that saved request, or the host sends it as a refresh; the agent's own requests and event stream responses run no rules |
| Lifetime | A number of seconds, or a path in the JSON of the same response (such as `expires_in`, holding seconds); empty means no expiry. When the path yields no positive number the value is captured without expiry and the response pane says so. A value counts as expired 30 seconds before its expiry, or a tenth of its lifetime when the lifetime is below 300 seconds |
| No capture | A response outside 2xx, a body that is not JSON or is truncated, a missing path or header: the stored value stays and the response pane shows the reason |
| Reference | Requests of the same scope reference the value as `{{name}}`, agent requests to the target included; it takes precedence over a target variable or secret variable of the same name. An expired value is still substituted while auto refresh is off |
| Update | Send the source request again, or switch on [auto refresh](#auto-refresh) |
| Scope | One set per target; requests without a target share one set |
| Secrecy | Values stay on the host; the panel and the agent get names and short hints, and the values are masked in URLs, headers, bodies and the history, the source response included |

## Auto refresh

The auto refresh setting of a capture rule lets the host send that saved request by itself when needed. Use: APIs whose token comes from another endpoint and expires.

| Aspect | Behavior |
|---|---|
| Setting | One per capture rule: off; missing or expired; missing, expired or 401 |
| Trigger | A request of the same scope references the variable while it has no value or has expired. References count in the request's path, query, headers and body, and in the target's fixed headers and authentication |
| Order | The host sends the source request and captures first, then sends the original request; a source request that provides several needed variables is sent once |
| 401 | With the 401 setting: when the original request receives 401, the host refreshes once and sends the original request once more. A variable just refreshed for this request is not refreshed again |
| Source request | Sent as its saved form, its own authentication included; without the target authentication and the fixed headers that reference a variable it captures |
| Agent | Requests of the agent trigger it too. A refresh sends the user's saved form and is not subject to the target's mutation switch or `confirm`; the result of `http_request` lists it under `refreshed` |
| Concurrency | One refresh per source request at a time; other requests wait for its result |
| Failure | When the source request fails or does not capture the variable, the original request is not sent and its error names the source request and the reason; no retry, the next request tries again |
| Chains | Variables the source request references are refreshed the same way, up to 3 refreshes in a chain; requests that depend on each other fail |
| Cancel | Cancelling the original request stops the wait; a refresh already sent completes and its captured value is kept |
| Records | A refresh is an exchange of its own, with the sender that caused it as its source; the response pane of the original request lists the refreshes made |
| Several sources of one variable | The source request the current value came from is sent; without a value, the one created first |

Setup for a token API: a secret variable of the target holds `client_secret`; a saved request calls the token endpoint with `{{client_secret}}` in its body, captures `access_token` with the lifetime `expires_in` and auto refresh on; the target authentication is bearer with the token `{{access_token}}`.

## Import and export

| Aspect | Behavior |
|---|---|
| Export | One JSON file: every target (secret variables by name only), the saved requests (capture rules included) and the history limit |
| Not exported | Literal target and request authentication secrets and literal values of credential headers (in both, a value that references a `{{variable}}` stays), secret variable values, captured variable values, the history and the **Allow agent** switch |
| Import | The file is validated as a whole; one invalid entry and nothing is written |
| Matching targets | Matched by name, case-insensitive; the requests without a target match as one unit. With a match, the choice is **Overwrite** or **Skip** |
| Overwrite | The file replaces the settings and request list of each matching target; a stored secret stays when the authentication type is unchanged, and a secret variable of the same name keeps its stored value |
| Skip | Matching targets and their requests stay as they are; only the other targets are imported |
| Target without its secret | Shown as "secret not filled in". Without the authentication secret no request is sent; without a secret variable the requests that reference it are not sent |

## Requests without a target

| Aspect | Behavior |
|---|---|
| URL | The whole URL goes into the URL bar; a missing scheme becomes `http` for loopback and private literals, `https` otherwise |
| Reach | Any host, loopback and private networks included |
| Credentials | None injected by the host; the request's own authentication (Auth tab) and credentials typed into Headers are saved with the request |
| Agent | Not callable and not listed: `http_request` takes configured targets only, and `http_history` leaves these exchanges out |
| Promotion | **New target from this URL** opens the target dialog with the URL's origin as base URL; on save the request moves below the new target and its URL becomes a path |

The panel and the agent share the targets and the history: the agent calls a target by name, the host injects the credentials, and the exchange appears in the same history the panel shows.

## Installation

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-http-<version>.tgz
```

Artifacts: [dsh-toolkit releases](https://github.com/Onenightcarnival/dsh-toolkit/releases). The standalone plugin and the toolkit package are mutually exclusive.

## Target

| Field | Value |
|---|---|
| Base URL | `http(s)` scheme, host and optional path prefix; request paths join below it. Credentials, query and fragment are rejected |
| Name | Defaults to the host; the agent addresses the target by name (unique, case-insensitive) |
| Authentication | `none`; `bearer` (Authorization: Bearer); `basic`; `header` (custom header); `query` (parameter appended to every URL). Secrets are stored host-side; on edit an empty secret keeps the saved value. Values may reference `{{variables}}`; a value that is one reference is shown as written in summaries |
| Fixed headers | Sent on every request; a request header of the same name overrides. Values may reference `{{variables}}`. Transport headers (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`…) are rejected |
| Variables | `{{name}}` replaced in a request's path, query, headers and body, and in the target's fixed headers and authentication; unknown names stay as written. Non-secret; a [captured variable](#captured-variables) of the same name takes precedence |
| Secret variables | Referenced and replaced like variables; a name is not shared with a variable. Values are stored host-side, reach the panel and the agent as names and short hints, are masked in URLs, headers, bodies and the history, and are left out of exports; on edit an empty value keeps the saved one |
| Extra allowed hosts | Hosts besides the base URL host that an absolute URL or a redirect may reach; `*.example.com` matches subdomains |
| Allow mutations | The agent may use POST / PUT / PATCH / DELETE; each call still requires `confirm=true` |
| Allow private network | Requests may reach loopback, link-local and RFC 1918 addresses, including names that resolve to them |
| Timeout | 1 000–120 000 ms for the whole request including redirects and body download; default 30 000. [Event streams](#event-streams) read by the panel restart it with every chunk |
| Test connection | GET on the base URL with auth; any HTTP status counts as reachable |

## Request handling

| Step | Behavior |
|---|---|
| URL | `path` joins below the base URL path; an absolute URL must be on the base host or an allowed host |
| Query | Parameters are sent in order and repeated names are kept |
| Refresh | When a variable the request references has [auto refresh](#auto-refresh) and is missing or expired, its source request is sent first |
| Authentication | The target's authentication is injected; when the target has none, the request's own authentication applies, for requests sent from the panel and refreshes sent by the host |
| Body | Ignored for GET and HEAD; `content-type` defaults to `application/json` for a body starting with `{` or `[`, else `text/plain`; the form mode sends `application/x-www-form-urlencoded` |
| Redirects | Up to 5 hops, each checked against the allowed hosts; credentials are dropped on an origin change; 303, and 301/302 after POST, continue as GET without body |
| Response | Textual bodies decoded by the declared charset; a complete binary body reaches the panel for preview and saving and is never stored; the panel keeps 1 MiB, the agent 64 KiB, the history 32 KiB per body |
| Masking | Target secrets, secret variable values, a request's own authentication, captured variable values, and credentials typed into the request headers `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `API-Key`, `X-Auth-Token` and `X-Access-Token`, are replaced with `••••••` (their URL encoding too) in URLs, headers and bodies handed to the panel, the agent and the history |
| Proxy | Requests go through the host's global `fetch`, so the kernel's outbound proxy policy applies |

## Agent tools

Registered while **Allow agent** is on; unregistered at once when it is switched off.

| Tool | Behavior |
|---|---|
| `http_targets` | Targets with base URL, auth type, fixed headers, variable names (secret, captured and auto-refreshed ones included), allowed hosts and switches |
| `http_request` | `target`, `method`, `path`, `query`, `headers`, `body`, `confirm`. GET / HEAD / OPTIONS run directly; other methods need the target's mutation switch and `confirm=true`. `refreshed` in the result lists the [refreshes](#auto-refresh) the host made before the request |
| `http_history` | Recent exchanges of one or every target with status, duration and body previews; requests without a target are left out |

## Not supported

| Area | Limit |
|---|---|
| Bodies | No multipart form data, file upload or binary file body; no GraphQL editor |
| Authentication | No OAuth, digest, NTLM or AWS signatures |
| Cookies | No cookie jar; a `Cookie` header is sent as typed |
| Requests | A flat list per scope: no folders, no manual ordering; methods limited to GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; timeout and redirect handling are set per target |
| Protocols | HTTP only: no WebSocket, no gRPC |
| Orchestration | [Auto refresh](#auto-refresh) is the only dependency between requests: no running a set of requests in order, no conditions or loops |
| Scripting | No pre-request or response scripts, tests or code generation other than cURL |
| Editors | No completion, bracket matching or response filtering; a body above 200 000 characters is not highlighted |
| Capture | No capture from event streams, non-JSON bodies or cookies; a lifetime is a number of seconds, not a point in time; no scheduled refresh, a refresh happens only when a request references the variable |

## Data and access

| Boundary | Contract |
|---|---|
| Storage | `~/.dsh/dsh-http.json` (targets with their secret variables, switches), `~/.dsh/dsh-http-requests.json` (saved requests), `~/.dsh/dsh-http-values.json` (captured variable values) and `~/.dsh/dsh-http-history.jsonl` (exchanges), mode `0600` |
| Saved requests | Up to 500 per target and 500 without a target; a body up to 256 KiB. A target's authentication stays on the target; a request's own authentication, credentials typed into its headers and literal values in its body are stored with it in plaintext and exported with the configuration; secrets are referenced as secret variables of the target. Deleting a target deletes its requests |
| Credentials | Host-only; summaries carry the auth type, non-secret names, secret variable names and a short hint |
| History | Default 200 exchanges, oldest dropped first (`historyLimit`, 10–1 000); deleting a target deletes its history |
| HTTP | `/api/dsh-http/*` requires loopback, same-origin browser markers and the GUI session cookie; `401` without the cookie |

## API

| Request | Response |
|---|---|
| `GET /api/dsh-http/targets` | `{ targets: [summary…] }` |
| `POST /api/dsh-http/targets` | Create; `201` `{ target }` |
| `PATCH /api/dsh-http/targets?id=` | Update; `{ target }` |
| `DELETE /api/dsh-http/targets?id=` | Delete target, its saved requests and its history |
| `GET /api/dsh-http/requests?target=` | `{ requests }` in creation order; `target=direct` lists the requests without a target |
| `POST /api/dsh-http/requests` with `{ targetId, … }` | Create; `targetId` is a target id or `direct`; `201` `{ request }` |
| `PATCH /api/dsh-http/requests?id=` | Update the given fields; a `targetId` moves the request; `{ request }` |
| `DELETE /api/dsh-http/requests?id=` | Delete the request |
| `GET` / `POST /api/dsh-http/settings` | `{ settings: { agentTools, historyLimit } }` |
| `POST /api/dsh-http/send` with `{ id, request }` | `{ exchange }`; `id` is a target id, or `direct` with a full URL in `request.path`; `request.query` is an object or a list of `[name, value]` pairs; `request.auth` is the request's own authentication; `request.requestId` ties the exchange to a saved request; policy and transport failures are `exchange.error`, a failed refresh included; `exchange.refreshed` lists the refreshes made before the send, and `exchange.refreshOf` marks an exchange the host sent as a refresh. With `Accept: application/x-ndjson` the answer is one JSON object per line: `{"type":"head"}` and `{"type":"event"}` lines while an event stream arrives, then `{"type":"done","exchange"}` or `{"type":"error"}`. Closing the connection before the response cancels the request; it is recorded with the error `cancelled` |
| `GET /api/dsh-http/history?target=&limit=` | `{ entries }`, newest first |
| `DELETE /api/dsh-http/history?id=` / `?target=` / none | `{ removed }` |
| `POST /api/dsh-http/test` with `{ id }` | `{ result: { ok, status, latencyMs, error } }` |
| `GET /api/dsh-http/values?target=` | `{ values: [{ name, hint, requestId, at, expiresAt? }] }` |
| `DELETE /api/dsh-http/values?target=&name=` | Clear one captured variable; without `name`, all of the scope; `{ removed }` |
| `GET /api/dsh-http/transfer` | `{ bundle }`: the content of an export file |
| `POST /api/dsh-http/transfer` with `{ bundle, conflict }` | Import; `conflict` is `overwrite` or `skip`; `{ result: { conflicts, created, overwritten, skipped, needAuth, requests } }`. `{ bundle, dryRun: true }` validates only and returns `conflicts` |

## Development

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-http run build        # lib/index.js (host), lib/client.js (client)
pnpm --filter @onenightcarnival/dsh-http run typecheck
pnpm --filter @onenightcarnival/dsh-http run test         # store, engine and refresh (local HTTP server), tool tests
pnpm --filter @onenightcarnival/dsh-http pack
```

| File | Responsibility |
|---|---|
| `src/protocol.ts` | Wire contract shared by host and client, URL joining, variable substitution, form-to-request conversion, server-sent event parser |
| `src/store.ts` | Target validation and storage (secret variables included), saved requests, captured variable values and their expiry, exchange history |
| `src/capture.ts` | Capture rules: JSON path parsing, value reading and lifetime |
| `src/engine.ts` | Host and private-network policy, variable substitution, auth, auto refresh, redirects, body cap, incremental event stream reading, capture, masking |
| `src/transfer.ts` | Export file creation, import validation and merge |
| `src/routes.ts` | `/api/dsh-http/*` |
| `src/tools.ts` | `http_*` agent tools |
| `src/client/curl.ts` | cURL command parsing and writing, query splitting |
| `src/client/sse.ts` | Rows of a recorded event stream, text of model output streams |
| `src/client/lifetime.ts` | Text and value of a capture rule's lifetime field |
| `src/client/panel/SseView.tsx` | Event stream views: events, text, raw |
| `src/client/panel/HttpPanel.tsx` | Three-pane shell: target selector, request selection and autosave, divider, shortcut, send and cancel |
| `src/client/panel/{RequestList,HistorySidebar,RequestPane,ResponsePane}.tsx` | Saved request list, exchange history list, request tabs, response tabs |
| `src/client/panel/{TargetForm,KeyValueEditor}.tsx` | Target dialog; name/value rows with a trailing blank row |
| `src/client/panel/{Code,CaptureEditor}.tsx` | Syntax-highlighted read-only view and editor; capture rule editor and captured variable list |

## License

MIT
