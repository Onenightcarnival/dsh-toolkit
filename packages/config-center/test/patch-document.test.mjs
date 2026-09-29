import assert from 'node:assert/strict'
import test from 'node:test'
import { listMcp, parsePatch, PatchError, readSettings, removeMcp, renderPatch, upsertMcp, writeSettings } from '../src/patch-document.ts'

/** Patch as DeepSeek Harness Desktop leaves it: two marker-fenced blocks, then rows the host appended before the trailing marker. */
const DESKTOP = `# Your patch layer for this dsh profile.
# >>> dsh-desktop settings >>>
- id: goal
  config:
    defaultMaxGoalRounds: 5120
- id: compaction-basic
  disabled: false
# <<< dsh-desktop settings <<<
# >>> dsh-desktop mcp >>>
- insert:
    - id: mcp-time
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config:
        serverName: "time"
        transport: "stdio"
        command: "uvx"
        args:
          - "mcp-server-time"
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: "web"
        transport: "streamable-http"
        url: "http://127.0.0.1:8080/mcp"
        toolCallTimeoutMs: 120000
        headers:
          Authorization: !!js '\`Bearer \${process.env.MCP_TOKEN}\`'
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark

# <<< dsh-desktop mcp <<<
`

function edit(text, change) {
  const document = parsePatch(text)
  change(document)
  const out = renderPatch(document)
  parsePatch(out)
  return out
}

test('lists MCP servers with effective enablement and expressions', () => {
  const entries = listMcp(parsePatch(DESKTOP))
  assert.deepEqual(entries, [
    { id: 'mcp-time', server: { serverName: 'time', enabled: false, transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] } },
    { id: 'mcp-web', server: { serverName: 'web', enabled: true, transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: '!!js `Bearer ${process.env.MCP_TOKEN}`' } } },
  ])
})

test('blank, comment-only and flow-empty patches are the empty list', () => {
  for (const text of ['', '\n', '# only a comment\n', '[]\n']) assert.deepEqual(listMcp(parsePatch(text)), [])
})

test('a non-sequence patch is refused', () => {
  assert.throws(() => parsePatch('id: goal\n'), /YAML sequence/)
})

