#!/usr/bin/env node
/**
 * One version for every published surface of the workspace.
 *
 *   node scripts/version.mjs set 0.5.0     write it everywhere
 *   node scripts/version.mjs check 0.5.0   exit 1 unless every file already carries it
 *
 * Browser manifests reject prerelease labels and take the numeric part only.
 * Release: the workflow runs `set` with the pushed tag, so the committed version may lag behind it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const FILES = [
  { path: 'package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'packages/rdb/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'packages/s3/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'packages/otel/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'packages/otel/src/index.js', field: /^(export const PLUGIN_VERSION = )"([^"]*)"/m },
  { path: 'packages/browser-bridge/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'packages/toolkit/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'extensions/dsh-browser/package.json', field: /^(\s*"version":\s*)"([^"]*)"/m },
  { path: 'extensions/dsh-browser/manifest.json', field: /^(\s*"version":\s*)"([^"]*)"/m, numericOnly: true },
  { path: 'extensions/dsh-browser/manifest.firefox.json', field: /^(\s*"version":\s*)"([^"]*)"/m, numericOnly: true },
]

const [command, version] = process.argv.slice(2)
if ((command !== 'set' && command !== 'check') || version === undefined || !VERSION_RE.test(version)) {
  console.error('usage: node scripts/version.mjs <set|check> <X.Y.Z[-prerelease]>')
  process.exit(1)
}

let mismatches = 0
for (const file of FILES) {
  const target = join(ROOT, file.path)
  const text = readFileSync(target, 'utf8')
  const match = file.field.exec(text)
  if (match === null) throw new Error(`${file.path}: no version field`)
  const expected = file.numericOnly ? version.replace(/-.*$/, '') : version
  if (command === 'set') {
    writeFileSync(target, text.replace(file.field, `$1"${expected}"`))
    console.log(`${file.path}: ${expected}`)
  } else if (match[2] === expected) {
    console.log(`${file.path}: ${expected}`)
  } else {
    console.error(`${file.path}: ${match[2]} (expected ${expected})`)
    mismatches++
  }
}
if (mismatches > 0) {
  console.error(`\n${mismatches} file(s) do not carry ${version}; run: node scripts/version.mjs set ${version}`)
  process.exit(1)
}
