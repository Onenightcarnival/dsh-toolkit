import { fileURLToPath } from 'node:url'
import { buildClient, buildHost } from '../../scripts/build-plugin.mjs'

const dir = fileURLToPath(new URL('.', import.meta.url))
await buildHost({ dir, entry: 'src/index.ts', inlined: ['@aws-sdk/client-s3'] })
await buildClient({ dir, entry: 'src/client/index.tsx' })
