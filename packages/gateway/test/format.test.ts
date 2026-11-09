import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCompact } from '../src/client/format.ts'

test('compact numbers: exact below 1000, K/M/B above with up to three significant digits', () => {
  assert.equal(formatCompact(0), '0')
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(1000), '1K')
  assert.equal(formatCompact(1234), '1.23K')
  assert.equal(formatCompact(12_345), '12.3K')
  assert.equal(formatCompact(123_456), '123K')
  assert.equal(formatCompact(999_950), '1M')
  assert.equal(formatCompact(1_000_000), '1M')
  assert.equal(formatCompact(5_600_000), '5.6M')
  assert.equal(formatCompact(2_500_000_000), '2.5B')
})
