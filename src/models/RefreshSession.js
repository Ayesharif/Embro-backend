import mongoose from 'mongoose'

// One document per issued refresh token. Tokens are opaque random strings; only their SHA-256
// hash is stored. Rotated tokens stay (marked `usedAt`) until they expire so that replay of a
// stolen, already-used token can be detected and the whole token family revoked.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  family: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  usedAt: { type: Date },
  expiresAt: { type: Date, required: true },
  userAgent: { type: String, maxlength: 300 },
}, { timestamps: true })

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('RefreshSession', schema)
