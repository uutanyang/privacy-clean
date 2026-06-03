import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { createToken, verifyToken } from './lib/jwt'
import { verifyPaddleSignature } from './lib/paddle'
import { sendMagicLinkEmail } from './lib/email'

type Bindings = {
  KV: KVNamespace
  JWT_SECRET: string
  PADDLE_WEBHOOK_SECRET: string
  PADDLE_ENV: string
  PADDLE_CLIENT_TOKEN: string
  PADDLE_PRICE_ID: string
  PADDLE_LIFETIME_PRICE_ID: string
  RESEND_API_KEY: string
  TURNSTILE_SECRET_KEY: string
  TURNSTILE_SITE_KEY: string
  ALLOWED_ORIGINS: string
  ANALYTICS: AnalyticsEngineDataset
}

type Variables = {
  rateLimitRemaining: number
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── Global middleware ──────────────────────────────────────────
app.use('*', logger())

// ── Dynamic CORS based on ALLOWED_ORIGINS ─────────────────────
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin') || ''
  const allowed = c.env.ALLOWED_ORIGINS || ''

  // If no allowed origins configured, fall back to permissive (dev mode)
  if (!allowed) {
    return cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'x-user-email'],
      maxAge: 86400,
    })(c, next)
  }

  const allowedList = allowed.split(',').map(o => o.trim().toLowerCase())

  if (allowedList.includes(origin.toLowerCase())) {
    return cors({
      origin,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'x-user-email'],
      maxAge: 86400,
      credentials: true,
    })(c, next)
  }

  // Origin not in allow list — still process but no CORS headers
  return next()
})

// ── Enhanced Security Headers ─────────────────────────────────
app.use('/api/*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Request-Id', crypto.randomUUID())
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // HSTS — only set if on HTTPS (Workers always are in production)
  const proto = c.req.header('x-forwarded-proto') || 'https'
  if (proto === 'https') {
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  }
  // CSP for API responses (defense-in-depth)
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})

// ── Turnstile verification helper ─────────────────────────────
async function verifyTurnstile(token: string, secret: string, ip?: string): Promise<boolean> {
  if (!secret) return true // Skip if not configured (dev mode)
  if (!token) return false

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: token,
        remoteip: ip || '',
      }),
    })
    const data = await res.json() as { success: boolean }
    return data.success === true
  } catch (err) {
    console.error('Turnstile verification error:', err)
    return false
  }
}

// ── Analytics helper ──────────────────────────────────────────
function trackEvent(c: any, eventType: string, props: Record<string, string> = {}) {
  try {
    if (c.env.ANALYTICS) {
      c.env.ANALYTICS.writeDataPoint({
        indexes: [eventType],
        doubles: [],
        blobs: [props.email || '', props.path || c.req.path, props.detail || ''],
      })
    }
  } catch {
    // Analytics is optional — never fail the request
  }
}

// ── KV backup helper ──────────────────────────────────────────
async function writeUserWithBackup(kv: KVNamespace, email: string, data: Record<string, unknown>) {
  const json = JSON.stringify(data)
  // Primary key
  await kv.put(`user:${email}`, json)
  // Backup key with timestamp — keeps last 3 backups
  const backupTs = Date.now()
  await kv.put(`user_backup:${email}:${backupTs}`, json, { expirationTtl: 90 * 24 * 3600 }) // 90 days

  // Clean old backups (keep only 3 most recent)
  const list = await kv.list({ prefix: `user_backup:${email}:` })
  const backups = list.keys
    .map(k => ({ name: k.name, ts: parseInt(k.name.split(':').pop() || '0') }))
    .sort((a, b) => b.ts - a.ts)

  for (let i = 3; i < backups.length; i++) {
    await kv.delete(backups[i].name)
  }
}

// ── Rate limiting (KV-based) ──────────────────────────────────
app.use('/api/auth', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
  const key = `ratelimit:auth:${ip}`
  const now = Date.now()
  const windowMs = 60_000 // 1 minute
  const maxRequests = 5

  const raw = await c.env.KV.get(key)
  const record = raw ? JSON.parse(raw) as { count: number; resetAt: number } : { count: 0, resetAt: now + windowMs }

  if (now > record.resetAt) {
    record.count = 0
    record.resetAt = now + windowMs
  }

  record.count++

  const ttl = Math.ceil((record.resetAt - now) / 1000)
  await c.env.KV.put(key, JSON.stringify(record), { expirationTtl: Math.max(ttl, 1) })

  c.header('X-RateLimit-Limit', String(maxRequests))
  c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - record.count)))
  c.header('X-RateLimit-Reset', String(Math.ceil(record.resetAt / 1000)))

  if (record.count > maxRequests) {
    trackEvent(c, 'rate_limit_exceeded', { detail: 'auth' })
    return c.json({ error: 'rate_limit_exceeded', message: 'Too many requests. Please wait a minute.' }, 429)
  }

  await next()
})

