import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  carrier: { type: String, trim: true, maxlength: 80 },
  trackingNumber: { type: String, trim: true, maxlength: 120 },
  status: { type: String, enum: ['pending', 'shipped', 'in_transit', 'delivered', 'returned'], default: 'pending' },
  shippedAt: Date,
  deliveredAt: Date,
}, { timestamps: true })

export default mongoose.model('Shipment', schema)
