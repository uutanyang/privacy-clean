// Paddle webhook signature verification
// Uses Web Crypto HMAC-SHA256 on the raw request body

export async function verifyPaddleSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  // Paddle v2 signatures are hex HMAC
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
