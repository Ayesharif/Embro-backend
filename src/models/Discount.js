import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true, maxlength: 40 },
  description: { type: String, trim: true, maxlength: 200 },
  type: { type: String, enum: ['percentage', 'fixed'], required: true },
  value: { type: Number, min: 0, required: true },
  startsAt: { type: Date, default: Date.now },
  endsAt: Date,
  minimumOrderAmount: { type: Number, min: 0, default: 0 },
  usageLimit: { type: Number, min: 1 },
  usedCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

export default mongoose.model('Discount', schema)