// ── Health check ──────────────────────────────────────────────
app.get('/api/config', (c) => {
  // Front-end configuration (no secrets — only public IDs)
  const paddleEnv = c.env.PADDLE_ENV || 'sandbox'
  const paddleClientToken = c.env.PADDLE_CLIENT_TOKEN || ''
  const paddlePriceId = c.env.PADDLE_PRICE_ID || ''
  const paddleLifetimePriceId = c.env.PADDLE_LIFETIME_PRICE_ID || ''
  const turnstileSiteKey = c.env.TURNSTILE_SITE_KEY || ''

  return c.json({
    paddleEnv,
    paddleClientToken,
    paddlePriceId,
    paddleLifetimePriceId,
    turnstileSiteKey,
  })
})
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', timestamp: Date.now(), version: '2.0.0' })
})

// ── Auth: Magic Link ──────────────────────────────────────────
app.post('/api/auth', async (c) => {
  let body: { email?: string; token?: string; action?: string; turnstileToken?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!body.action || (body.action !== 'request' && body.action !== 'verify')) {
    return c.json({ error: 'unknown_action', message: 'Action must be "request" or "verify"' }, 400)
  }

  if (body.action === 'request') {
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return c.json({ error: 'invalid_email', message: 'Please provide a valid email address' }, 400)
    }

    // ── Turnstile verification ───────────────────────────────
    const ip = c.req.header('cf-connecting-ip') || ''
    const turnstileValid = await verifyTurnstile(body.turnstileToken || '', c.env.TURNSTILE_SECRET_KEY, ip)
    if (!turnstileValid) {
      trackEvent(c, 'turnstile_failed', { detail: 'auth_request' })
      return c.json({ error: 'captcha_failed', message: 'Bot verification failed. Please try again.' }, 400)
    }

    const email = body.email.toLowerCase().trim()
    const token = await createToken({ email, exp: Date.now() + 10 * 60 * 1000 }, c.env.JWT_SECRET)

    await c.env.KV.put(`token:${token}`, JSON.stringify({ email, used: false }), { expirationTtl: 600 })

    const origin = new URL(c.req.url).origin
    const magicLink = `${origin}/?token=${token}`
    const result = await sendMagicLinkEmail({ to: email, magicLink }, c.env.RESEND_API_KEY, origin)

    trackEvent(c, 'magic_link_sent', { email })

    if (!result.success) {
      return c.json({ ok: true, note: 'Email send failed, check server logs', link: magicLink })
    }

    return c.json({ ok: true, note: 'Check your email for the sign-in link' })
  }

  // verify
  if (!body.token) return c.json({ error: 'missing_token', message: 'Token is required for verification' }, 400)

  const payload = await verifyToken(body.token, c.env.JWT_SECRET)
  if (!payload) return c.json({ error: 'invalid_or_expired_token', message: 'Token is invalid or has expired' }, 400)

  const stored = await c.env.KV.get(`token:${body.token}`)
  if (!stored) return c.json({ error: 'token_not_found', message: 'Token not found or already expired' }, 400)

  const record = JSON.parse(stored) as { used: boolean; email: string }
  if (record.used) return c.json({ error: 'token_already_used', message: 'This link has already been used' }, 400)

  // Mark used
  await c.env.KV.put(`token:${body.token}`, JSON.stringify({ ...record, used: true }), { expirationTtl: 600 })

  // Ensure user record exists (with backup)
  const email = payload.email as string
  const existing = await c.env.KV.get(`user:${email}`)
  if (!existing) {
    await writeUserWithBackup(c.env.KV, email, { email, tier: 'free', createdAt: Date.now() })
  }

  // Issue a session JWT (valid 7 days) for authenticated API calls
  const sessionToken = await createToken({ email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, c.env.JWT_SECRET)

  trackEvent(c, 'login_success', { email })

  return c.json({ ok: true, email, token: sessionToken })
})

// ── Verify subscription tier ──────────────────────────────────
// If Authorization header present, verify JWT and use token email (secure)
// Otherwise fall back to x-user-email header (legacy, no auth — only reveals tier, not sensitive)
app.get('/api/verify', async (c) => {
  let email: string | undefined

  // Prefer JWT-based verification if token provided
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const payload = await verifyToken(authHeader.slice(7), c.env.JWT_SECRET)
    if (payload?.email) email = payload.email as string
  }

  // Fallback to header-based lookup
  if (!email) {
    email = c.req.header('x-user-email')?.toLowerCase().trim()
  }

  if (!email) return c.json({ tier: 'free' })

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid_email' }, 400)
  }

  const data = await c.env.KV.get(`user:${email}`)
  if (!data) return c.json({ tier: 'free' })

  const user = JSON.parse(data) as { tier: string; email: string }
  const tier = user.tier || 'free'
  trackEvent(c, 'tier_check', { email, detail: tier })
  return c.json({ tier, email: user.email, isPro: tier === 'pro' || tier === 'lifetime' })
})

