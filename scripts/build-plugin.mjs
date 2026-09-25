/**
 * esbuild driver shared by the plugin packages.
 *
 *   buildHost({ dir, entry, outfile, inlined })    Node ESM bundle; @deepseek-ai/* stay external
 *   buildClient({ dir, entry, outfile })           browser bundle in dsh's module-loader envelope,
 *                                                  module id = the package name
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_EXTERNAL = ['@deepseek-ai/*', 'bufferutil', 'utf-8-validate']
const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/*']

function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function versionOf(dir, name) {
  return JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version
}

/** @param {{ dir: string, entry: string, outfile?: string, inlined?: string[], plugins?: import('esbuild').Plugin[] }} options */
export async function buildHost({ dir, entry, outfile = 'lib/index.js', inlined = [], plugins = [] }) {
  const pkg = manifest(dir)
  const inlinedText = inlined.map((name) => `${name} ${versionOf(dir, name)}`).join(', ')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: HOST_EXTERNAL,
    legalComments: 'none',
    logLevel: 'info',
    plugins,
    // Bundled CJS code require()s node builtins at runtime; an ESM bundle needs a real require in scope.
    banner: { js: `// ${pkg.name}@${pkg.version} host half${inlinedText ? ` (${inlinedText} inlined)` : ''}
import { createRequire as __toolkitCreateRequire } from 'node:module';
const require = __toolkitCreateRequire(import.meta.url);` },
  })
}

/** @param {{ dir: string, entry: string, outfile?: string, id?: string }} options */
export async function buildClient({ dir, entry, outfile = 'lib/client.js', id }) {
  const pkg = manifest(dir)
  const result = await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: CLIENT_EXTERNAL,
    loader: { '.css': 'text' },
    legalComments: 'none',
    logLevel: 'info',
  })
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
