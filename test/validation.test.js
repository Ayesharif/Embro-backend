import test from 'node:test'
import assert from 'node:assert/strict'
import { parse, v } from '../src/utils/validation.js'

test('strings reject objects (NoSQL operator injection)', () => {
  assert.throws(() => parse({ email: v.email() }, { email: { $ne: '' } }), { code: 'VALIDATION_ERROR' })
})

test('email is trimmed and lowercased', () => {
  assert.equal(parse({ email: v.email() }, { email: '  Me@Example.COM ' }).email, 'me@example.com')
})

test('password rules', () => {
  assert.throws(() => parse({ p: v.password() }, { p: 'short' }))
  assert.throws(() => parse({ p: v.password() }, { p: 'password123' }))
  assert.throws(() => parse({ p: v.password() }, { p: 'x'.repeat(80) }))
  assert.equal(parse({ p: v.password() }, { p: 'a-good-passphrase' }).p, 'a-good-passphrase')
})

test('unknown keys are dropped (mass assignment)', () => {
  const out = parse({ name: v.string() }, { name: 'A', role: 'super_admin', status: 'paid' })
  assert.deepEqual(out, { name: 'A' })
})

test('integer does not coerce unless asked', () => {
  assert.throws(() => parse({ n: v.integer() }, { n: '5' }))
  assert.equal(parse({ n: v.integer({ coerce: true }) }, { n: '5' }).n, 5)
  assert.throws(() => parse({ n: v.integer() }, { n: 1.5 }))
})

test('objectId only accepts 24 hex characters', () => {
  assert.throws(() => parse({ id: v.objectId() }, { id: '123456789012' }))
  assert.equal(parse({ id: v.objectId() }, { id: 'a'.repeat(24) }).id, 'a'.repeat(24))
})
