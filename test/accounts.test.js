import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAccountsReport } from '../src/services/accounts.js'

const from = new Date('2026-10-01T00:00:00Z')
const to = new Date('2026-10-10T23:59:59Z')
const base = { createdAt: '2026-10-05T10:00:00Z', status: 'delivered', paymentMethod: 'online', paymentStatus: 'paid', refundedAmount: 0 }
const item = (over = {}) => ({ product: 'p1', productNameSnapshot: 'Yarn', quantity: 2, lineTotalAmount: 10000, costAmountSnapshot: 3000, ...over })

test('revenue excludes tax, profit subtracts purchasing cost', () => {
  const report = buildAccountsReport([{ ...base, subtotalAmount: 10000, discountAmount: 1000, shippingAmount: 800, taxAmount: 450, totalAmount: 10250, items: [item()] }], { from, to })
  assert.equal(report.totals.netRevenue, 9800) // 10000 - 1000 + 800
  assert.equal(report.totals.tax, 450)
  assert.equal(report.totals.cogs, 6000)
  assert.equal(report.totals.profit, 3800)
  assert.equal(report.totals.billed, 10250)
  assert.equal(report.cash.received, 10250)
})

test('cancelled orders are ignored', () => {
  const report = buildAccountsReport([{ ...base, status: 'cancelled', subtotalAmount: 1, discountAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 1, items: [] }], { from, to })
  assert.equal(report.totals.orders, 0)
})

test('cash-on-delivery orders count as sales but are outstanding until paid', () => {
  const report = buildAccountsReport([{ ...base, status: 'shipped', paymentMethod: 'cod', paymentStatus: 'pending', subtotalAmount: 5000, discountAmount: 0, shippingAmount: 0, taxAmount: 250, totalAmount: 5250, items: [item({ quantity: 1, lineTotalAmount: 5000 })] }], { from, to })
  assert.equal(report.totals.netRevenue, 5000)
  assert.equal(report.cash.received, 0)
  assert.equal(report.cash.outstandingCod, 5250)
  assert.equal(report.byMethod.cod.orders, 1)
})

test('refunds reduce revenue and tax in proportion; full refunds return the goods', () => {
  const partial = buildAccountsReport([{ ...base, paymentStatus: 'partially_refunded', refundedAmount: 5250, subtotalAmount: 10000, discountAmount: 0, shippingAmount: 0, taxAmount: 500, totalAmount: 10500, items: [item()] }], { from, to })
  assert.equal(partial.totals.netRevenue, 5000)
  assert.equal(partial.totals.tax, 250)
  assert.equal(partial.cash.received, 5250)
  const full = buildAccountsReport([{ ...base, status: 'refunded', paymentStatus: 'refunded', refundedAmount: 10500, subtotalAmount: 10000, discountAmount: 0, shippingAmount: 0, taxAmount: 500, totalAmount: 10500, items: [item()] }], { from, to })
  assert.equal(full.totals.netRevenue, 0)
  assert.equal(full.totals.cogs, 0)
  assert.equal(full.totals.profit, 0)
})

test('items sold before cost tracking are flagged, not guessed', () => {
  const report = buildAccountsReport([{ ...base, subtotalAmount: 2000, discountAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 2000, items: [item({ costAmountSnapshot: undefined, quantity: 1, lineTotalAmount: 2000 })] }], { from, to })
  assert.equal(report.itemsMissingCost, 1)
})

test('series is bucketed by day and top products ranked by profit', () => {
  const orders = [
    { ...base, subtotalAmount: 10000, discountAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 10000, items: [item()] },
    { ...base, createdAt: '2026-10-06T10:00:00Z', subtotalAmount: 4000, discountAmount: 0, shippingAmount: 0, taxAmount: 0, totalAmount: 4000, items: [item({ product: 'p2', productNameSnapshot: 'Beads', quantity: 1, lineTotalAmount: 4000, costAmountSnapshot: 3900 })] },
  ]
  const report = buildAccountsReport(orders, { from, to })
  assert.equal(report.range.bucket, 'day')
  assert.equal(report.series.find((point) => point.date === '2026-10-05').revenue, 10000)
  assert.equal(report.topProducts[0].name, 'Yarn')
})
