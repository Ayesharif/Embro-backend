import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantId: mongoose.Schema.Types.ObjectId,
  quantityDelta: { type: Number, required: true },
  reason: { type: String, required: true, maxlength: 120 },
  reference: String,
  actor: mongoose.Schema.Types.ObjectId,
}, { timestamps: true })

export default mongoose.model('InventoryMovement', schema)
