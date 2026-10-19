import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, select: false },
  role: { type: String, enum: ['customer', 'admin', 'super_admin', 'support', 'warehouse'], default: 'customer' },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
  emailVerifiedAt: { type: Date },
  lastLoginAt: { type: Date },
  failedLoginAttempts: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false },
}, { timestamps: true })

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this.id,
    name: this.name,
    email: this.email,
    role: this.role,
    status: this.status,
    emailVerified: Boolean(this.emailVerifiedAt),
    hasPassword: this.passwordHash === undefined ? undefined : Boolean(this.passwordHash),
    createdAt: this.createdAt,
  }
}

export default mongoose.model('User', userSchema)
