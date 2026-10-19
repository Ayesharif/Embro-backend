import mongoose from 'mongoose'
const addressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  label: { type: String, trim: true, maxlength: 40 },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  line1: { type: String, required: true, trim: true, maxlength: 180 },
  line2: { type: String, trim: true, maxlength: 180 },
  city: { type: String, required: true, trim: true, maxlength: 80 },
  state: { type: String, trim: true, maxlength: 80 },
  postalCode: { type: String, required: true, trim: true, maxlength: 20 },
  country: { type: String, required: true, trim: true, maxlength: 80 },
  phone: { type: String, trim: true, maxlength: 30 },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true })
export default mongoose.model('Address', addressSchema)
