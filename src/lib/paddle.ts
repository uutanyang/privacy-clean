// Paddle v2 webhook signature verification
// Paddle sends signatures in the format: ts=<timestamp>;h1=<hex_hmac_sha256>
// We extract the h1 value, concatenate timestamp + "." + body, and verify with HMAC-SHA256
// Docs: https://developer.paddle.com/webhooks/verify-webhook-signature

export async function verifyPaddleSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;

  // Parse Paddle v2 signature format: "ts=1234567890;h1=abcdef..."
  const tsMatch = signature.match(/ts=(\d+)/);
  const h1Match = signature.match(/h1=([0-9a-fA-F]+)/);

  if (!tsMatch || !h1Match) {
    // Legacy format: treat entire signature as hex HMAC (backward compat)
    return verifyLegacyHmac(rawBody, signature, secret);
  }

  const timestamp = tsMatch[1];
  const h1Hex = h1Match[1];

  // Replay protection: reject webhooks older than 5 minutes
  const webhookTime = parseInt(timestamp, 10) * 1000; // Paddle uses seconds
  const now = Date.now()
  const maxAgeMs = 5 * 60 * 1000 // 5 minutes
  if (Math.abs(now - webhookTime) > maxAgeMs) {
    console.warn('Paddle webhook timestamp too old or in future:', timestamp, 'now:', now / 1000)
    return false
  }

  // Paddle v2: HMAC-SHA256(secret, "ts=<timestamp>.<body>")
  const payload = `ts=${timestamp}.${rawBody}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const sigBytes = hexToUint8Array(h1Hex);
  const payloadBytes = encoder.encode(payload);

  return crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
}

async function verifyLegacyHmac(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const sigBytes = hexToUint8Array(signature);
  const bodyBytes = encoder.encode(rawBody);

  return crypto.subtle.verify('HMAC', key, sigBytes, bodyBytes);
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
