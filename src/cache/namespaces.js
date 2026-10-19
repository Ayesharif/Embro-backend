import { env } from '../config/env.js'
import { invalidate } from './cache.js'

// Each namespace is a group of cached responses that go stale together.
export const NS = {
  PRODUCTS: 'products',     // product lists/details (also carries prices, stock and ratings)
  CATEGORIES: 'categories',
  SHIPPING: 'shipping',
  SETTINGS: 'settings',     // store currency + cash-on-delivery options
  REVIEWS: 'reviews',
  ADMIN_STATS: 'admin-stats', // dashboard + accounts report
}

export const TTL = env.cache.ttl

// One named function per kind of change, so route code says *what happened* and this file
// decides *what to invalidate*. All are safe to await or ignore; none ever throws.
export const onProductChange = () => invalidate([NS.PRODUCTS, NS.ADMIN_STATS])
export const onStockChange = () => invalidate([NS.PRODUCTS, NS.ADMIN_STATS])
export const onCategoryChange = () => invalidate([NS.CATEGORIES, NS.PRODUCTS])
export const onShippingChange = () => invalidate([NS.SHIPPING])
export const onSettingsChange = () => invalidate([NS.SETTINGS])
export const onReviewChange = () => invalidate([NS.REVIEWS, NS.PRODUCTS])
export const onOrderChange = () => invalidate([NS.ADMIN_STATS])
// Currency conversion rewrites prices, shipping, discounts and settings at once.
export const onCurrencyChange = () => invalidate(Object.values(NS))
export const purgeAll = () => invalidate(Object.values(NS))
