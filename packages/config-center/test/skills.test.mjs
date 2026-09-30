import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import { SkillStore } from '../src/skills.ts'

const zip = entries => zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])))
const skill = '---\nname: sample\ndescription: Test skill\nmetadata:\n  version: "1.0"\n---\n# Sample\n'

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
    const archive = zip({ 'sample/SKILL.md': skill, 'sample/scripts/test.py': 'print(1)', 'flat.md': '# Flat\nBody' })
    assert.deepEqual(store.install(archive, 'collection.zip').installed.sort(), ['flat', 'sample'])
    const detail = store.detail('sample')
    assert.equal(detail.version, '1.0')
    assert.equal(detail.files.length, 2)
    assert.equal(store.read('sample', 'scripts/test.py').text, 'print(1)')
    const changed = zip({ 'sample/SKILL.md': '# Changed' })
    assert.deepEqual(store.install(changed, 'collection.zip').conflicts, ['sample'])
    assert.equal(store.read('sample', 'SKILL.md').text, skill)
    assert.deepEqual(store.install(changed, 'collection.zip', 'skip').skipped, ['sample'])
    store.setEnabled('sample', false)
    store.install(changed, 'collection.zip', 'replace')
    assert.equal(store.detail('sample').enabled, true)
    assert.equal(store.read('sample', 'SKILL.md').text, '# Changed')
    store.remove('sample')
    assert.throws(() => store.detail('sample'), /不存在/)
    assert.deepEqual(store.install(zip({ 'SKILL.md': skill }), 'Root Skill.zip').installed, ['root-skill'])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('archive paths, duplicate names and source previews stay inside the selected skill', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dsh-skills-fence-'))
  try {
    const store = new SkillStore(home, [])
    for (const file of ['../escaped.md', '/absolute.md', 'C:/absolute.md', 'sample/../../escape.md']) {
      assert.throws(() => store.install(zip({ 'sample/SKILL.md': skill, [file]: 'bad' }), 'test.zip'))
    }
    assert.throws(() => store.install(zip({ 'Foo/SKILL.md': skill, 'foo/SKILL.md': skill }), 'test.zip'), /重复/)
    store.install(zip({ 'flat.md': skill, 'other.md': 'private', 'bundle/SKILL.md': skill, 'bundle/big.txt': 'x'.repeat(300000), 'bundle/binary': '\0' }), 'test.zip')
    assert.throws(() => store.read('flat', 'other.md'), /路径/)
    assert.throws(() => store.read('bundle', '../other.md'), /路径/)
    assert.throws(() => store.remove('../bundle'), /技能名/)
    assert.equal(store.read('bundle', 'big.txt').text.length, 256 * 1024)
    assert.equal(store.read('bundle', 'big.txt').truncated, true)
    assert.throws(() => store.read('bundle', 'binary'), /二进制/)
    fs.mkdirSync(join(store.disabled, 'bundle'), { recursive: true })
    fs.writeFileSync(join(store.disabled, 'bundle', 'SKILL.md'), 'existing')
    assert.throws(() => store.setEnabled('bundle', false), /同名/)
    assert.equal(store.read('bundle', 'SKILL.md').text, skill)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
