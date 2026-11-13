import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import { SkillStore } from '../src/skills.ts'

const zip = entries => zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])))
const skill = '---\nname: sample\ndescription: Test skill\nmetadata:\n  version: "1.0"\n---\n# Sample\n'
const withStore = run => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  try { run(new SkillStore(home, []), home) } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
const tree = root => fs.readdirSync(root, { recursive: true }).map(file => file.replaceAll('\\', '/')).sort()

test('skill installation, conflicts, enable state, previews and legacy storage', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  try {
    const legacy = join(home, 'desktop-disabled')
    fs.mkdirSync(legacy)
    fs.writeFileSync(join(legacy, 'old-skill.md'), skill)
    const store = new SkillStore(home, [legacy])
    assert.equal(store.list().skills[0].enabled, false)
    store.setEnabled('old-skill', true)
    assert.ok(fs.existsSync(join(store.root, 'old-skill.md')))
    store.setEnabled('old-skill', false)
    assert.ok(fs.existsSync(join(store.disabled, 'old-skill.md')))
    const archive = zip({ 'sample/SKILL.md': skill, 'sample/scripts/test.py': 'print(1)', 'other/SKILL.md': skill })
    assert.deepEqual(store.install(archive).installed.sort(), ['other', 'sample'])
    const detail = store.detail('sample')
    assert.equal(detail.version, '1.0')
    assert.equal(detail.files.length, 2)
    assert.equal(store.read('sample', 'scripts/test.py').text, 'print(1)')
    const changed = zip({ 'sample/SKILL.md': '# Changed' })
    assert.deepEqual(store.install(changed).conflicts, ['sample'])
    assert.equal(store.read('sample', 'SKILL.md').text, skill)
    assert.deepEqual(store.install(changed, 'skip'), { installed: [], skipped: ['sample'], conflicts: ['sample'] })
    store.setEnabled('sample', false)
    store.install(changed, 'replace')
    assert.equal(store.detail('sample').enabled, true)
    assert.equal(store.read('sample', 'SKILL.md').text, '# Changed')
    assert.deepEqual(tree(store.root), ['other', 'other/SKILL.md', 'sample', 'sample/SKILL.md'])
    assert.deepEqual(store.install(zip({ 'old-skill/SKILL.md': skill })).conflicts, ['old-skill'])
    store.install(zip({ 'old-skill/SKILL.md': skill }), 'replace')
    assert.equal(store.detail('old-skill').kind, 'bundle')
    assert.equal(fs.existsSync(join(store.disabled, 'old-skill.md')), false)
    store.remove('sample')
    assert.throws(() => store.detail('sample'), /不存在/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('ZIP installation extracts every entry unchanged', () => {
  withStore(store => {
    const archive = zipSync({
      'skill_a/SKILL.MD': strToU8(skill), 'skill_a/reference/guide.md': strToU8('# Guide'), 'skill_a/.DS_Store': strToU8('x'), 'skill_a/empty/': new Uint8Array(),
      'skill_a/scripts/run.sh': [strToU8('echo 1\n'), { os: 3, attrs: 0o100755 << 16 }], 'skill_a/scripts/lib.sh': [strToU8('#!/bin/sh\n'), { os: 3, attrs: 0o100644 << 16 }],
      'Skill B/notes.txt': strToU8('No SKILL.md'), 'flat.md': strToU8('# No frontmatter'), 'LICENSE': strToU8('MIT'),
      '__MACOSX/skill_a/._SKILL.MD': strToU8('x'),
    })
    assert.deepEqual(store.install(archive), { installed: ['skill_a', 'Skill B', 'flat', 'LICENSE'], skipped: [], conflicts: [] })
    assert.deepEqual(tree(store.root), ['LICENSE', 'Skill B', 'Skill B/notes.txt', 'flat.md', 'skill_a', 'skill_a/.DS_Store', 'skill_a/SKILL.MD', 'skill_a/empty', 'skill_a/reference', 'skill_a/reference/guide.md', 'skill_a/scripts', 'skill_a/scripts/lib.sh', 'skill_a/scripts/run.sh'])
    assert.equal(fs.readFileSync(join(store.root, 'flat.md'), 'utf8'), '# No frontmatter')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(join(store.root, 'skill_a/scripts/run.sh')).mode & 0o111, 0o111)
      assert.equal(fs.statSync(join(store.root, 'skill_a/scripts/lib.sh')).mode & 0o111, 0)
    }
    assert.deepEqual(store.install(archive).conflicts, ['skill_a', 'Skill B', 'flat', 'LICENSE'])
    assert.deepEqual(store.install(archive, 'skip').skipped, ['skill_a', 'Skill B', 'flat', 'LICENSE'])
    assert.deepEqual(store.install(archive, 'replace').installed, ['skill_a', 'Skill B', 'flat', 'LICENSE'])
    assert.deepEqual(fs.readdirSync(store.disabled), [])
  })
  withStore(store => {
    // A root-level SKILL.md and its siblings land in the skills directory as they are.
    store.install(zip({ 'SKILL.md': skill, 'reference/guide.md': 'x' }))
    assert.deepEqual(tree(store.root), ['SKILL.md', 'reference', 'reference/guide.md'])
  })
  withStore(store => {
    // Backslash separators, and a UTF-8 entry name stored without the ZIP UTF-8 flag (macOS Archive Utility).
    const archive = Buffer.from(zip({ 'sample\\SKILL.md': skill, 'sample\\ref\\XXXXXX.md': 'x' }))
    const source = Buffer.from('XXXXXX'), target = Buffer.from('说明')
    for (let at = archive.indexOf(source); at >= 0; at = archive.indexOf(source, at + 1)) target.copy(archive, at)
    assert.deepEqual(store.install(archive).installed, ['sample'])
    assert.deepEqual(tree(store.root), ['sample', 'sample/SKILL.md', 'sample/ref', 'sample/ref/说明.md'])
  })
  withStore(store => {
    assert.throws(() => store.install(zip({ '__MACOSX/._x': 'x' })), /没有可解压的文件/)
    assert.throws(() => store.install(zip({ 'sample/SKILL.md': skill, 'sample.md': skill })), /重复技能名：sample/)
    assert.equal(fs.existsSync(store.root), false)
  })
})

test('skills with any folder name are listed and managed', () => {
  withStore(store => {
    store.install(zip({ 'skill_a/SKILL.md': skill, 'Skill B/SKILL.md': '# No frontmatter', 'docs/guide.md': 'x', '.hidden/SKILL.md': skill }))
    assert.deepEqual(store.list().skills.map(item => item.name), ['Skill B', 'skill_a'])
    assert.equal(store.read('Skill B', 'SKILL.md').text, '# No frontmatter')
    store.setEnabled('Skill B', false)
    assert.ok(fs.existsSync(join(store.disabled, 'Skill B', 'SKILL.md')))
    assert.deepEqual(store.install(zip({ 'Skill B/SKILL.md': skill })).conflicts, ['Skill B'])
    store.remove('Skill B')
    assert.deepEqual(store.list().skills.map(item => item.name), ['skill_a'])
  })
})

test('archive paths, duplicate names and source previews stay inside the selected skill', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dsh-skills-fence-'))
  try {
    const store = new SkillStore(home, [])
    for (const file of ['../escaped.md', '/absolute.md', 'C:/absolute.md', 'sample/../../escape.md', 'sample\\..\\..\\escape.md']) {
      assert.throws(() => store.install(zip({ 'sample/SKILL.md': skill, [file]: 'bad' })), /路径无效/)
    }
    assert.throws(() => store.install(zip({ 'Foo/SKILL.md': skill, 'foo/SKILL.md': skill })), /重复技能名：foo/)
    store.install(zip({ 'bundle/SKILL.md': skill, 'bundle/big.txt': 'x'.repeat(300000), 'bundle/binary': '\0' }))
    fs.writeFileSync(join(store.root, 'flat.md'), skill)
    fs.writeFileSync(join(store.root, 'other.md'), 'private')
    assert.throws(() => store.read('flat', 'other.md'), /路径/)
    assert.throws(() => store.read('bundle', '../other.md'), /路径/)
    for (const name of ['../bundle', 'a/b', 'a\\b', '.system', '', 'nul', 'trailing.']) assert.throws(() => store.remove(name), /技能名/)
    assert.equal(store.read('bundle', 'big.txt').text.length, 256 * 1024)
    assert.equal(store.read('bundle', 'big.txt').truncated, true)
    assert.throws(() => store.read('bundle', 'binary'), /二进制/)
    fs.mkdirSync(join(store.disabled, 'bundle'), { recursive: true })
    fs.writeFileSync(join(store.disabled, 'bundle', 'SKILL.md'), 'existing')
    assert.throws(() => store.setEnabled('bundle', false), /同名/)
    assert.equal(store.read('bundle', 'SKILL.md').text, skill)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
