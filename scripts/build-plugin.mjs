/**
 * Shared plugin builds.
 *
 * Host: Node ESM; DSH runtime packages remain external.
 * Client: browser bundle in the DSH module loader; module ID = package name.
 *   DSH client modules remain external; CLIENT_INLINED libraries compile into the bundle.
 */
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { bundledFiles, writeThirdPartyNotices } from './third-party-notices.mjs'

const HOST_EXTERNAL = ['@deepseek-ai/*', 'bufferutil', 'utf-8-validate']
const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/*']
/** DSH libraries outside the web module loader; each importing package lists them in devDependencies. */
const CLIENT_INLINED = ['@deepseek-ai/dsh-util-crypto']

/** Modules bundled so far, per package directory; the input of the package's third-party notices. */
const bundled = new Map()

function record(dir, metafile) {
  const files = bundled.get(dir) ?? new Set()
  for (const file of bundledFiles(metafile, dir)) files.add(file)
  bundled.set(dir, files)
}

/**
 * Write THIRD_PARTY_LICENSES.txt of a package from the bundles built for it in this process.
 * @param {{ dir: string, sources?: string[] }} options sources: directories whose SOURCE_NOTICES.txt apply (default: dir)
 */
export function writeNotices({ dir, sources }) {
  writeThirdPartyNotices({ dir, files: bundled.get(dir) ?? [], ...(sources === undefined ? {} : { sources }) })
}

/** Resolves CLIENT_INLINED imports to their files ahead of the `@deepseek-ai/*` external pattern. */
const inlineClientLibraries = {
  name: 'inline-client-libraries',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
      if (!CLIENT_INLINED.includes(args.path)) return undefined
      return { path: createRequire(join(args.resolveDir, 'package.json')).resolve(args.path) }
    })
  },
}

function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function versionOf(dir, name) {
  const require = createRequire(join(dir, 'package.json'))
  // Manifest lookup covers isolated and hoisted installs, including unexported manifests.
  const file = require.resolve.paths(name).map(path => join(path, name, 'package.json')).find(existsSync)
  if (!file) throw new Error(`Cannot find ${name}/package.json from ${dir}`)
  return JSON.parse(readFileSync(file, 'utf8')).version
}

/** @param {{ dir: string, entry: string, outfile?: string, inlined?: string[], plugins?: import('esbuild').Plugin[] }} options */
export async function buildHost({ dir, entry, outfile = 'lib/index.js', inlined = [], plugins = [] }) {
  const pkg = manifest(dir)
  const inlinedText = inlined.map(name => `${name} ${versionOf(dir, name)}`).join(', ')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  const result = await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    outfile,
    bundle: true,
    metafile: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: HOST_EXTERNAL,
    legalComments: 'none',
    logLevel: 'info',
    plugins,
    // Bundled CommonJS dependencies use createRequire for Node builtins.
    banner: { js: `// ${pkg.name}@${pkg.version} host half${inlinedText ? ` (${inlinedText} inlined)` : ''}
import { createRequire as __toolkitCreateRequire } from 'node:module';
const require = __toolkitCreateRequire(import.meta.url);` },
  })
  record(dir, result.metafile)
}

/** @param {{ dir: string, entry: string, outfile?: string, id?: string }} options */
export async function buildClient({ dir, entry, outfile = 'lib/client.js', id }) {
  const pkg = manifest(dir)
  const result = await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: CLIENT_EXTERNAL,
    plugins: [inlineClientLibraries],
    loader: { '.css': 'text' },
    legalComments: 'none',
    logLevel: 'info',
  })
  record(dir, result.metafile)
  const body = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id ?? pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, outfile), wrapped)
  console.log(`${outfile} ${(wrapped.length / 1024).toFixed(1)} KiB`)
}
