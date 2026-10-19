import { Router } from 'express'
import Category from '../models/Category.js'
import Product from '../models/Product.js'
import { env } from '../config/env.js'

const router = Router()

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function url(path) {
  return `${env.webAppUrl}${path}`
}

router.get('/robots.txt', (request, response) => {
  response.type('text/plain').send([
    'User-agent: *',
    'Disallow: /account',
    'Disallow: /wishlist',
    'Disallow: /checkout',
    'Disallow: /auth/',
    'Disallow: /admin/',
    `Sitemap: ${url('/sitemap.xml')}`,
    '',
  ].join('\n'))
})

router.get('/sitemap.xml', async (request, response) => {
  const [categories, products] = await Promise.all([
    Category.find({ status: 'active' }).select('slug updatedAt').sort({ sortOrder: 1, name: 1 }).lean(),
    Product.find({ status: 'published', priceFrom: { $ne: null } }).select('slug updatedAt').sort({ updatedAt: -1 }).lean(),
  ])
  const entries = [
    { path: '/', lastmod: null },
    { path: '/products', lastmod: null },
    { path: '/about', lastmod: null },
    { path: '/contact', lastmod: null },
    ...categories.map((category) => ({ path: `/products?category=${encodeURIComponent(category.slug)}`, lastmod: category.updatedAt })),
    ...products.map((product) => ({ path: `/products/${encodeURIComponent(product.slug)}`, lastmod: product.updatedAt })),
  ]
  const body = entries.map((entry) => [
    '  <url>',
    `    <loc>${escapeXml(url(entry.path))}</loc>`,
    entry.lastmod ? `    <lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>` : '',
    '  </url>',
  ].filter(Boolean).join('\n')).join('\n')
  response.type('application/xml').send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    '</urlset>',
  ].join('\n'))
})

export default router
