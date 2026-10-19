import mongoose from 'mongoose'
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, required: true, trim: true },
  providerCustomerId: { type: String, required: true, select: false },
  providerPaymentMethodId: { type: String, required: true, select: false },
  brand: String, last4: { type: String, match: /^\d{4}$/ },
  expiryMonth: { type: Number, min: 1, max: 12 }, expiryYear: { type: Number, min: 2000 },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true })
export default mongoose.model('PaymentMethodReference', schema)
