import { Router } from 'express'
import Address from '../models/Address.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { parse, parseId, v } from '../utils/validation.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

export const addressFields = {
  label: v.optional(v.string({ min: 0, max: 40 })),
  name: v.string({ min: 2, max: 120 }),
  line1: v.string({ min: 3, max: 180 }),
  line2: v.optional(v.string({ min: 0, max: 180 })),
  city: v.string({ min: 2, max: 80 }),
  state: v.optional(v.string({ min: 0, max: 80 })),
  postalCode: v.string({ min: 2, max: 20 }),
  country: v.string({ min: 2, max: 80 }),
  phone: v.optional(v.string({ min: 0, max: 30 })),
}
const addressSchema = { ...addressFields, isDefault: v.optional(v.boolean()) }
const MAX_ADDRESSES = 10

async function makeDefault(userId, addressId) {
  await Address.updateMany({ user: userId, _id: { $ne: addressId } }, { $set: { isDefault: false } })
}

router.get('/', asyncHandler(async (request, response) => {
  response.json({ data: await Address.find({ user: request.user._id }).sort({ isDefault: -1, createdAt: -1 }) })
}))

router.post('/', asyncHandler(async (request, response) => {
  const input = parse(addressSchema, request.body)
  const count = await Address.countDocuments({ user: request.user._id })
  if (count >= MAX_ADDRESSES) throw new HttpError(400, 'ADDRESS_LIMIT', `You can save up to ${MAX_ADDRESSES} addresses.`)
  const address = await Address.create({ ...input, user: request.user._id, isDefault: input.isDefault || count === 0 })
  if (address.isDefault) await makeDefault(request.user._id, address._id)
  response.status(201).json({ address })
}))

router.patch('/:addressId', asyncHandler(async (request, response) => {
  const changes = parse(addressSchema, request.body, { partial: true })
  const address = await Address.findOneAndUpdate(
    { _id: parseId(request.params.addressId, 'address id'), user: request.user._id },
    { $set: changes },
    { new: true, runValidators: true },
  )
  if (!address) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found.')
  if (changes.isDefault) await makeDefault(request.user._id, address._id)
  response.json({ address })
}))

router.post('/:addressId/default', asyncHandler(async (request, response) => {
  const address = await Address.findOneAndUpdate({ _id: parseId(request.params.addressId, 'address id'), user: request.user._id }, { $set: { isDefault: true } }, { new: true })
  if (!address) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found.')
  await makeDefault(request.user._id, address._id)
  response.json({ address })
}))

router.delete('/:addressId', asyncHandler(async (request, response) => {
  const address = await Address.findOneAndDelete({ _id: parseId(request.params.addressId, 'address id'), user: request.user._id })
  if (!address) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found.')
  if (address.isDefault) {
    const next = await Address.findOne({ user: request.user._id }).sort({ createdAt: -1 })
    if (next) await Address.updateOne({ _id: next._id }, { $set: { isDefault: true } })
  }
  response.status(204).end()
}))

export default router
