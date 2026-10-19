import mongoose from 'mongoose'

const addressSchema = new mongoose.Schema({
  name: String, line1: String, line2: String, city: String, state: String,
  postalCode: String, country: String, phone: String,
}, { _id: false })

const itemSchema = new mongoose.Schema({
  product: mongoose.Schema.Types.ObjectId,
  variantId: mongoose.Schema.Types.ObjectId,
  productNameSnapshot: String,
  variantLabel: String,
  skuSnapshot: String,
  image: String,
  quantity: Number,
  unitAmount: Number,
  lineTotalAmount: Number,
}, { _id: false })

// A quote freezes the prices the customer agreed to pay. The PaymentIntent amount is always
// taken from here - never from the browser.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shippingAddress: addressSchema,
  shippingMethod: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingMethod' },
  shippingMethodName: String,
  items: [itemSchema],
  subtotalAmount: { type: Number, required: true },
  shippingAmount: { type: Number, required: true },
  discountAmount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  currency: { type: String, default: 'usd' },
  discountCode: String,
  paymentIntentId: { type: String, index: true, sparse: true },
  // Stop accepting new payments after 30 minutes...
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 60 * 1000) },
  // ...but keep the document for a week so a payment that completes late can still become an order.
  purgeAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
}, { timestamps: true })

schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('CheckoutQuote', schema)
