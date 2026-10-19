import test from 'node:test'
import assert from 'node:assert/strict'
import { currencyInfo, formatMoney, isSupportedCurrency, supportedCurrencies } from '../src/config/currencies.js'
import { convertAmount, convertVariantPrices } from '../src/services/currencyConversion.js'

test('PKR is supported and formats compactly', () => {
  assert.ok(isSupportedCurrency('pkr'))
  assert.equal(currencyInfo('PKR').compact, true)
  assert.match(formatMoney(140000, 'PKR'), /1,400$/)
  assert.doesNotMatch(formatMoney(140000, 'PKR'), /\.00/)
  assert.match(formatMoney(140050, 'PKR'), /1,400\.50$/)
  assert.equal(formatMoney(1999, 'USD'), '$19.99')
  assert.ok(supportedCurrencies().every((currency) => currency.symbol))
})

test('convertAmount applies the rate and rounding step', () => {
  // $14.99 at 280 PKR/USD = Rs 4,197.20
  assert.equal(convertAmount(1499, 280), 419720)
  assert.equal(convertAmount(1499, 280, '1'), 419700)
  assert.equal(convertAmount(1499, 280, '10'), 420000)
  assert.equal(convertAmount(1499, 280, '50'), 420000)
  assert.equal(convertAmount(1499, 280, '100'), 420000)
})

test('conversion never turns a priced item into a free one', () => {
  assert.equal(convertAmount(10, 1, '100'), 10000)
  assert.equal(convertAmount(0, 280, '100'), 0)
})

test('selling price is rounded but purchasing cost stays exact', () => {
  assert.deepEqual(convertVariantPrices({ sellingAmount: 1499, costAmount: 800 }, 280.5, '50'), { sellingAmount: 420000, costAmount: 224400 })
})

test('converting there and back is close to the original', () => {
  const there = convertAmount(5000, 278.35)
  const back = convertAmount(there, 1 / 278.35)
  assert.ok(Math.abs(back - 5000) <= 1)
})
