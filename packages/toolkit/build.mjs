import { fileURLToPath } from 'node:url'
import { buildClient, buildHost } from '../../scripts/build-plugin.mjs'
import { keepAliveShimPlugin } from '../otel/scripts/keepalive-shim.mjs'

const dir = fileURLToPath(new URL('.', import.meta.url))
await buildHost({ dir, entry: 'src/index.ts', inlined: [], plugins: [keepAliveShimPlugin] })
await buildHost({ dir, entry: 'src/typert.ts', outfile: 'lib/typert.js' })
await buildClient({ dir, entry: 'src/client.ts' })
