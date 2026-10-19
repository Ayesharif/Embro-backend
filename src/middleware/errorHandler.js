import mongoose from 'mongoose'

export function notFound(request, response) {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  })
}

function classify(error) {
  if (error.status && error.code && typeof error.code === 'string') {
    return { status: error.status, code: error.code, message: error.message, fields: error.fields }
  }
  if (error.type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' }
  if (error.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' }
  if (error instanceof mongoose.Error.ValidationError) {
    const fields = Object.fromEntries(Object.entries(error.errors).map(([key, value]) => [key, value.message]))
    return { status: 400, code: 'VALIDATION_ERROR', message: Object.values(fields)[0] || 'Validation failed.', fields }
  }
  if (error instanceof mongoose.Error.CastError) return { status: 400, code: 'INVALID_ID', message: 'One of the supplied values is not valid.' }
  if (error?.code === 11000) return { status: 409, code: 'DUPLICATE', message: 'A record with the same unique value already exists.' }
  if (typeof error?.type === 'string' && error.type.startsWith('Stripe')) {
    const clientError = error.statusCode && error.statusCode < 500
    return { status: clientError ? 400 : 502, code: 'PAYMENT_PROVIDER_ERROR', message: clientError ? error.message : 'The payment provider is unavailable. Please try again.' }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' }
}

export function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error)
    return
  }
  const { status, code, message, fields } = classify(error)
  if (status >= 500) console.error(error)
  response.status(status).json({ error: { code, message, ...(fields ? { fields } : {}) } })
}
