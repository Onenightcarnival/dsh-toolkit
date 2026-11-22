import test from 'node:test'
import assert from 'node:assert/strict'
import { buildChanges, cellText, rowId, rowKey, withCellEdit, type PendingUpdate, type RowKey } from '../src/client/pending.ts'

const columns = new Map([['id', 0], ['label', 1], ['tenant', 2]])

test('rowKey reads the primary key of a row; rows that cannot be addressed have none', () => {
  assert.deepEqual(rowKey(['id'], columns, [6, 'item-6', 'a']), { id: 6 })
  assert.deepEqual(rowKey(['tenant', 'id'], columns, [6, 'item-6', 'a']), { tenant: 'a', id: 6 })
  assert.deepEqual(rowKey(['id'], columns, [false, 'x', 'a']), { id: false })
  // No primary key, a key column outside the result, a null key, a binary key placeholder.
  assert.equal(rowKey([], columns, [6, 'item-6', 'a']), undefined)
  assert.equal(rowKey(['missing'], columns, [6, 'item-6', 'a']), undefined)
  assert.equal(rowKey(['id'], columns, [null, 'item-6', 'a']), undefined)
  assert.equal(rowKey(['id'], columns, [{ $bytes: 16 }, 'item-6', 'a']), undefined)
  assert.equal(rowKey(['id'], columns, []), undefined)
})

test('rowId follows the key values in primary-key order and keeps a number apart from its digits', () => {
  assert.equal(rowId(['tenant', 'id'], { id: 6, tenant: 'a' }), rowId(['tenant', 'id'], { tenant: 'a', id: 6 }))
  assert.notEqual(rowId(['id'], { id: 6 }), rowId(['id'], { id: '6' }))
  assert.notEqual(rowId(['tenant', 'id'], { tenant: 'a', id: 6 }), rowId(['tenant', 'id'], { tenant: 'a6', id: '' }))
})

test('withCellEdit keeps changed cells only and drops a row whose cells are all back to the stored value', () => {
  const key: RowKey = { id: 6 }
  const id = rowId(['id'], key)
  let updates = new Map<string, PendingUpdate>()
  updates = withCellEdit(updates, id, key, 'label', 'renamed', 'item-6')
  updates = withCellEdit(updates, id, key, 'tenant', null, 'a')
  assert.deepEqual(updates.get(id), { key, values: { label: 'renamed', tenant: null } })
  // The same text as stored is no change; null and the empty string are different values.
  updates = withCellEdit(updates, id, key, 'label', 'item-6', 'item-6')
  assert.deepEqual(updates.get(id)?.values, { tenant: null })
  updates = withCellEdit(updates, id, key, 'tenant', 'a', 'a')
  assert.equal(updates.has(id), false)
  assert.equal(withCellEdit(new Map(), id, key, 'tenant', '', null).has(id), true)
  assert.equal(withCellEdit(new Map(), id, key, 'tenant', null, null).has(id), false)
  // A number typed back as its digits is no change.
  assert.equal(withCellEdit(new Map(), id, key, 'id', '6', 6).has(id), false)
  // The input map is left as it was.
  const before = new Map<string, PendingUpdate>([[id, { key, values: { label: 'x' } }]])
  withCellEdit(before, id, key, 'label', 'y', 'item-6')
  assert.deepEqual(before.get(id)?.values, { label: 'x' })
})

test('buildChanges addresses every row by the key captured with the change, whatever page is on screen', () => {
  // Edits made on page 1 (ids 6 and 51) and a delete (id 7); the grid now shows ids 101–130.
  const primaryKey = ['id']
  let updates = new Map<string, PendingUpdate>()
  for (const [id, label] of [[6, 'EDIT-A'], [51, 'EDIT-B']] as const) {
    const key = rowKey(primaryKey, columns, [id, `item-${String(id)}`, 'a'])
    assert.ok(key)
    updates = withCellEdit(updates, rowId(primaryKey, key), key, 'label', label, `item-${String(id)}`)
  }
  const deletes = new Map([[rowId(primaryKey, { id: 7 }), { id: 7 }]])
  assert.deepEqual(buildChanges(updates, [{ label: 'new row' }], deletes), [
    { kind: 'update', key: { id: 6 }, values: { label: 'EDIT-A' } },
    { kind: 'update', key: { id: 51 }, values: { label: 'EDIT-B' } },
    { kind: 'insert', values: { label: 'new row' } },
    { kind: 'delete', key: { id: 7 } },
  ])
  // A row that is both edited and marked for deletion is deleted only.
  const both = new Map([...deletes, [rowId(primaryKey, { id: 6 }), { id: 6 }]])
  assert.deepEqual(buildChanges(updates, [], both).map(change => [change.kind, 'key' in change ? change.key.id : undefined]), [['update', 51], ['delete', 7], ['delete', 6]])
  assert.deepEqual(buildChanges(new Map(), [], new Map()), [])
})

test('cellText shows scalars as written and objects as JSON', () => {
  assert.deepEqual([cellText('a'), cellText(1.5), cellText(false), cellText(null), cellText(undefined), cellText({ $bytes: 3 }), cellText([1, 'b'])], ['a', '1.5', 'false', '', '', '{"$bytes":3}', '[1,"b"]'])
})
