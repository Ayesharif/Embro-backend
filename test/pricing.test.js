import test from 'node:test'
import assert from 'node:assert/strict'
import { computeTotals, discountAmount, unitAmount, variantFinalAmount, variantLabel } from '../src/utils/pricing.js'

test('variant price applies its own discount', () => {
  assert.equal(variantFinalAmount({ sellingAmount: 5000, discountPercent: 10 }), 4500)
  assert.equal(unitAmount({ sellingAmount: 999 }), 999)
})

test('variant label combines colour and size', () => {
  assert.equal(variantLabel({ color: 'Red', size: 'L' }), 'Red / L')
  assert.equal(variantLabel({ color: 'Red' }), 'Red')
  assert.equal(variantLabel({}), 'Standard')
})

test('discountAmount respects minimum order and never exceeds subtotal', () => {
  assert.equal(discountAmount({ type: 'percentage', value: 10, minimumOrderAmount: 5000 }, 4000), 0)
  assert.equal(discountAmount({ type: 'percentage', value: 10 }, 4000), 400)
  assert.equal(discountAmount({ type: 'fixed', value: 9000 }, 4000), 4000)
})

test('computeTotals is integer-only and taxes after discount', () => {
  const totals = computeTotals({ lines: [{ unitAmount: 1999, quantity: 2 }], shippingAmount: 800, discount: { type: 'fixed', value: 500 }, taxRate: 0.05 })
  assert.deepEqual(totals, { subtotalAmount: 3998, discountAmount: 500, shippingAmount: 800, taxAmount: 175, totalAmount: 4473 })
})
