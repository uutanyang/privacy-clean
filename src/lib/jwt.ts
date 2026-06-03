// Minimal JWT implementation for Workers — no external crypto libs needed
// Uses Web Crypto API (available in all Workers runtimes)

export async function createToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64Header = b64UrlEncode(JSON.stringify(header));
  const b64Payload = b64UrlEncode(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${b64Header}.${b64Payload}`));
  const b64Sig = b64UrlEncode(signature);

  return `${b64Header}.${b64Payload}.${b64Sig}`;
}

export async function verifyToken(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const sig = b64UrlDecode(parts[2]);
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;

  try {
    const payload = JSON.parse(b64UrlDecodeString(parts[1]));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function b64UrlEncode(str: string | ArrayBuffer): string {
  if (typeof str !== 'string') {
    const bytes = new Uint8Array(str);
    str = String.fromCharCode(...bytes);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecodeString(str: string): string {
  str += new Array(5 - (str.length % 4)).join('=');
  str = str.replace(/\-/g, '+').replace(/\_/g, '/');
  return atob(str);
}

function b64UrlDecode(str: string): ArrayBuffer {
  const bin = b64UrlDecodeString(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