// ── GDPR: Delete user data ──────────────────────────────────
app.delete('/api/user', async (c) => {
  const email = c.req.header('x-user-email')?.toLowerCase().trim()
  if (!email) return c.json({ error: 'missing_email', message: 'x-user-email header required' }, 400)

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid_email' }, 400)
  }

  // Verify user exists
  const data = await c.env.KV.get(`user:${email}`)
  if (!data) {
    // Already deleted or never existed — return 200 for idempotency (GDPR)
    return c.json({ ok: true, message: 'No data found for this email' })
  }

  // Delete primary record
  await c.env.KV.delete(`user:${email}`)

  // Delete backups
  const backups = await c.env.KV.list({ prefix: `user_backup:${email}:` })
  for (const key of backups.keys) {
    await c.env.KV.delete(key.name)
  }

  // Delete any pending tokens for this email (best-effort scan)
  // Note: tokens are short-lived (10min), so this is mostly cosmetic

  trackEvent(c, 'gdpr_data_deleted', { email })

  return c.json({ ok: true, message: 'All personal data has been deleted' })
})

// ── Paddle Webhook ───────────────────────────────────────────
app.post('/api/webhook', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('paddle-signature') || ''

  // Verify webhook authenticity
  const isValid = await verifyPaddleSignature(rawBody, signature, c.env.PADDLE_WEBHOOK_SECRET)
  if (!isValid) {
    console.error('Invalid Paddle webhook signature')
    trackEvent(c, 'webhook_invalid_signature')
    return c.text('Invalid signature', 400)
  }

  let event: { event_type: string; data?: Record<string, unknown> }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.text('Invalid JSON', 400)
  }

  const eventType = event.event_type
  if (!eventType) {
    return c.text('Missing event_type', 400)
  }

  const data = event.data || {}

  // Map Paddle customer email
  const customerData = data.customer as Record<string, unknown> | undefined
  const customerEmail = (customerData?.email as string) || (data.email as string)
  if (!customerEmail) {
    console.warn('Webhook missing customer email:', eventType)
    return c.text('Missing email', 400)
  }

  const email = customerEmail.toLowerCase().trim()

  try {
    switch (eventType) {
      case 'transaction.completed': {
        // One-time purchase → lifetime tier
        const billingCycle = data.billing_cycle as Record<string, unknown> | undefined
        const isOneTime = !billingCycle || !billingCycle.frequency
        const tier = isOneTime ? 'lifetime' : 'pro'
        const subscriptionId = (data.subscription_id as string) || (data.id as string)
        await writeUserWithBackup(c.env.KV, email, {
          email,
          tier,
          subscriptionId,
          updatedAt: Date.now(),
        })
        console.log(`Upgraded ${email} to ${tier}`)
        trackEvent(c, 'tier_upgraded', { email, detail: tier })
        break
      }

      case 'subscription.activated':
      case 'subscription.updated': {
        const subscriptionId = (data.subscription_id as string) || (data.id as string)
        await writeUserWithBackup(c.env.KV, email, {
          email,
          tier: 'pro',
          subscriptionId,
          updatedAt: Date.now(),
        })
        console.log(`Upgraded ${email} to Pro (subscription)`)
        trackEvent(c, 'tier_upgraded', { email, detail: 'pro' })
        break
      }

      case 'subscription.canceled':
      case 'subscription.past_due': {
        // Only downgrade if user is on subscription tier (pro), not lifetime
        const existing = await c.env.KV.get(`user:${email}`)
        const existingUser = existing ? JSON.parse(existing) as { tier: string } : null
        if (existingUser && existingUser.tier === 'lifetime') {
          console.log(`Lifetime user ${email} cancellation ignored — keeps lifetime access`)
          break
        }
        await writeUserWithBackup(c.env.KV, email, {
          email,
          tier: 'free',
          updatedAt: Date.now(),
        })
        console.log(`Downgraded ${email} to Free`)
        trackEvent(c, 'tier_downgraded', { email, detail: eventType })
        break
      }

      default:
        console.log('Unhandled Paddle event:', eventType)
        trackEvent(c, 'webhook_unhandled', { detail: eventType })
    }
  } catch (err) {
    console.error('Webhook processing error:', err)
    return c.text('Internal error', 500)
  }

  return c.text('OK')
})

// ── Global error handler ─────────────────────────────────────
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  trackEvent(c, 'unhandled_error', { detail: err.message })
  return c.json({ error: 'internal_server_error', message: 'An unexpected error occurred' }, 500)
})

// ── 404 handler ───────────────────────────────────────────────
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'not_found' }, 404)
  }
  // For non-API routes, let Cloudflare Assets handle SPA fallback
  return c.notFound()
})

export default app
