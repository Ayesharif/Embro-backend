import test from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.JWT_ACCESS_SECRET = 'x'.repeat(48)

await import('../src/config/mongoose.js')
const { default: Product } = await import('../src/models/Product.js')
const { default: Order } = await import('../src/models/Order.js')
const { serializeProduct, serializeAdminProduct } = await import('../src/services/products.js')

const category = '507f1f77bcf86cd799439011'
const build = () => new Product({
  name: 'Yarn', slug: 'yarn', description: 'Soft yarn', category, status: 'published',
  variants: [
    { color: 'Red', size: 'S', sellingAmount: 5000, costAmount: 2000, discountPercent: 20, stock: 3, image: { publicId: 'lembro/a', secureUrl: 'https://x/a.png' } },
    { color: 'Blue', size: 'M', sellingAmount: 6000, costAmount: 2500, stock: 0 },
    { color: 'Old', sellingAmount: 100, costAmount: 50, stock: 9, status: 'archived' },
  ],
})

test('price range and "from" price come from active variants only', async () => {
  const product = build()
  await product.validate()
  assert.equal(product.priceFrom, 4000)
  assert.equal(product.priceTo, 6000)
  const json = serializeProduct(product)
  assert.equal(json.finalAmount, 4000)
  assert.equal(json.sellingAmount, 5000)
  assert.equal(json.hasPriceRange, true)
  assert.equal(json.stock, 3)
  assert.equal(json.variants.length, 2)
  assert.deepEqual(json.colors, ['Red', 'Blue'])
  assert.equal(json.image, 'https://x/a.png')
})

test('purchasing cost never appears in the public product JSON', () => {
  const text = JSON.stringify(serializeProduct(build()))
  assert.ok(!text.includes('costAmount'))
  assert.ok(!text.includes('2000'))
})

test('admin JSON includes cost', () => {
  assert.equal(serializeAdminProduct(build()).variants[0].costAmount, 2000)
})

test('a product needs at least one variant', async () => {
  const product = new Product({ name: 'X', slug: 'x', description: 'd', category, variants: [] })
  await assert.rejects(product.validate(), /at least one variant/)
})

test('order items never expose their cost snapshot to customers', () => {
  const order = new Order({ items: [{ productNameSnapshot: 'Yarn', quantity: 1, unitAmount: 100, costAmountSnapshot: 40 }] })
  const text = JSON.stringify(order.toJSON())
  assert.ok(!text.includes('costAmountSnapshot'))
  assert.equal(order.items[0].costAmountSnapshot, 40)
})
