/**
 * Third-party notices of a build artifact.
 *
 * Input: the modules a bundler placed in the artifact, as absolute file paths.
 * Output: THIRD_PARTY_LICENSES.txt with
 *   - the SOURCE_NOTICES.txt of each source directory: hand-written notices for
 *     source derived from other projects;
 *   - one block per distinct license text among the bundled packages, listing
 *     the packages it covers, followed by their NOTICE files.
 * A build without third-party content leaves no file.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const OUTFILE = 'THIRD_PARTY_LICENSES.txt'
const SOURCE_NOTICES = 'SOURCE_NOTICES.txt'
const RULE = '-'.repeat(72)
const LICENSE_FILE = /^(licen[sc]e|copying)([.-].*)?$/i
const NOTICE_FILE = /^notice([.-].*)?$/i
const APACHE_TEXT = /Apache License\s+Version 2\.0/

/**
 * Modules with code in the outputs of an esbuild metafile.
 * @param {import('esbuild').Metafile} metafile
 * @param {string} baseDir directory the metafile paths are relative to
 * @returns {string[]} absolute paths
 */
export function bundledFiles(metafile, baseDir) {
  const files = new Set()
  for (const output of Object.values(metafile.outputs)) {
    for (const [file, info] of Object.entries(output.inputs)) {
      if (info.bytesInOutput > 0) files.add(resolve(baseDir, file))
    }
  }
  return [...files]
}

/** The installed package a module belongs to: the nearest manifest with a name and a version. */
function packageRootOf(file) {
  for (let at = dirname(file); at !== dirname(at); at = dirname(at)) {
    const manifest = join(at, 'package.json')
    if (!existsSync(manifest)) continue
    const json = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof json.name === 'string' && typeof json.version === 'string') return { root: at, json }
  }
  return undefined
}

function spdxOf(json) {
  if (typeof json.license === 'string') return json.license
  if (typeof json.license?.type === 'string') return json.license.type
  if (Array.isArray(json.licenses)) return json.licenses.map(entry => entry.type).filter(Boolean).join(' OR ')
  return 'UNKNOWN'
}

function readAll(root, pattern) {
  return readdirSync(root).filter(name => pattern.test(name)).sort()
    .map(name => readFileSync(join(root, name), 'utf8').replaceAll('\r\n', '\n').trim())
    .filter(text => text !== '')
}

/**
 * Packages installed under node_modules that own at least one of the files.
 * @param {Iterable<string>} files absolute module paths
 */
export function thirdPartyPackages(files) {
  const packages = new Map()
  for (const file of files) {
    if (!file.includes(`${sep}node_modules${sep}`)) continue
    const found = packageRootOf(file)
    if (found === undefined) continue
    const key = `${found.json.name}@${found.json.version}`
    if (packages.has(key)) continue
    packages.set(key, {
      id: key,
      license: spdxOf(found.json),
      texts: readAll(found.root, LICENSE_FILE),
      notices: readAll(found.root, NOTICE_FILE),
    })
  }
  return [...packages.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Notice text for a set of packages and source notices; empty when there is nothing to declare.
 * @param {{ packages: ReturnType<typeof thirdPartyPackages>, sourceNotices?: string[], preface?: string }} input
 */
export function renderNotices({ packages, sourceNotices = [], preface }) {
  const sections = []
  if (sourceNotices.length > 0) {
    sections.push(['Source derived from other projects', '='.repeat(34), '', sourceNotices.join(`\n\n${RULE}\n`)].join('\n'))
  }
  if (packages.length > 0) {
    // One block per distinct license text; a package without a license file is listed under its declared license.
    const blocks = new Map()
    for (const pkg of packages) {
      const text = pkg.texts.join('\n\n')
      const key = text === '' ? `declared:${pkg.license}` : text.replace(/\s+/g, ' ')
      const block = blocks.get(key) ?? { ids: [], licenses: new Set(), text, notices: [] }
      block.ids.push(pkg.id)
      block.licenses.add(pkg.license)
      for (const notice of pkg.notices) if (!block.notices.includes(notice)) block.notices.push(notice)
      blocks.set(key, block)
    }
    const rendered = [...blocks.values()].map((block) => {
      const head = [`Packages: ${block.ids.join(', ')}`, `License: ${[...block.licenses].join(', ')}`]
      const body = block.text === '' ? 'The license is declared in the package manifest; the package ships no license file.' : block.text
      const notices = block.notices.map(notice => `\nNOTICE\n\n${notice}`)
      return [...head, '', body, ...notices].join('\n')
    })
    const withoutText = packages.filter(pkg => pkg.texts.length === 0 && /apache-2\.0/i.test(pkg.license))
    if (withoutText.length > 0 && !rendered.some(text => APACHE_TEXT.test(text))) {
      throw new Error(`no Apache-2.0 license text among the bundled packages for: ${withoutText.map(pkg => pkg.id).join(', ')}`)
    }
    sections.push([
      'Bundled packages', '='.repeat(16), '',
      ...(preface === undefined ? [] : [preface, '']),
      rendered.join(`\n\n${RULE}\n`),
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return [
    'Third-party notices', '='.repeat(19), '',
    'Generated at build time from the modules bundled into this artifact.', '',
    sections.join('\n\n\n'), '',
  ].join('\n')
}

/**
 * Write (or remove) the notices of an artifact.
 * @param {{ dir: string, files: Iterable<string>, sources?: string[], outfile?: string, preface?: string }} options
 *   dir: package directory; sources: directories whose SOURCE_NOTICES.txt apply (default: dir);
 *   outfile: target path (default: THIRD_PARTY_LICENSES.txt in dir).
 */
export function writeThirdPartyNotices({ dir, files, sources = [dir], outfile = join(dir, OUTFILE), preface }) {
  const packages = thirdPartyPackages(files)
  const sourceNotices = sources.map(source => join(source, SOURCE_NOTICES)).filter(existsSync)
    .map(file => readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim())
  const text = renderNotices({ packages, sourceNotices, preface })
  if (text === '') {
    rmSync(outfile, { force: true })
    return
  }
  writeFileSync(outfile, text)
  console.log(`${OUTFILE} ${packages.length} bundled package(s), ${sourceNotices.length} source notice(s)`)
}
