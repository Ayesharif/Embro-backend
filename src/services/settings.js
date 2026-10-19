import Setting from '../models/Setting.js'
import { currencyInfo, isSupportedCurrency, supportedCurrencies } from '../config/currencies.js'
import { env } from '../config/env.js'

const TTL_MS = 15_000
let cache = { value: null, at: 0 }

export function clearSettingsCache() {
  cache = { value: null, at: 0 }
}

// Settings are read on almost every checkout request, so they are cached briefly per process.
export async function getSettings() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value
  const initialCurrency = isSupportedCurrency(env.currency) ? env.currency.toUpperCase() : 'USD'
  const doc = await Setting.findOneAndUpdate(
    { key: 'store' },
    { $setOnInsert: { key: 'store', currency: initialCurrency, cod: { enabled: env.cod.enabled, maxAmount: env.cod.maxAmount || 0 } } },
    { upsert: true, new: true, lean: true },
  )
  cache = { value: doc, at: Date.now() }
  return doc
}

export async function getCurrencyCode() {
  return (await getSettings()).currency
}

export async function publicSettings() {
  const settings = await getSettings()
  return {
    currency: currencyInfo(settings.currency),
    supported: supportedCurrencies(),
    cod: { enabled: settings.cod.enabled, maxAmount: settings.cod.maxAmount || null },
  }
}
