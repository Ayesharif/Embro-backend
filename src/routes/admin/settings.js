import { Router } from 'express'
import { currencyInfo, isSupportedCurrency, supportedCurrencies } from '../../config/currencies.js'
import { ROLE_GROUPS, requireRole } from '../../middleware/auth.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { parse, v } from '../../utils/validation.js'
import { applyCurrencyChange, previewConversion, ROUNDINGS } from '../../services/currencyConversion.js'
import { onSettingsChange } from '../../cache/namespaces.js'
import { clearSettingsCache, getSettings } from '../../services/settings.js'
import Setting from '../../models/Setting.js'

const router = Router()
router.use('/settings', requireRole(...ROLE_GROUPS.finance))

const conversionSchema = {
  to: v.custom((value) => (typeof value === 'string' && isSupportedCurrency(value) ? null : 'must be a supported currency.')),
  mode: v.oneOf(['convert', 'relabel']),
  rate: v.optional(v.number({ min: 0.0001, max: 1_000_000 })),
  rounding: v.optional(v.oneOf(ROUNDINGS)),
}

function readConversion(body) {
  const input = parse(conversionSchema, body)
  if (input.mode === 'convert' && !input.rate) throw new HttpError(400, 'VALIDATION_ERROR', 'Rate is required when converting prices.')
  return { ...input, to: input.to.toUpperCase(), rounding: input.rounding || 'none' }
}

router.get('/settings', asyncHandler(async (request, response) => {
  const settings = await getSettings()
  response.json({
    currency: currencyInfo(settings.currency),
    supported: supportedCurrencies(),
    cod: settings.cod,
    history: [...(settings.currencyHistory || [])].reverse().slice(0, 8),
  })
}))

// Suggests today's exchange rate. It is only a convenience - the admin always confirms the number used.
router.get('/settings/rate', asyncHandler(async (request, response) => {
  const { from, to } = parse({
    from: v.custom((value) => (typeof value === 'string' && isSupportedCurrency(value) ? null : 'must be a supported currency.')),
    to: v.custom((value) => (typeof value === 'string' && isSupportedCurrency(value) ? null : 'must be a supported currency.')),
  }, request.query)
  try {
    const result = await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`, { signal: AbortSignal.timeout(5000) })
    const data = await result.json()
    const rate = data?.rates?.[to.toUpperCase()]
    if (!result.ok || typeof rate !== 'number') throw new Error('No rate in response')
    response.json({ rate, from: from.toUpperCase(), to: to.toUpperCase(), source: 'open.er-api.com', asOf: data.time_last_update_utc })
  } catch {
    throw new HttpError(502, 'RATE_UNAVAILABLE', 'Could not fetch a live exchange rate. Enter the rate manually.')
  }
}))

router.post('/settings/currency/preview', asyncHandler(async (request, response) => {
  const input = readConversion(request.body)
  const current = await getSettings()
  if (input.to === current.currency) throw new HttpError(400, 'VALIDATION_ERROR', `The store already uses ${current.currency}.`)
  response.json({
    from: currencyInfo(current.currency),
    to: currencyInfo(input.to),
    ...(input.mode === 'convert' ? await previewConversion(input) : { counts: null, samples: [], shipping: [], codMax: null }),
  })
}))

router.post('/settings/currency', asyncHandler(async (request, response) => {
  const { confirm, ...body } = request.body ?? {}
  const input = readConversion(body)
  // Typing the new code is a deliberate speed bump: this rewrites every price in the shop.
  if (confirm !== input.to) throw new HttpError(400, 'CONFIRMATION_REQUIRED', `Type ${input.to} to confirm the change.`)
  const current = await getSettings()
  if (input.to === current.currency) throw new HttpError(400, 'VALIDATION_ERROR', `The store already uses ${current.currency}.`)
  const summary = await applyCurrencyChange({ ...input, actorId: request.user._id })
  response.json({ currency: currencyInfo(input.to), ...summary })
}))

router.patch('/settings/cod', asyncHandler(async (request, response) => {
  const changes = parse({ enabled: v.boolean(), maxAmount: v.integer({ min: 0, max: 100_000_000_000 }) }, request.body, { partial: true })
  const update = Object.fromEntries(Object.entries(changes).map(([key, value]) => [`cod.${key}`, value]))
  await getSettings()
  await Setting.updateOne({ key: 'store' }, { $set: update })
  clearSettingsCache()
  await onSettingsChange()
  response.json({ cod: (await getSettings()).cod })
}))

export default router
