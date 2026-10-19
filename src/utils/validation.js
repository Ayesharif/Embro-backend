import { HttpError } from './httpError.js'

// A tiny, dependency-free validation layer. Every validator returns { value } or { error }.
// Nothing is silently coerced: a number sent where text is expected is rejected, which also
// shuts the door on NoSQL operator injection ({ "$ne": "" } objects in place of strings).

const ok = (value) => ({ value })
const fail = (error) => ({ error })
const OBJECT_ID = /^[a-f\d]{24}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'iloveyou', 'letmein123', 'admin123', 'welcome123',
])

function humanize(key) {
  const spaced = key.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export const v = {
  string({ min = 1, max = 255, lowercase = false, pattern, patternMessage } = {}) {
    return (input) => {
      if (input === undefined || input === null) return fail('is required.')
      if (typeof input !== 'string') return fail('must be text.')
      let value = input.trim()
      if (lowercase) value = value.toLowerCase()
      if (value.length < min) return fail(min === 1 ? 'is required.' : `must be at least ${min} characters.`)
      if (value.length > max) return fail(`must be at most ${max} characters.`)
      if (pattern && !pattern.test(value)) return fail(patternMessage || 'has an invalid format.')
      return ok(value)
    }
  },

  email() {
    return (input) => {
      const result = v.string({ min: 3, max: 254, lowercase: true })(input)
      if (result.error) return result
      return EMAIL.test(result.value) ? result : fail('must be a valid email address.')
    }
  },

  password({ checkStrength = true } = {}) {
    return (input) => {
      if (typeof input !== 'string') return fail(input === undefined ? 'is required.' : 'must be text.')
      if (input.length < 8) return fail('must be at least 8 characters.')
      // bcrypt only uses the first 72 bytes, so cap the length to avoid silent truncation.
      if (Buffer.byteLength(input) > 72) return fail('must be at most 72 bytes long.')
      if (checkStrength && COMMON_PASSWORDS.has(input.toLowerCase())) return fail('is too common. Choose something less guessable.')
      return ok(input)
    }
  },

  integer({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, coerce = false } = {}) {
    return (input) => {
      if (input === undefined || input === null) return fail('is required.')
      let value = input
      if (coerce && typeof input === 'string' && /^-?\d+$/.test(input.trim())) value = Number(input)
      if (typeof value !== 'number' || !Number.isInteger(value)) return fail('must be a whole number.')
      if (value < min) return fail(`must be at least ${min}.`)
      if (value > max) return fail(`must be at most ${max}.`)
      return ok(value)
    }
  },

  number({ min = -Infinity, max = Infinity } = {}) {
    return (input) => {
      if (typeof input !== 'number' || !Number.isFinite(input)) return fail('must be a number.')
      if (input < min) return fail(`must be at least ${min}.`)
      if (input > max) return fail(`must be at most ${max}.`)
      return ok(input)
    }
  },

  boolean({ coerce = false } = {}) {
    return (input) => {
      if (typeof input === 'boolean') return ok(input)
      if (coerce && (input === 'true' || input === 'false')) return ok(input === 'true')
      return fail('must be true or false.')
    }
  },

  objectId() {
    return (input) => (typeof input === 'string' && OBJECT_ID.test(input) ? ok(input) : fail('must be a valid id.'))
  },

  oneOf(values) {
    return (input) => (values.includes(input) ? ok(input) : fail(`must be one of: ${values.join(', ')}.`))
  },

  date() {
    return (input) => {
      if (typeof input !== 'string' && typeof input !== 'number') return fail('must be a valid date.')
      const date = new Date(input)
      return Number.isNaN(date.getTime()) ? fail('must be a valid date.') : ok(date)
    }
  },

  array(itemValidator, { min = 0, max = 50 } = {}) {
    return (input) => {
      if (!Array.isArray(input)) return fail('must be a list.')
      if (input.length < min) return fail(`must contain at least ${min} item(s).`)
      if (input.length > max) return fail(`must contain at most ${max} items.`)
      const values = []
      for (let index = 0; index < input.length; index += 1) {
        const result = itemValidator(input[index])
        if (result.error) return fail(`item ${index + 1} ${result.error}`)
        values.push(result.value)
      }
      return ok(values)
    }
  },

  object(schema, { partial = false } = {}) {
    return (input) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('must be an object.')
      const { output, fields } = run(schema, input, partial)
      const first = Object.entries(fields)[0]
      return first ? fail(`${humanize(first[0]).toLowerCase()} ${first[1]}`) : ok(output)
    }
  },

  // undefined / null => "not provided" (the key is skipped); anything else must pass the validator.
  optional(validator) {
    return (input) => (input === undefined || input === null ? ok(undefined) : validator(input))
  },

  // null is a valid value (used to clear a field); undefined still means "not provided".
  nullable(validator) {
    return (input) => (input === null ? ok(null) : validator(input))
  },

  custom(check) {
    return (input) => {
      const message = check(input)
      return message ? fail(message) : ok(input)
    }
  },
}

function run(schema, input, partial) {
  const output = {}
  const fields = {}
  for (const [key, validator] of Object.entries(schema)) {
    const raw = input[key]
    if (partial && raw === undefined) continue
    const result = validator(raw)
    if (result.error) fields[key] = result.error
    else if (result.value !== undefined) output[key] = result.value
  }
  return { output, fields }
}

export function parse(schema, input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The request body must be a JSON object.')
  }
  const { output, fields } = run(schema, input, partial)
  const entries = Object.entries(fields)
  if (entries.length) {
    const [key, message] = entries[0]
    throw new HttpError(400, 'VALIDATION_ERROR', `${humanize(key)} ${message}`, fields)
  }
  return output
}

export function parseId(value, label = 'id') {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
    throw new HttpError(400, 'INVALID_ID', `The ${label} is not valid.`)
  }
  return value
}
