// One-off migration for databases created before products were restructured around variants.
// Old shape: price/cost/stock/discount/images on the product + variants of type color|size|weight.
// New shape: every sellable option is a variant with its own price, cost, discount, stock, image, colour, size.
//
//   node scripts/migrate-to-variants.js          # dry run
//   node scripts/migrate-to-variants.js --apply  # write changes
//
// Back up your database first. Carts are emptied because they reference the old variant ids.
import '../src/config/mongoose.js'
import mongoose from 'mongoose'
import { env } from '../src/config/env.js'

const apply = process.argv.includes('--apply')
await mongoose.connect(env.mongoUri)
const products = mongoose.connection.collection('products')

let migrated = 0
for (const doc of await products.find({ sellingAmount: { $exists: true } }).toArray()) {
  const images = [...(doc.images || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
  const primary = images.find((image) => image.isPrimary) || images[0]
  const toImage = (image) => (image ? { publicId: image.publicId, secureUrl: image.secureUrl } : undefined)
  const old = (doc.variants || []).filter((variant) => variant.sellingAmount === undefined)

  const variants = old.length
    ? old.map((variant, index) => ({
      _id: variant._id,
      color: variant.type === 'color' ? variant.value : undefined,
      size: variant.type !== 'color' ? variant.value : undefined,
      sku: variant.sku,
      sellingAmount: doc.sellingAmount + (variant.priceDeltaAmount || 0),
      costAmount: doc.costAmount || 0,
      discountPercent: doc.discountPercent || 0,
      stock: variant.stock || 0,
      image: toImage(images[index] || primary),
      status: variant.status || 'active',
    }))
    : [{ sellingAmount: doc.sellingAmount, costAmount: doc.costAmount || 0, discountPercent: doc.discountPercent || 0, stock: doc.stock || 0, image: toImage(primary), status: 'active' }]

  const prices = variants.filter((variant) => variant.status === 'active').map((variant) => Math.round(variant.sellingAmount * (1 - variant.discountPercent / 100)))
  console.log(`${apply ? 'Migrating' : 'Would migrate'}: ${doc.name} -> ${variants.length} variant(s)`)
  if (apply) {
    await products.updateOne({ _id: doc._id }, {
      $set: { variants, priceFrom: prices.length ? Math.min(...prices) : null, priceTo: prices.length ? Math.max(...prices) : null },
      $unset: { sellingAmount: '', costAmount: '', discountPercent: '', stock: '', images: '' },
    })
  }
  migrated += 1
}
if (apply) await mongoose.connection.collection('carts').updateMany({}, { $set: { items: [] } })
console.log(`${migrated} product(s) ${apply ? 'migrated' : 'found (dry run - pass --apply to write)'}.`)
await mongoose.disconnect()
