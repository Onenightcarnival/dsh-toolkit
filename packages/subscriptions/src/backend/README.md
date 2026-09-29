# Subscription backend

This directory is maintained as part of `@onenightcarnival/dsh-subscriptions`.
It is compiled from local TypeScript; there is no npm dependency on the original plugin.
Providers: ChatGPT (Codex) and Google Antigravity. Tools: `codex_web_search`, `codex_image_generate`, `antigravity_web_search`, `antigravity_image_generate`.

The source was forked from V1ki/dsh-plugin-subscriptions at revision
`d8ab13e91fd6747e419a1f5e965bce42bdfc3ad8`. The original MIT notice is retained
in `../../THIRD_PARTY_LICENSES.txt` and distributed with both package artifacts.
Only ChatGPT authentication, model transport, search, images and their shared
account/configuration infrastructure are retained. Other provider implementations,
OAuth registrations, protocol translators and tools are excluded.

Local changes include current DSH request-message typing, a callback-port fallback
for Windows exclusions or occupied ports, and state-validated manual callbacks.
OAuth fallback uses the established redirect URI rather than inventing a random port.
The browser UI reads only credential-free status; tokens remain in the host store.

Run the subscription tests and host smoke tests after changing auth, model
translation, search or image handling. Any future upstream changes must be
reviewed and merged into these sources explicitly.
