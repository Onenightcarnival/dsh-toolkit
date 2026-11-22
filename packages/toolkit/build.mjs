import { fileURLToPath } from 'node:url'
import { buildClient, buildHost, writeNotices } from '../../scripts/build-plugin.mjs'
import { keepAliveShimPlugin } from '../otel/scripts/keepalive-shim.mjs'

const dir = fileURLToPath(new URL('.', import.meta.url))
await buildHost({ dir, entry: 'src/index.ts', inlined: [], external: ['@cortexkit/antigravity-auth-core'], plugins: [keepAliveShimPlugin] })
await buildHost({ dir, entry: 'src/typert.ts', outfile: 'lib/typert.js' })
await buildClient({ dir, entry: 'src/client.ts' })
// The bundle carries the source of the subscription backend and of the browser bridge.
writeNotices({
  dir,
  sources: [fileURLToPath(new URL('../subscriptions', import.meta.url)), fileURLToPath(new URL('../browser-bridge', import.meta.url))],
})
