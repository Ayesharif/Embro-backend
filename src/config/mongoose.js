import mongoose from 'mongoose'

// Must be imported before any model: every document serialises with a string `id` and without `__v`.
mongoose.set('toJSON', { virtuals: true, versionKey: false })
mongoose.set('toObject', { virtuals: false })
