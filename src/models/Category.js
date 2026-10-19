import mongoose from 'mongoose'

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, unique: true, lowercase: true, index: true },
  description: { type: String, trim: true, maxlength: 1000 },
  image: {
    publicId: String,
    secureUrl: String,
  },
  status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true })

export default mongoose.model('Category', categorySchema)
