import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 40 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  status: { type: String, enum: ['new', 'in_progress', 'resolved', 'spam'], default: 'new', index: true },
  assignedTo: mongoose.Schema.Types.ObjectId,
}, { timestamps: true })

export default mongoose.model('ContactMessage', schema)
