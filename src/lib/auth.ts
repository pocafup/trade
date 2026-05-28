// Edge-compatible HMAC utilities (used in middleware)
export const SESSION_COOKIE = 'trade_sess';
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const DEFAULT_SECRET = 'trade-tracker-secret-please-change';

function secret() {
  return process.env.AUTH_SECRET ?? DEFAULT_SECRET;
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function sign(payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return b64url(sig);
}

async function verify(payload: string, sig: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  try {
    return await crypto.subtle.verify('HMAC', key, b64urlDecode(sig).buffer as ArrayBuffer, enc.encode(payload));
  } catch { return false; }
}

export async function createToken(username: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(
    JSON.stringify({ sub: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL })
  ).buffer as ArrayBuffer);
  const sig = await sign(payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig     = token.slice(dot + 1);
    if (!(await verify(payload, sig))) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.sub as string;
  } catch { return null; }
}
