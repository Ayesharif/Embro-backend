import mongoose from 'mongoose'
import Discount from '../models/Discount.js'
import Product from '../models/Product.js'
import Setting from '../models/Setting.js'
import ShippingMethod from '../models/ShippingMethod.js'
import CheckoutQuote from '../models/CheckoutQuote.js'
import { onCurrencyChange } from '../cache/namespaces.js'
import { clearSettingsCache, getSettings } from './settings.js'

export const ROUNDINGS = ['none', '1', '10', '50', '100']

// Converts an amount in minor units. `rounding` is a step in whole currency units
// (e.g. "50" rounds Rs 1,423 to Rs 1,400), or "none" to keep to the nearest minor unit.
export function convertAmount(minorUnits, rate, rounding = 'none') {
  const raw = minorUnits * rate
  if (rounding === 'none') return Math.max(0, Math.round(raw))
  const step = Number(rounding) * 100
  const rounded = Math.round(raw / step) * step
  // A priced item must never round down to free.
  return minorUnits > 0 && rounded === 0 ? step : Math.max(0, rounded)
}

// Selling prices follow the chosen rounding; purchasing cost stays exact so margins stay honest.
export function convertVariantPrices(variant, rate, rounding) {
  return {
    sellingAmount: convertAmount(variant.sellingAmount, rate, rounding),
    costAmount: convertAmount(variant.costAmount, rate, 'none'),
  }
}

export async function previewConversion({ rate, rounding }) {
  const [products, shipping, discounts, settings] = await Promise.all([
    Product.find({ status: { $ne: 'archived' } }).select('name variants').lean(),
    ShippingMethod.find().lean(),
    Discount.find().lean(),
    getSettings(),
  ])
  const samples = products.slice(0, 6).map((product) => {
    const variant = product.variants[0]
    return { name: product.name, variant: [variant?.color, variant?.size].filter(Boolean).join(' / ') || 'Standard', before: variant?.sellingAmount ?? 0, after: variant ? convertAmount(variant.sellingAmount, rate, rounding) : 0 }
  })
  return {
    counts: {
      products: products.length,
      variants: products.reduce((sum, product) => sum + product.variants.length, 0),
      shippingMethods: shipping.length,
      discounts: discounts.length,
    },
    samples,
    shipping: shipping.slice(0, 3).map((method) => ({ name: method.name, before: method.amount, after: convertAmount(method.amount, rate, rounding) })),
    codMax: settings.cod.maxAmount ? { before: settings.cod.maxAmount, after: convertAmount(settings.cod.maxAmount, rate, rounding) } : null,
  }
}

// Runs `work` inside a MongoDB transaction when the server supports them (Atlas / replica sets),
// so a failure halfway can never leave half the catalogue converted. Standalone servers fall back
// to running without one.
async function atomically(work) {
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(() => work(session))
  } catch (error) {
    if (!/replica set|Transaction numbers|transactions are not supported/i.test(error.message)) throw error
    await work(null)
  } finally {
    await session.endSession()
  }
}

export async function applyCurrencyChange({ to, mode, rate, rounding, actorId }) {
  const current = await getSettings()
  const summary = { productsConverted: 0 }

  await atomically(async (session) => {
    summary.productsConverted = 0
    if (mode === 'convert') {
      for (const product of await Product.find().session(session)) {
        product.variants.forEach((variant) => Object.assign(variant, convertVariantPrices(variant, rate, rounding)))
        await product.save({ session })
        summary.productsConverted += 1
      }
      for (const method of await ShippingMethod.find().session(session)) {
        method.amount = convertAmount(method.amount, rate, rounding)
        await method.save({ session })
      }
      for (const discount of await Discount.find().session(session)) {
        if (discount.type === 'fixed') discount.value = convertAmount(discount.value, rate, rounding)
        discount.minimumOrderAmount = convertAmount(discount.minimumOrderAmount || 0, rate, rounding)
        await discount.save({ session })
      }
    }
    const codMax = mode === 'convert' && current.cod.maxAmount ? convertAmount(current.cod.maxAmount, rate, rounding) : current.cod.maxAmount
    await Setting.updateOne({ key: 'store' }, {
      $set: { currency: to, 'cod.maxAmount': codMax },
      $push: { currencyHistory: { from: current.currency, to, mode, rate: mode === 'convert' ? rate : undefined, rounding: mode === 'convert' ? rounding : undefined, productsConverted: summary.productsConverted, by: actorId } },
    }, { session })
  })

  // Quotes that haven't started paying were priced in the old currency; customers just re-quote.
  await CheckoutQuote.deleteMany({ paymentIntentId: { $exists: false } })
  clearSettingsCache()
  await onCurrencyChange()
  return summary
}
