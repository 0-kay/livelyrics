// Vercel Routing Middleware: asks for ACCESS_PASSWORD (browser sign-in prompt,
// any user name) before the page or the API loads. Without ACCESS_PASSWORD
// the site is open. /api/health stays open for uptime checks.

export const config = { runtime: 'nodejs', matcher: ['/((?!api/health$).*)'] };

/** True when a Basic Authorization header carries the password (user name ignored). */
export function passwordOk(header, password) {
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const given = decoded.slice(decoded.indexOf(':') + 1);
  if (given.length !== password.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ password.charCodeAt(i);
  return diff === 0;
}

export default function middleware(request) {
  const password = process.env.ACCESS_PASSWORD;
  if (!password) return undefined;
  if (passwordOk(request.headers.get('authorization'), password)) return undefined;
  return new Response('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="LiveLyrics", charset="UTF-8"' },
  });
}
