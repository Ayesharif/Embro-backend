import mongoose from 'mongoose'

// A single document ({ key: 'store' }) holding store-wide settings.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'store' },
  currency: { type: String, required: true, uppercase: true, default: 'USD' },
  cod: {
    enabled: { type: Boolean, default: true },
    // Largest order total (in minor units of the store currency) accepted for cash on delivery; 0 = no limit.
    maxAmount: { type: Number, min: 0, default: 0 },
  },
  currencyHistory: [{
    from: String,
    to: String,
    mode: { type: String, enum: ['convert', 'relabel'] },
    rate: Number,
    rounding: String,
    productsConverted: Number,
    by: mongoose.Schema.Types.ObjectId,
    at: { type: Date, default: Date.now },
  }],
}, { timestamps: true })

export default mongoose.model('Setting', schema)
