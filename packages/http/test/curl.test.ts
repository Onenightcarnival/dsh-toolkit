import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCurl, splitQuery, toCurl, tokenize } from '../src/client/curl.ts'

test('tokenize: quotes, ANSI-C strings, escapes and line continuations', () => {
  assert.deepEqual(tokenize(`curl 'a b' "c \\"d\\" $e" f\\ g $'h\\ni\\x41\\'' \\\n  -X POST ''`), ['curl', 'a b', 'c "d" $e', 'f g', "h\niA'", '-X', 'POST', ''])
  assert.deepEqual(tokenize('  '), [])
})

test('parseCurl: browser "Copy as cURL" with headers, compressed flag and JSON body', () => {
  const parsed = parseCurl(`curl 'https://api.example.com/v1/users?page=2' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer abc.def' \\
  -H 'content-type: application/json' \\
  --data-raw '{"name":"alice","tags":["a","b"]}' \\
  --compressed`)
  assert.ok(parsed)
  assert.equal(parsed.method, 'POST')
  assert.equal(parsed.url, 'https://api.example.com/v1/users?page=2')
  assert.deepEqual(parsed.headers, [['accept', 'application/json'], ['authorization', 'Bearer abc.def'], ['content-type', 'application/json']])
  assert.equal(parsed.bodyKind, 'raw')
  assert.equal(parsed.body, '{"name":"alice","tags":["a","b"]}')
})

test('parseCurl: methods, attached short values, clustered flags, user, cookie, agent', () => {
  const parsed = parseCurl(`curl -sSL -XPUT -H'X-A: 1' -u alice:s3cret -A 'ua/1' -e https://ref.example -b 'sid=1; t=2' -o out.json -m 10 https://x.test/a`)
  assert.ok(parsed)
  assert.equal(parsed.method, 'PUT')
  assert.equal(parsed.url, 'https://x.test/a')
  assert.deepEqual(parsed.headers, [['X-A', '1'], ['User-Agent', 'ua/1'], ['Referer', 'https://ref.example'], ['Cookie', 'sid=1; t=2']])
  assert.deepEqual(parsed.basic, { username: 'alice', password: 's3cret' })
  assert.equal(parsed.bodyKind, 'none')
  assert.equal(parseCurl('curl -I https://x.test')?.method, 'HEAD')
  assert.equal(parseCurl('curl -X PROPFIND https://x.test')?.method, 'GET')
  assert.equal(parseCurl('curl --request=DELETE --url=https://x.test/1')?.method, 'DELETE')
  assert.deepEqual(parseCurl(`curl --oauth2-bearer tok https://x.test`)?.headers, [['Authorization', 'Bearer tok']])
})

test('parseCurl: data forms — urlencoded fields, -G, --data-urlencode, --json, raw without header, multipart', () => {
  const form = parseCurl(`curl https://x.test/login -d 'user=alice' -d 'pass=a%20b'`)
  assert.equal(form?.method, 'POST')
  assert.equal(form?.bodyKind, 'form')
  assert.deepEqual(form?.fields, [['user', 'alice'], ['pass', 'a b']])

  const get = parseCurl(`curl -G https://x.test/search?a=1 --data-urlencode 'q=hello world' -d 'n=2'`)
  assert.equal(get?.method, 'GET')
  assert.equal(get?.url, 'https://x.test/search?a=1&q=hello%20world&n=2')
  assert.equal(get?.bodyKind, 'none')

  const json = parseCurl(`curl --json '{"a":1}' https://x.test`)
  assert.equal(json?.bodyKind, 'raw')
  assert.equal(json?.body, '{"a":1}')
  assert.deepEqual(json?.headers, [['Content-Type', 'application/json'], ['Accept', 'application/json']])

  const raw = parseCurl(`curl -d '{"a": 1}' https://x.test`)
  assert.equal(raw?.bodyKind, 'raw')
  assert.deepEqual(raw?.headers, [['Content-Type', 'application/x-www-form-urlencoded']])

  const multipart = parseCurl(`curl -F 'name=alice' -F 'file=@a.png' https://x.test/upload`)
  assert.equal(multipart?.multipart, true)
  assert.equal(multipart?.bodyKind, 'form')
  assert.deepEqual(multipart?.fields, [['name', 'alice'], ['file', '@a.png']])
})

test('parseCurl: not a curl command, or no URL', () => {
  assert.equal(parseCurl('https://x.test'), undefined)
  assert.equal(parseCurl('curl -s'), undefined)
  assert.equal(parseCurl('wget https://x.test'), undefined)
})

test('splitQuery decodes pairs and keeps repeated names', () => {
  assert.deepEqual(splitQuery('/users?ids=1&ids=2&q=a+b%20c&flag&bad=%E0'), { path: '/users', pairs: [['ids', '1'], ['ids', '2'], ['q', 'a b c'], ['flag', ''], ['bad', '%E0']] })
  assert.deepEqual(splitQuery('/users'), { path: '/users', pairs: [] })
  assert.deepEqual(splitQuery('https://x.test/a?{{k}}=1'), { path: 'https://x.test/a', pairs: [['{{k}}', '1']] })
})

test('toCurl writes a command parseCurl reads back', () => {
  const command = toCurl({ method: 'POST', url: "https://x.test/a?b=it's", headers: [['Content-Type', 'application/json'], ['X-Q', "it's"]], body: '{"a":"it\'s"}' })
  assert.equal(command, `curl -X POST 'https://x.test/a?b=it'\\''s' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Q: it'\\''s' \\\n  --data-raw '{"a":"it'\\''s"}'`)
  const back = parseCurl(command)
  assert.equal(back?.method, 'POST')
  assert.equal(back?.url, "https://x.test/a?b=it's")
  assert.deepEqual(back?.headers, [['Content-Type', 'application/json'], ['X-Q', "it's"]])
  assert.equal(back?.body, '{"a":"it\'s"}')
  assert.equal(toCurl({ method: 'GET', url: 'https://x.test', headers: [] }), `curl 'https://x.test'`)
})
