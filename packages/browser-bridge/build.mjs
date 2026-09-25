import { fileURLToPath } from 'node:url'
import { buildClient } from '../../scripts/build-plugin.mjs'

await buildClient({ dir: fileURLToPath(new URL('.', import.meta.url)), entry: 'src/client/index.js' })
