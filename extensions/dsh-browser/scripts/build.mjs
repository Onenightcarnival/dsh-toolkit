/**
 * Build all three extension targets sequentially into dist/ (or dist-firefox/
 * with --firefox):
 * background (es|iife) → content (iife) → panel (React). The first target
 * cleans the output; the later ones append. Pass --watch for dev rebuilds.
 * A full build ends with THIRD_PARTY_LICENSES.txt, generated from the modules
 * the three targets bundled.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeThirdPartyNotices } from '../../../scripts/third-party-notices.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox switches the manifest and background bundle for the Firefox build.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.panel.config.ts',
]

if (watch) {
  // Watchers run in parallel.
  const children = configs.map(config => spawn('vite', ['build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
} else {
  // Paths as in vite.shared.ts.
  const target = process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'
  const modulesDir = join(root, 'node_modules/.bundled-modules', target)
  rmSync(modulesDir, { recursive: true, force: true })
  for (const config of configs) {
    const result = spawnSync('vite', ['build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  const files = existsSync(modulesDir)
    ? readdirSync(modulesDir).flatMap(name => JSON.parse(readFileSync(join(modulesDir, name), 'utf8')))
    : []
  writeThirdPartyNotices({
    dir: root,
    files,
    outfile: join(root, target === 'firefox' ? 'dist-firefox' : 'dist', 'THIRD_PARTY_LICENSES.txt'),
  })
}
