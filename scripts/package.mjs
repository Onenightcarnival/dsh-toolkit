#!/usr/bin/env node
/**
 * Input: package and extension builds; `--build` builds them first.
 * Output: dist/
 *   onenightcarnival-dsh-{rdb,s3,otel,bridge-browser,subscriptions,toolkit}-<v>.tgz
 *   dsh-browser-extension-chrome-<v>.zip (extension entries at archive root)
 *   SHA256SUMS.txt
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = ['packages/rdb', 'packages/s3', 'packages/otel', 'packages/browser-bridge', 'packages/subscriptions', 'packages/toolkit']
const EXTENSION_DIR = join(ROOT, 'extensions', 'dsh-browser')
const OUT_DIR = join(ROOT, 'dist')
const shell = process.platform === 'win32'

const args = new Set(process.argv.slice(2))

function run(cmd, cmdArgs, cwd) {
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell })
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed with status ${String(result.status)}`)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Zip a directory with its entries at the archive root. */
function zipDirectory(dir, target) {
  rmSync(target, { force: true })
  if (shell) {
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path ${JSON.stringify(join(dir, '*'))} -DestinationPath ${JSON.stringify(target)} -Force`], dir)
    return
  }
  run('zip', ['-qr', target, '.'], dir)
}

if (args.has('--build')) run('pnpm', ['run', 'build'], ROOT)

for (const dir of PLUGINS) {
  if (!existsSync(join(ROOT, dir, 'lib', 'index.js'))) {
    console.error(`${dir}/lib/index.js missing; run \`pnpm run build\` first or pass --build`)
    process.exit(1)
  }
}
if (!existsSync(join(EXTENSION_DIR, 'dist', 'manifest.json'))) {
  console.error('extensions/dsh-browser/dist missing; run `pnpm run build` first or pass --build')
  process.exit(1)
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

for (const dir of PLUGINS) {
  execFileSync('pnpm', ['pack', '--pack-destination', OUT_DIR], { cwd: join(ROOT, dir), stdio: 'inherit', shell })
}

const extensionVersion = JSON.parse(readFileSync(join(EXTENSION_DIR, 'package.json'), 'utf8')).version
const zipName = `dsh-browser-extension-chrome-${extensionVersion}.zip`
zipDirectory(join(EXTENSION_DIR, 'dist'), join(OUT_DIR, zipName))

const names = readdirSync(OUT_DIR).filter(name => name.endsWith('.tgz') || name.endsWith('.zip')).sort()
writeFileSync(join(OUT_DIR, 'SHA256SUMS.txt'), names.map(name => `${sha256(join(OUT_DIR, name))}  ${name}`).join('\n') + '\n')

for (const name of [...names, 'SHA256SUMS.txt']) {
  console.log(`${name}\t${(statSync(join(OUT_DIR, name)).size / 1024).toFixed(1)} KB`)
}
console.log(`\nArtifacts written to ${OUT_DIR}`)
