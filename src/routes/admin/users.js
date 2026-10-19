import { Router } from 'express'
import User from '../../models/User.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { parse, parseId, v } from '../../utils/validation.js'
import { revokeAllSessions } from '../../services/sessions.js'

const router = Router()
const MANAGEABLE_BY_ADMIN = ['customer', 'support', 'warehouse']

router.get('/users', asyncHandler(async (request, response) => {
  const users = await User.find().sort({ createdAt: -1 }).limit(200)
  response.json({ data: users.map((user) => user.toPublic()) })
}))

// Privilege rules (this endpoint used to let any "support" user make themselves super_admin):
//  - nobody can change their own role or status
//  - only a super_admin can change roles, or touch admin/super_admin accounts
//  - an admin can rename/suspend customers, support and warehouse staff only
router.patch('/users/:id', asyncHandler(async (request, response) => {
  const id = parseId(request.params.id, 'user id')
  const changes = parse({
    name: v.string({ min: 2, max: 120 }),
    status: v.oneOf(['active', 'suspended']),
    role: v.oneOf(['customer', 'support', 'warehouse', 'admin', 'super_admin']),
  }, request.body, { partial: true })

  const target = await User.findById(id)
  if (!target) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.')
  const actor = request.user
  const actorIsSuper = actor.role === 'super_admin'

  if (target.id === actor.id && (changes.role !== undefined || changes.status !== undefined)) {
    throw new HttpError(403, 'FORBIDDEN', 'You cannot change your own role or status.')
  }
  if (!actorIsSuper && !MANAGEABLE_BY_ADMIN.includes(target.role)) {
    throw new HttpError(403, 'FORBIDDEN', 'Only a super admin can manage administrator accounts.')
  }
  if (changes.role !== undefined && !actorIsSuper) {
    throw new HttpError(403, 'FORBIDDEN', 'Only a super admin can change roles.')
  }

  Object.assign(target, changes)
  await target.save()
  if (changes.status === 'suspended' || changes.role !== undefined) await revokeAllSessions(target._id)
  response.json({ user: target.toPublic() })
}))

export default router
