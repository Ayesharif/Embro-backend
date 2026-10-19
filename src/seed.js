import './config/mongoose.js'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { connectDatabase, disconnectDatabase } from './config/db.js'
import { env } from './config/env.js'
import Category from './models/Category.js'
import Product from './models/Product.js'
import ShippingMethod from './models/ShippingMethod.js'
import User from './models/User.js'
import Setting from './models/Setting.js'
import { getSettings } from './services/settings.js'
import { slugify } from './utils/text.js'

const categories = [
  { name: 'Yarn', slug: 'yarn', sortOrder: 1 },
  { name: 'Beads', slug: 'beads', sortOrder: 2 },
  { name: 'Threads', slug: 'threads', sortOrder: 3 },
]

// name, category, featured, new arrival, variants: [color, size, selling price ($), purchasing cost ($), stock, discount %]
const products = [
  ['Premium Yarn Basket', 'yarn', true, true, [['Cream', 'Medium', 49, 27, 12, 15], ['Rose', 'Medium', 49, 27, 8, 15], ['Cream', 'Large', 64, 36, 6, 15]]],
  ['Colourful Bead Strands', 'beads', true, true, [['Mixed', 'Small', 29, 16, 15, 0], ['Mixed', 'Large', 42, 23, 8, 0]]],
  ['Pastel Thread Set', 'threads', true, true, [['Pastel', '', 35, 19, 26, 10]]],
  ['Rainbow Crochet Kit', 'yarn', true, false, [['Rainbow', '', 58, 31, 29, 0]]],
  ['Premium Crystal Beads', 'beads', false, true, [['Clear', 'Small', 32, 17, 20, 0], ['Blue', 'Small', 32, 17, 12, 0]]],
  ['Classic Sewing Bundle', 'threads', false, false, [['Assorted', '', 40, 22, 35, 5]]],
]

const shippingMethods = [
  { name: 'Standard shipping', code: 'standard', amount: 800, estimatedDaysMin: 5, estimatedDaysMax: 7 },
  { name: 'Express shipping', code: 'express', amount: 1500, estimatedDaysMin: 2, estimatedDaysMax: 3 },
  { name: 'Local pickup', code: 'pickup', amount: 0, estimatedDaysMin: 0, estimatedDaysMax: 1 },
]

// No hard-coded credentials: the admin account comes from the environment, or a random
// one-time password is generated and printed once.
const adminEmail = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase()
if (!adminEmail && env.isProduction) throw new Error('Set SEED_ADMIN_EMAIL (and SEED_ADMIN_PASSWORD) to seed an admin in production.')
const adminPassword = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url')
if (env.isProduction && !process.env.SEED_ADMIN_PASSWORD) throw new Error('Set SEED_ADMIN_PASSWORD to seed an admin in production.')

await connectDatabase()
// The demo prices below are on a US-dollar scale, so a brand-new store always starts in USD.
// Switch to PKR (or anything else) afterwards in Admin -> Settings, which converts the prices for you.
await Setting.updateOne({ key: 'store' }, { $setOnInsert: { key: 'store', currency: 'USD', cod: { enabled: env.cod.enabled, maxAmount: env.cod.maxAmount || 0 } } }, { upsert: true })
await getSettings()

const categoryMap = {}
for (const category of categories) {
  categoryMap[category.slug] = await Category.findOneAndUpdate({ slug: category.slug }, category, { upsert: true, new: true, setDefaultsOnInsert: true })
}

for (const method of shippingMethods) {
  // $setOnInsert: re-running the seed must not overwrite prices or images you edited in the admin.
  await ShippingMethod.updateOne({ code: method.code }, { $setOnInsert: method }, { upsert: true })
}

const email = adminEmail || 'admin@lembro.example'
await User.findOneAndUpdate(
  { email },
  { name: 'Admin User', email, passwordHash: await bcrypt.hash(adminPassword, 12), role: 'super_admin', emailVerifiedAt: new Date() },
  { upsert: true, setDefaultsOnInsert: true },
)

for (const [name, categorySlug, isFeatured, isNewArrival, variants] of products) {
  const slug = slugify(name)
  const product = (await Product.findOne({ slug })) || new Product({ slug })
  // Existing products keep their variants (and any edits you made); only new ones are created.
  if (product.isNew) {
    Object.assign(product, {
      name,
      category: categoryMap[categorySlug]._id,
      description: `A carefully selected ${name.toLowerCase()} for creative projects.`,
      isFeatured,
      isNewArrival,
      status: 'published',
      variants: variants.map(([color, size, selling, cost, stock, discountPercent]) => ({
        color: color || undefined, size: size || undefined, sellingAmount: selling * 100, costAmount: cost * 100, stock, discountPercent,
      })),
    })
    await product.save()
  }
}

console.log('Seed completed. Demo prices are in USD - use Admin -> Settings to switch the store currency (e.g. PKR).')
console.log(`Admin sign-in: ${email}`)
if (!process.env.SEED_ADMIN_PASSWORD) console.log(`One-time admin password: ${adminPassword}  (change it after signing in)`)
await disconnectDatabase()
