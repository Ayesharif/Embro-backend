// All money is handled as integer minor units (cents). Nothing here touches the database,
// which keeps the maths unit-testable and guarantees the server is the single source of truth.

// A variant is the sellable unit: it carries its own selling price, discount, stock, colour and size.
export function variantFinalAmount(variant) {
  return Math.max(0, Math.round(variant.sellingAmount * (1 - (variant.discountPercent || 0) / 100)))
}

export function variantLabel(variant) {
  return [variant.color, variant.size].filter(Boolean).join(' / ') || 'Standard'
}

export const unitAmount = variantFinalAmount

export function discountAmount(discount, subtotal) {
  if (!discount) return 0
  if (subtotal < (discount.minimumOrderAmount || 0)) return 0
  const raw = discount.type === 'percentage' ? Math.round((subtotal * discount.value) / 100) : discount.value
  return Math.max(0, Math.min(raw, subtotal))
}

export function computeTotals({ lines, shippingAmount = 0, discount = null, taxRate = 0 }) {
  const subtotalAmount = lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0)
  const discountTotal = discountAmount(discount, subtotalAmount)
  const taxAmount = Math.round((subtotalAmount - discountTotal) * taxRate)
  const totalAmount = subtotalAmount - discountTotal + shippingAmount + taxAmount
  return { subtotalAmount, discountAmount: discountTotal, shippingAmount, taxAmount, totalAmount }
}
