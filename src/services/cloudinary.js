import crypto from 'node:crypto'
import { env } from '../config/env.js'

// Removes an image from Cloudinary when it is replaced or its record is deleted, so the media
// library doesn't fill up with orphaned files. Best effort: a failure here must never block the
// admin's save. Only assets under our own "lembro/" folder can be deleted.
export async function destroyImage(publicId) {
  const { cloudName, apiKey, apiSecret } = env.cloudinary
  if (!publicId || typeof publicId !== 'string' || !publicId.startsWith('lembro/')) return
  if (!cloudName || !apiKey || !apiSecret) return
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`).digest('hex')
  try {
    await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
      method: 'POST',
      body: new URLSearchParams({ public_id: publicId, api_key: apiKey, timestamp, signature }),
    })
  } catch (error) {
    console.error('Cloudinary cleanup failed:', error.message)
  }
}
