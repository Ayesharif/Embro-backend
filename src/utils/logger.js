// Minimal structured (JSON-lines) logger. Never pass secrets or cached values as fields.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info
const lastLogged = new Map()

function write(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
}

// Logs at most once per interval per `kind`, so a Redis outage can't flood the logs.
export function logLimited(kind, level, message, fields, intervalMs = 10_000) {
  const now = Date.now()
  if (now - (lastLogged.get(kind) || 0) < intervalMs) return
  lastLogged.set(kind, now)
  write(level, message, fields)
}
