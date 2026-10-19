import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  status: { type: String, enum: ['subscribed', 'unsubscribed'], default: 'subscribed' },
  source: { type: String, default: 'footer', maxlength: 40 },
}, { timestamps: true })

export default mongoose.model('Subscriber', schema)
