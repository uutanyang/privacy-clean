// Send magic link email via Resend API
// Free tier: 3,000 emails/day — https://resend.com
// Requires: RESEND_API_KEY secret + domain verified in Resend dashboard

interface EmailPayload {
  to: string
  magicLink: string
}

export async function sendMagicLinkEmail(
  payload: EmailPayload,
  resendApiKey: string,
  origin?: string
): Promise<{ success: boolean; error?: string }> {
  if (!resendApiKey) {
    // No API key configured — fall back to console log with clear instructions
    console.log(`[DEV] Magic link for ${payload.to}: ${payload.magicLink}`)
    console.log('[DEV] Set RESEND_API_KEY secret to enable real email delivery:')
    console.log('[DEV]   npx wrangler secret put RESEND_API_KEY')
    return { success: true }
  }

  // Dynamic sender domain from origin URL
  // IMPORTANT: The domain must be verified in Resend dashboard first
  const senderDomain = origin ? new URL(origin).hostname : 'privacyclean.app'
  const senderEmail = `PrivacyClean <noreply@${senderDomain}>`

  const html = generateMagicLinkHtml(payload.magicLink)
  const text = generateMagicLinkText(payload.magicLink)

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: senderEmail,
        to: payload.to,
        subject: 'Your sign-in link for PrivacyClean',
        html,
        text,
        tags: [
          { name: 'category', value: 'authentication' },
          { name: 'type', value: 'magic-link' },
        ],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('Resend API error:', res.status, err)
      // If sender domain not verified, provide helpful error
      if (err.includes('verify') || err.includes('domain')) {
        console.error(`[HINT] Domain "${senderDomain}" not verified in Resend. Go to https://resend.com/domains to verify.`)
      }
      return { success: false, error: err }
    }

    const result = await res.json() as { id: string }
    console.log(`Magic link email sent to ${payload.to} (Resend ID: ${result.id})`)
    return { success: true }
  } catch (err) {
    console.error('Failed to send email:', err)
    return { success: false, error: String(err) }
  }
}

function generateMagicLinkHtml(magicLink: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;margin:0;padding:40px 16px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;border:1px solid #e2e8f0;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="width:48px;height:48px;background:#2563eb;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:22px;">P</div>
    </div>
    <h1 style="font-size:22px;font-weight:700;text-align:center;color:#0f172a;margin:0 0 8px;">Sign in to PrivacyClean</h1>
    <p style="text-align:center;color:#64748b;font-size:15px;margin:0 0 28px;line-height:1.5;">Click the button below to sign in. This link expires in <strong>10 minutes</strong>.</p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${magicLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-weight:600;font-size:16px;letter-spacing:0.01em;">Sign in to PrivacyClean</a>
    </div>
    <div style="background:#f1f5f9;border-radius:10px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:13px;color:#475569;font-weight:600;">Button not working?</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">Copy and paste this link into your browser:</p>
      <p style="margin:8px 0 0;font-size:12px;color:#2563eb;word-break:break-all;">${magicLink}</p>
    </div>
    <div style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:8px;">
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin:0;line-height:1.5;">If you didn't request this email, you can safely ignore it.<br>Your account is secure — no one else can access it.</p>
    </div>
  </div>
  <div style="text-align:center;margin-top:16px;color:#94a3b8;font-size:11px;">
    PrivacyClean — Privacy-first metadata removal<br>
    <a href="https://privacy-clean.pages.dev" style="color:#94a3b8;text-decoration:underline;">privacy-clean.pages.dev</a>
  </div>
</body>
</html>`
}

function generateMagicLinkText(magicLink: string): string {
  return `Sign in to PrivacyClean

Click the link below to sign in. This link expires in 10 minutes.

${magicLink}

If you didn't request this email, you can safely ignore it.

--
PrivacyClean — Privacy-first metadata removal
https://privacy-clean.pages.dev`
}
