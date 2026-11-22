import { fileURLToPath } from 'node:url'
import { buildClient, buildHost, writeNotices } from '../../scripts/build-plugin.mjs'

const dir = fileURLToPath(new URL('.', import.meta.url))
await buildHost({ dir, entry: 'src/index.ts', inlined: ['yaml', 'fflate'] })
await buildClient({ dir, entry: 'src/client/index.tsx' })
writeNotices({ dir })
