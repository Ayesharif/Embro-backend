import mongoose from 'mongoose'

const authTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  type: { type: String, enum: ['email_verification', 'password_reset'], required: true, index: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true })

authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('AuthToken', authTokenSchema)
