// Pure accounting maths over a list of orders (no database access), so it can be unit-tested.
//
// Basis used throughout:
//  - cancelled orders are ignored; everything else counts when it is placed (accrual basis)
//  - net revenue = items - discounts + shipping, excluding tax, reduced by any refunded share
//  - tax is shown separately: it is owed to the tax authority, not income
//  - cost of goods = purchasing cost recorded on each item when it was sold; a fully refunded order
//    is assumed to have its goods returned (no cost)
//  - profit = net revenue - cost of goods (your own overheads, courier costs and payment fees are not included)

const RECEIVED = ['paid', 'partially_refunded', 'refunded']

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

export function buildAccountsReport(orders, { from, to, timeZone = 'UTC' }) {
  const spanDays = Math.max(1, Math.ceil((to - from) / 86_400_000))
  const bucket = spanDays > 92 ? 'month' : 'day'
  const totals = {
    orders: 0, itemsSold: 0, grossSales: 0, discounts: 0, shipping: 0, netRevenue: 0, tax: 0,
    refunds: 0, refundedOrders: 0, cogs: 0, profit: 0,
  }
  const cash = { received: 0, outstandingCod: 0, outstandingCodOrders: 0 }
  const byMethod = { online: { orders: 0, revenue: 0 }, cod: { orders: 0, revenue: 0 } }
  const series = new Map()
  const products = new Map()
  let itemsMissingCost = 0

  if (bucket === 'day') {
    for (let time = from.getTime(); time <= to.getTime() + 86_400_000; time += 86_400_000) {
      const key = dayKey(new Date(time), timeZone)
      if (!series.has(key)) series.set(key, { date: key, revenue: 0, profit: 0, orders: 0 })
    }
  }

  for (const order of orders) {
    if (order.status === 'cancelled') continue
    const total = order.totalAmount || 0
    const refunded = Math.min(order.refundedAmount || 0, total)
    const keep = total > 0 ? 1 - refunded / total : 1
    const fullyRefunded = order.status === 'refunded'

    const revenue = Math.round(((order.subtotalAmount || 0) - (order.discountAmount || 0) + (order.shippingAmount || 0)) * keep)
    let cogs = 0
    for (const item of order.items || []) {
      if (item.costAmountSnapshot == null) itemsMissingCost += item.quantity || 0
      else if (!fullyRefunded) cogs += item.costAmountSnapshot * item.quantity

      const lineRevenue = Math.round((item.lineTotalAmount || 0) * keep)
      const lineCost = item.costAmountSnapshot == null || fullyRefunded ? 0 : item.costAmountSnapshot * item.quantity
      const key = String(item.product)
      const entry = products.get(key) || { id: key, name: item.productNameSnapshot, units: 0, revenue: 0, profit: 0 }
      entry.units += fullyRefunded ? 0 : item.quantity
      entry.revenue += lineRevenue
      entry.profit += lineRevenue - lineCost
      products.set(key, entry)
      totals.itemsSold += fullyRefunded ? 0 : item.quantity
    }

    totals.orders += 1
    totals.grossSales += order.subtotalAmount || 0
    totals.discounts += order.discountAmount || 0
    totals.shipping += order.shippingAmount || 0
    totals.netRevenue += revenue
    totals.tax += Math.round((order.taxAmount || 0) * keep)
    totals.refunds += refunded
    if (refunded > 0) totals.refundedOrders += 1
    totals.cogs += cogs
    totals.profit += revenue - cogs

    const method = order.paymentMethod === 'cod' ? 'cod' : 'online'
    byMethod[method].orders += 1
    byMethod[method].revenue += revenue

    if (RECEIVED.includes(order.paymentStatus)) cash.received += total - refunded
    if (order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
      cash.outstandingCod += total
      cash.outstandingCodOrders += 1
    }

    const day = dayKey(new Date(order.createdAt), timeZone)
    const key = bucket === 'month' ? day.slice(0, 7) : day
    const point = series.get(key) || { date: key, revenue: 0, profit: 0, orders: 0 }
    point.revenue += revenue
    point.profit += revenue - cogs
    point.orders += 1
    series.set(key, point)
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString(), bucket, timeZone },
    totals: {
      ...totals,
      billed: totals.netRevenue + totals.tax,
      margin: totals.netRevenue > 0 ? Math.round((totals.profit / totals.netRevenue) * 10000) / 10000 : 0,
      averageOrderValue: totals.orders ? Math.round(totals.netRevenue / totals.orders) : 0,
    },
    cash,
    byMethod,
    series: [...series.values()].sort((a, b) => a.date.localeCompare(b.date)),
    topProducts: [...products.values()].sort((a, b) => b.profit - a.profit).slice(0, 5),
    itemsMissingCost,
  }
}
