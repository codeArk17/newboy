/** Admin API key from header X-Admin-Key or Authorization: Bearer <key> */
let runtimeAdminKey = null // overrides env at runtime after a key change

function getExpectedKey() {
  return runtimeAdminKey || process.env.ADMIN_KEY || 'admin123'
}

function setRuntimeKey(newKey) {
  runtimeAdminKey = newKey
}

function requireAdmin(req, res, next) {
  const expected = getExpectedKey()
  const headerKey = req.headers['x-admin-key']
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null
  const key = headerKey || bearer

  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Admin authentication required' })
  }
  next()
}

module.exports = { requireAdmin, getExpectedKey, setRuntimeKey }
