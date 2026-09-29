import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/client/capacity.ts', import.meta.url))], bundle: true, write: false, format: 'esm' })
const { parseCapacity, formatCapacity } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('capacities follow DSH decimal K/M syntax and round-trip without losing tokens', () => {
  for (const [text, expected] of [['1M', 1_000_000], ['256K', 256_000], [' 1.5m ', 1_500_000], ['256k', 256_000], ['272000', 272_000], ['0.001K', 1], ['1.001K', 1001]]) {
    assert.equal(parseCapacity(text), expected)
    assert.equal(parseCapacity(formatCapacity(expected)), expected)
  }
  assert.equal(parseCapacity(' '), undefined)
  for (const text of ['abc', '1MB', '1e6', '-1', '256 K', '1,000,000']) assert.ok(Number.isNaN(parseCapacity(text)))
  assert.equal(parseCapacity('0'), 0, 'positive-integer validation belongs to the field')
  assert.equal(parseCapacity('1.5'), 1.5, 'fractional tokens remain invalid rather than being rounded')
  assert.equal(formatCapacity(1_000_000), '1M')
  assert.equal(formatCapacity(256_000), '256K')
  assert.equal(formatCapacity(1001), '1001')
})
