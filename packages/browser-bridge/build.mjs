import { fileURLToPath } from 'node:url'
import { buildClient, writeNotices } from '../../scripts/build-plugin.mjs'

const dir = fileURLToPath(new URL('.', import.meta.url))
await buildClient({ dir, entry: 'src/client/index.js' })
writeNotices({ dir })
