import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import gauss from 'gaussdb-node'
import { keepTemporalText, type PgTypeParsers } from '../src/drivers/postgres.ts'

const clients: [string, () => PgTypeParsers][] = [
  ['pg', () => new pg.Client()],
  ['gaussdb-node', () => new (gauss as { Client: new () => PgTypeParsers }).Client()],
]

for (const [name, create] of clients) {
  test(`${name}: date, timestamp and interval values keep the server text`, () => {
    const client = create()
    keepTemporalText(client)
    // date, timestamp, timestamptz, interval
    assert.equal(client.getTypeParser(1082, 'text')('2026-01-02'), '2026-01-02')
    assert.equal(client.getTypeParser(1114, 'text')('2026-01-02 08:30:00'), '2026-01-02 08:30:00')
    assert.equal(client.getTypeParser(1184, 'text')('2026-01-02 00:30:00+00'), '2026-01-02 00:30:00+00')
    assert.equal(client.getTypeParser(1186, 'text')('1 day 02:03:04'), '1 day 02:03:04')
    assert.equal(client.getTypeParser(1082, 'text')('infinity'), 'infinity')
  })

  test(`${name}: arrays of them are arrays of the server text`, () => {
    const client = create()
    keepTemporalText(client)
    assert.deepEqual(client.getTypeParser(1182, 'text')('{2026-01-02,NULL,1999-12-31}'), ['2026-01-02', null, '1999-12-31'])
    assert.deepEqual(client.getTypeParser(1115, 'text')('{"2026-01-02 08:30:00.5"}'), ['2026-01-02 08:30:00.5'])
    assert.deepEqual(client.getTypeParser(1185, 'text')('{"2026-01-02 00:30:00+00"}'), ['2026-01-02 00:30:00+00'])
    assert.deepEqual(client.getTypeParser(1187, 'text')('{"1 day 02:03:04"}'), ['1 day 02:03:04'])
  })

  test(`${name}: the parsers belong to the connection; other types and other clients keep the defaults`, () => {
    const client = create()
    keepTemporalText(client)
    assert.equal(client.getTypeParser(23, 'text')('42'), 42)
    assert.equal(client.getTypeParser(16, 'text')('t'), true)
    assert.ok(create().getTypeParser(1082, 'text')('2026-01-02') instanceof Date)
  })
}
