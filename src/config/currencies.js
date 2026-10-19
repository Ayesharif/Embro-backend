// Currencies the store can run in. All of them use two decimal places (100 minor units per unit),
// so every amount in the database stays an integer number of minor units whatever the currency.
const SUPPORTED = [
  { code: 'USD', name: 'US dollar', locale: 'en-US' },
  { code: 'PKR', name: 'Pakistani rupee', locale: 'en-PK', compact: true },
  { code: 'EUR', name: 'Euro', locale: 'en-IE' },
  { code: 'GBP', name: 'British pound', locale: 'en-GB' },
  { code: 'AED', name: 'UAE dirham', locale: 'en-AE' },
  { code: 'SAR', name: 'Saudi riyal', locale: 'en-SA' },
  { code: 'INR', name: 'Indian rupee', locale: 'en-IN', compact: true },
  { code: 'BDT', name: 'Bangladeshi taka', locale: 'en-BD', compact: true },
  { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
  { code: 'AUD', name: 'Australian dollar', locale: 'en-AU' },
]

export function isSupportedCurrency(code) {
  return SUPPORTED.some((currency) => currency.code === String(code).toUpperCase())
}

export function currencyInfo(code) {
  const upper = String(code || 'USD').toUpperCase()
  const base = SUPPORTED.find((currency) => currency.code === upper) || { code: upper, name: upper, locale: 'en-US' }
  const symbol = new Intl.NumberFormat(base.locale, { style: 'currency', currency: base.code, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find((part) => part.type === 'currency')?.value || base.code
  return { code: base.code, name: base.name, locale: base.locale, compact: Boolean(base.compact), symbol }
}

export function supportedCurrencies() {
  return SUPPORTED.map((currency) => currencyInfo(currency.code))
}

// "Compact" currencies (e.g. PKR) drop the .00 on whole amounts: Rs 1,400 rather than Rs 1,400.00.
export function formatMoney(minorUnits, code) {
  const info = currencyInfo(code)
  const whole = info.compact && minorUnits % 100 === 0
  return new Intl.NumberFormat(info.locale, {
    style: 'currency', currency: info.code, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
  }).format((minorUnits || 0) / 100)
}