test('adding the first server to an empty flow list yields a block list', () => {
  const out = edit('# header\n[]\n', document => {
    assert.equal(upsertMcp(document, { serverName: 'fs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }), 'mcp-fs')
  })
  assert.match(out, /^# header\n- insert:\n/)
  assert.doesNotMatch(out, /\[\]/)
  assert.deepEqual(listMcp(parsePatch(out)), [
    { id: 'mcp-fs', server: { serverName: 'fs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } },
  ])
})

test('a new server joins the existing MCP insert list and leaves other rows as written', () => {
  const out = edit(DESKTOP, document => {
    upsertMcp(document, { serverName: 'gh', enabled: true, transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: '!!js process.env.GITHUB_TOKEN' } })
  })
  assert.deepEqual(listMcp(parsePatch(out)).map(entry => entry.id), ['mcp-time', 'mcp-web', 'mcp-gh'])
  assert.match(out, /GITHUB_TOKEN: !!js process\.env\.GITHUB_TOKEN/)
  assert.match(out, /- id: ui-theme\n {2}name: "@deepseek-ai\/dsh-client-ui-theme"\n {2}config:\n {4}preference: dark\n/)
  assert.match(out, /defaultMaxGoalRounds: 5120/)
  assert.equal(out.match(/- insert:/g).length, 1)
})

test('updating keeps fields outside the form and expressions', () => {
  const out = edit(DESKTOP, document => {
    const web = listMcp(document)[1]
    assert.equal(upsertMcp(document, { ...web.server, url: 'http://127.0.0.1:9090/mcp' }, web.id), 'mcp-web')
  })
  assert.match(out, /serverName: "web"\n {8}transport: "streamable-http"\n {8}url: http:\/\/127\.0\.0\.1:9090\/mcp\n/)
  assert.match(out, /toolCallTimeoutMs: 120000/)
  assert.match(out, /Authorization: !!js '`Bearer \$\{process\.env\.MCP_TOKEN\}`'/)
})

test('switching transport drops the other transport\'s fields', () => {
  const out = edit(DESKTOP, document => {
    upsertMcp(document, { serverName: 'time', enabled: true, transport: 'streamable-http', url: 'https://example.com/mcp' }, 'mcp-time')
  })
  const [time] = listMcp(parsePatch(out))
  assert.deepEqual(time.server, { serverName: 'time', enabled: true, transport: 'streamable-http', url: 'https://example.com/mcp' })
  assert.doesNotMatch(out, /uvx|mcp-server-time"/)
})

test('renaming re-addresses a derived id and drops overrides of the old id', () => {
  const source = `${DESKTOP}- id: mcp-time\n  disabled: false\n`
  assert.equal(listMcp(parsePatch(source))[0].server.enabled, true)
  const out = edit(source, document => {
    assert.equal(upsertMcp(document, { serverName: 'clock', enabled: false, transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] }, 'mcp-time'), 'mcp-clock')
  })
  assert.doesNotMatch(out, /mcp-time/)
  assert.deepEqual(listMcp(parsePatch(out))[0], { id: 'mcp-clock', server: { serverName: 'clock', enabled: false, transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] } })
})

test('a hand-chosen id survives a rename', () => {
  const source = `- insert:\n    - id: clock\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: time\n        transport: stdio\n        command: uvx\n`
  const out = edit(source, document => {
    assert.equal(upsertMcp(document, { serverName: 'time2', enabled: true, transport: 'stdio', command: 'uvx' }, 'clock'), 'clock')
  })
  assert.equal(listMcp(parsePatch(out))[0].server.serverName, 'time2')
})

test('enablement set in the form replaces override rows', () => {
  const source = `${DESKTOP}- id: mcp-web\n  disabled: true\n`
  assert.equal(listMcp(parsePatch(source))[1].server.enabled, false)
  const out = edit(source, document => {
    const web = listMcp(document)[1]
    upsertMcp(document, { ...web.server, enabled: true }, web.id)
  })
  assert.equal(listMcp(parsePatch(out))[1].server.enabled, true)
  assert.doesNotMatch(out, /- id: mcp-web\n {2}disabled/)
})

test('duplicate names, duplicate ids and unknown ids are refused', () => {
  const issue = (change) => {
    try { change(parsePatch(DESKTOP)) } catch (error) {
      assert.ok(error instanceof PatchError)
      return error.issue
    }
    return undefined
  }
  assert.equal(issue(document => upsertMcp(document, { serverName: 'web', enabled: true, transport: 'stdio', command: 'x' })), 'duplicate-name')
  assert.equal(issue(document => upsertMcp(document, { serverName: 'web', enabled: true, transport: 'stdio', command: 'x' }, 'mcp-time')), 'duplicate-name')
  assert.equal(issue(document => upsertMcp(document, { serverName: 'x', enabled: true, transport: 'stdio', command: 'x' }, 'mcp-none')), 'missing')
  assert.equal(issue(document => removeMcp(document, 'ui-theme')), 'missing')
  const taken = `- insert:\n    - id: mcp-x\n      name: other-plugin\n`
  assert.throws(() => upsertMcp(parsePatch(taken), { serverName: 'x', enabled: true, transport: 'stdio', command: 'x' }), error => error.issue === 'duplicate-id')
})

test('removing servers keeps foreign rows; the emptied insert list goes', () => {
  const out = edit(DESKTOP, document => {
    removeMcp(document, 'mcp-time')
    removeMcp(document, 'mcp-web')
  })
  assert.deepEqual(listMcp(parsePatch(out)), [])
  assert.doesNotMatch(out, /insert/)
  assert.match(out, /- id: ui-theme/)
  assert.match(out, /defaultMaxGoalRounds: 5120/)
})

test('removing the last row of a patch leaves the empty list', () => {
  const source = `- insert:\n    - id: mcp-a\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: a\n        transport: stdio\n        command: x\n`
  const out = edit(source, document => removeMcp(document, 'mcp-a'))
  assert.equal(out.trim(), '[]')
})

test('an insert list shared with other plugins keeps them', () => {
  const source = `- insert:\n    - id: other\n      name: other-plugin\n    - id: mcp-a\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: a\n        transport: stdio\n        command: x\n`
  const out = edit(source, document => removeMcp(document, 'mcp-a'))
  assert.match(out, /- id: other\n {6}name: other-plugin/)
})

test('reads setting overrides; later rows win; invalid values are ignored', () => {
  assert.deepEqual(readSettings(parsePatch(DESKTOP)), { goalMaxRounds: 5120, compactionEnabled: true })
  const source = `- id: goal\n  config:\n    defaultMaxGoalRounds: 10\n- id: goal\n  config:\n    defaultMaxGoalRounds: 20\n- id: compaction-basic\n  config:\n    thresholdRatio: 7\n`
  assert.deepEqual(readSettings(parsePatch(source)), { goalMaxRounds: 20 })
})

test('writes settings onto existing rows and creates missing ones', () => {
  const out = edit(DESKTOP, document => writeSettings(document, { goalMaxRounds: 64, compactionThreshold: 0.7 }))
  assert.deepEqual(readSettings(parsePatch(out)), { goalMaxRounds: 64, compactionEnabled: true, compactionThreshold: 0.7 })
  assert.match(out, /- id: compaction-basic\n {2}disabled: false\n {2}config:\n {4}thresholdRatio: 0\.7\n/)
  assert.equal(out.match(/- id: goal/g).length, 1)
  const created = edit('[]\n', document => writeSettings(document, { compactionEnabled: true }))
  assert.equal(created, '- id: compaction-basic\n  disabled: false\n')
})

test('null removes an override, keeps sibling keys and prunes emptied rows', () => {
  const source = `- id: goal\n  config:\n    defaultMaxGoalRounds: 10\n    other: 1\n- id: compaction-basic\n  disabled: false\n  config:\n    thresholdRatio: 0.5\n`
  const out = edit(source, document => writeSettings(document, { goalMaxRounds: null, compactionEnabled: null, compactionThreshold: null }))
  assert.equal(out, '- id: goal\n  config:\n    other: 1\n')
  assert.deepEqual(readSettings(parsePatch(out)), {})
})

test('keys absent from the submitted values are untouched', () => {
  const out = edit(DESKTOP, document => writeSettings(document, { compactionThreshold: 0.6 }))
  assert.deepEqual(readSettings(parsePatch(out)), { goalMaxRounds: 5120, compactionEnabled: true, compactionThreshold: 0.6 })
})

test('an edit that changes nothing reproduces the text', () => {
  assert.equal(renderPatch(parsePatch(DESKTOP)), DESKTOP)
})

test('long scalars stay on one line', () => {
  const path = `/${'segment/'.repeat(20)}server.mjs`
  const out = edit('[]\n', document => upsertMcp(document, { serverName: 'long', enabled: true, transport: 'stdio', command: 'node', args: [path] }))
  assert.ok(out.includes(`- ${path}\n`))
})
