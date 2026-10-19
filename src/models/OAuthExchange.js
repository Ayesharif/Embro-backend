import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true })

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('OAuthExchange', schema)
