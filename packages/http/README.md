# dsh-http

**English** | [中文](README.zh.md)

HTTP API client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Entry: **HTTP** in the web sidebar.

## Capabilities

| Surface | Behavior |
|---|---|
| Targets | Base URL, authentication (bearer / basic / header / query), fixed headers, `{{variables}}`, extra allowed hosts, mutation switch, private-network switch, timeout |
| Sidebar | Scope selector: **No target** or one of the targets, with **New target…** as its last entry, plus edit and connection test of the selected target. Below it two tabs for the scope. **Requests**: saved request forms with a filter; **+** adds a blank request and puts the caret in its URL bar; rename (double-click or menu), duplicate, **Copy as cURL**, delete. **History**: every exchange, newest first; selecting one shows it, and an entry can be saved as a request |
| Request pane | The form of the selected saved request, edited in place and saved automatically: method, a full URL (no target) or a path below the base URL, and Send. Pasting a cURL command into the URL bar fills the whole form. Tabs: Params (URL preview, **Import parameters from URL**), Body (JSON / text / form; JSON syntax highlighting; Tab indents), Headers (plus the target's fixed headers, read-only), Auth, Capture |
| Name/value tables | Params, Headers and form fields: a blank row follows the last one; **Add**, **Bulk edit** (one `name: value` per line, `#` switches a line off) and **Delete all**; a checkbox per row; repeated names are kept |
| Auth tab | A target with authentication: shown read-only. A target without, or no target: the request's own authentication — bearer, basic, custom header or query parameter |
| Capture tab | The request's [capture rules](#captured-variables), and the captured variables of the scope: name, masked hint, source request, time and **Clear** |
| Response pane | The latest response of the selected request, with a picker for its earlier responses, or an exchange picked from the history. Status, duration and size; tabs Preview (pretty / raw JSON; syntax highlighting for JSON, HTML, XML, JavaScript, CSS and YAML; capture results; images shown; HTML as source or rendered in a sandbox without scripts; event streams as they arrive; copy; **Save to file**), Headers, Request (URL, headers and body as sent, secrets masked). A request in flight shows its elapsed time and a cancel button |
| History | Every exchange of the panel and the agent, per target; requests sent by the agent appear within a few seconds; delete one entry or clear the target |
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

A saved request can carry capture rules: after the panel sends it and a 2xx response arrives, the host reads values from the response into variables of the request's scope.

| Aspect | Behavior |
|---|---|
| Rule | Variable name, source and path; each rule can be switched off; up to 20 per request |
| Source | JSON body: a path such as `data.access_token`, `items[0].id` or `$.a["b.c"]`. Header: a response header name |
| Values | Strings, numbers and booleans; an empty value, an object, an array, a value with line breaks or above 16 KiB is not captured |
| Trigger | Only when the panel sends that saved request; agent requests and event stream responses run no rules |
| No capture | A response outside 2xx, a body that is not JSON or is truncated, a missing path or header: the stored value stays and the response pane shows the reason |
| Reference | Requests of the same scope reference the value as `{{name}}`, agent requests to the target included; it takes precedence over a target variable of the same name |
| Refresh | Send the source request again |
| Scope | One set per target; requests without a target share one set |
| Secrecy | Values stay on the host; the panel and the agent get names and short hints, and the values are masked in URLs, headers, bodies and the history, the source response included |

## Import and export

| Aspect | Behavior |
|---|---|
| Export | One JSON file: every target, the saved requests (capture rules included) and the history limit |
| Not exported | Target and request authentication secrets, literal values of credential headers (a value that references a `{{variable}}` stays), captured variable values, the history and the **Allow agent** switch |
| Import | The file is validated as a whole; one invalid entry and nothing is written |
| Matching targets | Matched by name, case-insensitive; the requests without a target match as one unit. With a match, the choice is **Overwrite** or **Skip** |
| Overwrite | The file replaces the settings and request list of each matching target; a stored secret stays when the authentication type is unchanged |
| Skip | Matching targets and their requests stay as they are; only the other targets are imported |
| Target without its secret | Shown as "authentication not filled in"; requests are not sent until it is filled in |

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
| Authentication | `none`; `bearer` (Authorization: Bearer); `basic`; `header` (custom header); `query` (parameter appended to every URL). Secrets are stored host-side; on edit an empty secret keeps the saved value |
| Fixed headers | Sent on every request; a request header of the same name overrides. Transport headers (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`…) are rejected |
| Variables | `{{name}}` replaced in path, query, headers and body; unknown names stay as written. Non-secret; a [captured variable](#captured-variables) of the same name takes precedence |
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
| Authentication | The target's authentication is injected; when the target has none, the request's own authentication applies, for requests sent from the panel only |
| Body | Ignored for GET and HEAD; `content-type` defaults to `application/json` for a body starting with `{` or `[`, else `text/plain`; the form mode sends `application/x-www-form-urlencoded` |
| Redirects | Up to 5 hops, each checked against the allowed hosts; credentials are dropped on an origin change; 303, and 301/302 after POST, continue as GET without body |
| Response | Textual bodies decoded by the declared charset; a complete binary body reaches the panel for preview and saving and is never stored; the panel keeps 1 MiB, the agent 64 KiB, the history 32 KiB per body |
| Masking | Target secrets, a request's own authentication, captured variable values, and credentials typed into the request headers `Authorization`, `Proxy-Authorization`, `Cookie`, `X-API-Key`, `API-Key`, `X-Auth-Token` and `X-Access-Token`, are replaced with `••••••` (their URL encoding too) in URLs, headers and bodies handed to the panel, the agent and the history |
| Proxy | Requests go through the host's global `fetch`, so the kernel's outbound proxy policy applies |

## Agent tools

Registered while **Allow agent** is on; unregistered at once when it is switched off.

| Tool | Behavior |
|---|---|
| `http_targets` | Targets with base URL, auth type, fixed headers, variable names (captured ones included), allowed hosts and switches |
| `http_request` | `target`, `method`, `path`, `query`, `headers`, `body`, `confirm`. GET / HEAD / OPTIONS run directly; other methods need the target's mutation switch and `confirm=true` |
| `http_history` | Recent exchanges of one or every target with status, duration and body previews; requests without a target are left out |

## Not supported

| Area | Limit |
|---|---|
| Bodies | No multipart form data, file upload or binary file body; no GraphQL editor |
| Authentication | No OAuth, digest, NTLM or AWS signatures |
| Cookies | No cookie jar; a `Cookie` header is sent as typed |
| Requests | A flat list per scope: no folders, no manual ordering; methods limited to GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; timeout and redirect handling are set per target |
| Protocols | HTTP only: no WebSocket, no gRPC |
| Scripting | No pre-request or response scripts, tests or code generation other than cURL |
| Editors | No completion, bracket matching or response filtering; a body above 200 000 characters is not highlighted |
| Capture | No automatic refresh and no expiry; no capture from event streams, non-JSON bodies or cookies |

## Data and access

| Boundary | Contract |
|---|---|
| Storage | `~/.dsh/dsh-http.json` (targets, switches), `~/.dsh/dsh-http-requests.json` (saved requests), `~/.dsh/dsh-http-values.json` (captured variable values) and `~/.dsh/dsh-http-history.jsonl` (exchanges), mode `0600` |
| Saved requests | Up to 500 per target and 500 without a target; a body up to 256 KiB. A target's authentication stays on the target; a request's own authentication and credentials typed into its headers are stored with it in plaintext. Deleting a target deletes its requests |
| Credentials | Host-only; summaries carry the auth type, non-secret names and a short hint |
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
| `POST /api/dsh-http/send` with `{ id, request }` | `{ exchange }`; `id` is a target id, or `direct` with a full URL in `request.path`; `request.query` is an object or a list of `[name, value]` pairs; `request.auth` is the request's own authentication; `request.requestId` ties the exchange to a saved request; policy and transport failures are `exchange.error`. With `Accept: application/x-ndjson` the answer is one JSON object per line: `{"type":"head"}` and `{"type":"event"}` lines while an event stream arrives, then `{"type":"done","exchange"}` or `{"type":"error"}`. Closing the connection before the response cancels the request; it is recorded with the error `cancelled` |
| `GET /api/dsh-http/history?target=&limit=` | `{ entries }`, newest first |
| `DELETE /api/dsh-http/history?id=` / `?target=` / none | `{ removed }` |
| `POST /api/dsh-http/test` with `{ id }` | `{ result: { ok, status, latencyMs, error } }` |
| `GET /api/dsh-http/values?target=` | `{ values: [{ name, hint, requestId, at }] }` |
| `DELETE /api/dsh-http/values?target=&name=` | Clear one captured variable; without `name`, all of the scope; `{ removed }` |
| `GET /api/dsh-http/transfer` | `{ bundle }`: the content of an export file |
| `POST /api/dsh-http/transfer` with `{ bundle, conflict }` | Import; `conflict` is `overwrite` or `skip`; `{ result: { conflicts, created, overwritten, skipped, needAuth, requests } }`. `{ bundle, dryRun: true }` validates only and returns `conflicts` |

## Development

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-http run build        # lib/index.js (host), lib/client.js (client)
pnpm --filter @onenightcarnival/dsh-http run typecheck
pnpm --filter @onenightcarnival/dsh-http run test         # store, engine (local HTTP server) and tool tests
pnpm --filter @onenightcarnival/dsh-http pack
```

| File | Responsibility |
|---|---|
| `src/protocol.ts` | Wire contract shared by host and client, URL joining, server-sent event parser |
| `src/store.ts` | Target validation and storage, saved requests, captured variable values, exchange history |
| `src/capture.ts` | Capture rules: JSON path parsing and value reading |
| `src/engine.ts` | Host and private-network policy, variable substitution, auth, redirects, body cap, incremental event stream reading, capture, masking |
| `src/transfer.ts` | Export file creation, import validation and merge |
| `src/routes.ts` | `/api/dsh-http/*` |
| `src/tools.ts` | `http_*` agent tools |
| `src/client/curl.ts` | cURL command parsing and writing, query splitting |
| `src/client/sse.ts` | Rows of a recorded event stream, text of model output streams |
| `src/client/panel/SseView.tsx` | Event stream views: events, text, raw |
| `src/client/panel/HttpPanel.tsx` | Three-pane shell: target selector, request selection and autosave, divider, shortcut, send and cancel |
| `src/client/panel/{RequestList,HistorySidebar,RequestPane,ResponsePane}.tsx` | Saved request list, exchange history list, request tabs, response tabs |
| `src/client/panel/{TargetForm,KeyValueEditor}.tsx` | Target dialog; name/value rows with a trailing blank row |
| `src/client/panel/{Code,CaptureEditor}.tsx` | Syntax-highlighted read-only view and editor; capture rule editor and captured variable list |

## License

MIT
