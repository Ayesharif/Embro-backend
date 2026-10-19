import crypto from 'node:crypto'
import mongoose from 'mongoose'

const itemSchema = new mongoose.Schema({
  product: mongoose.Schema.Types.ObjectId,
  variantId: mongoose.Schema.Types.ObjectId,
  productNameSnapshot: String,
  variantLabel: String,
  skuSnapshot: String,
  image: String,
  unitAmount: Number,
  // What the item cost us when it was sold. Used only for the admin accounts report - never sent to customers.
  costAmountSnapshot: Number,
  quantity: Number,
  lineTotalAmount: Number,
}, { _id: true })

itemSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    delete ret.costAmountSnapshot
    return ret
  },
})

const addressSchema = new mongoose.Schema({
  name: String, line1: String, line2: String, city: String, state: String,
  postalCode: String, country: String, phone: String,
}, { _id: false })

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  number: { type: String, unique: true },
  items: [itemSchema],
  addressSnapshot: addressSchema,
  paymentMethod: { type: String, enum: ['online', 'cod'], default: 'online' },
  paymentIntentId: { type: String, unique: true, sparse: true },
  // One order per checkout quote: stops a double-clicked "place order" creating two orders.
  quote: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckoutQuote', unique: true, sparse: true },
  paidAt: Date,
  deliveredAt: Date,
  subtotalAmount: Number,
  shippingAmount: Number,
  shippingMethodName: String,
  discountAmount: Number,
  discountCode: String,
  taxAmount: Number,
  totalAmount: Number,
  refundedAmount: { type: Number, default: 0 },
  currency: { type: String, default: 'usd' },
  status: { type: String, enum: ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'], default: 'pending', index: true },
  paymentStatus: { type: String, enum: ['pending', 'authorized', 'paid', 'failed', 'partially_refunded', 'refunded'], default: 'pending' },
  // Set when something needs a human (e.g. stock ran out between checkout and payment).
  requiresAttention: { type: Boolean, default: false, index: true },
  inventoryApplied: { type: Boolean, default: false },
  notes: { type: String, maxlength: 1000 },
}, { timestamps: true })

// What the customer sees as "delivery status", derived from the order status.
schema.virtual('deliveryStatus').get(function deliveryStatus() {
  if (['cancelled', 'refunded'].includes(this.status)) return 'cancelled'
  if (['processing', 'shipped', 'delivered'].includes(this.status)) return this.status
  return 'pending'
})

schema.pre('validate', function assignNumber() {
  if (!this.number) {
    const day = new Date().toISOString().slice(2, 10).replaceAll('-', '')
    this.number = `ORD-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  }
})

export default mongoose.model('Order', schema)
