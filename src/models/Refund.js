import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  amount: { type: Number, min: 1, required: true },
  reason: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
  restocked: { type: Boolean, default: false },
  providerRefundId: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

export default mongoose.model('Refund', schema)
