/**
 * Build the four published bundles into lib/.
 * Externals: the DSH runtime's host packages, and react on the client; everything else is bundled.
 */
import { build } from 'esbuild'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { bundledFiles, writeThirdPartyNotices } from '../../../scripts/third-party-notices.mjs'
import { keepAliveShimPlugin } from './keepalive-shim.mjs'

const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name

/** Provided by the DSH runtime closure at load time — never bundled. */
const HOST_EXTERNALS = [
  'node:*',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-storage-domain',
]

const banner = `/* ${PKG} — MIT; bundles @loongsuite/dsh-plugin and OpenTelemetry JS (Apache-2.0), zod and schemastery (MIT); see THIRD_PARTY_LICENSES.txt. */`

// `require` for bundled CJS dependencies (@opentelemetry/*, protobufjs) that load Node builtins by bare name.
const hostBanner = `${banner}
import { createRequire as __dshOtelCreateRequire } from "node:module";
const require = __dshOtelCreateRequire(import.meta.url);`

const dir = fileURLToPath(new URL('..', import.meta.url))
/** Results of the four builds; their metafiles feed the third-party notices. */
const bundles = []

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })

// Host half: the cordis service plus the embedded collector pipeline.
bundles.push(await build({
  metafile: true,
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/index.js',
  external: HOST_EXTERNALS,
  banner: { js: hostBanner },
  plugins: [keepAliveShimPlugin],
  logLevel: 'info',
}))

// Host typert manifest (strict dispatch codecs; zod bundled).
bundles.push(await build({
  metafile: true,
  entryPoints: ['src/typert.js'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'lib/typert.js',
  external: HOST_EXTERNALS,
  banner: { js: hostBanner },
  logLevel: 'info',
}))

// Client remote contribution as a standalone export (also bundled into client.js).
bundles.push(await build({
  metafile: true,
  entryPoints: ['src/remote.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: 'lib/remote.js',
  banner: { js: banner },
  logLevel: 'info',
}))

// Client half: wrapped for the DSH web module loader. The loader provides
// `require` inside the factory; only react stays external.
bundles.push(await build({
  metafile: true,
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outfile: 'lib/client.js',
  external: ['react'],
  jsx: 'transform',
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PKG)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`,
  },
  footer: {
    js: '\n\t\treturn module.exports;\n\t}\n});',
  },
  logLevel: 'info',
}))

writeThirdPartyNotices({
  dir,
  files: bundles.flatMap(result => bundledFiles(result.metafile, dir)),
  preface: 'The packages are bundled as published. At build time the imports of the OTLP proto exporters resolve to the\nwrappers in src/otlp-shims.',
})

console.log('build complete')
