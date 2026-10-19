import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  code: { type: String, required: true, unique: true, lowercase: true },
  description: { type: String, trim: true, maxlength: 200 },
  image: { publicId: String, secureUrl: String },
  amount: { type: Number, required: true, min: 0 },
  estimatedDaysMin: { type: Number, min: 0, default: 1 },
  estimatedDaysMax: { type: Number, min: 0, default: 7 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true })

export default mongoose.model('ShippingMethod', schema)
