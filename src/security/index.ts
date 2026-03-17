import { config } from "../config.js";

// ─── Rate Limiter (in-memory, per IP) ───

interface RateBucket {
  count: number;
  resetAt: number;
}

const authBuckets = new Map<string, RateBucket>();
const apiBuckets = new Map<string, RateBucket>();

function checkRate(buckets: Map<string, RateBucket>, ip: string, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + config.rateLimitWindowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= max;
}

export function checkAuthRate(ip: string): boolean {
  return checkRate(authBuckets, ip, config.rateLimitMaxAuth);
}

export function checkApiRate(ip: string): boolean {
  return checkRate(apiBuckets, ip, config.rateLimitMaxApi);
}

// Cleanup stale buckets every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authBuckets) if (now > v.resetAt) authBuckets.delete(k);
  for (const [k, v] of apiBuckets) if (now > v.resetAt) apiBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ─── Security Headers ───

export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
  };
}

// ─── CORS ───

export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowed = config.corsOrigins;
  // If no origins configured, allow all (dev mode); otherwise strict check
  const effectiveOrigin = allowed.length === 0
    ? (origin || "*")
    : (origin && allowed.includes(origin) ? origin : "");

  if (!effectiveOrigin) return {};

  return {
    "Access-Control-Allow-Origin": effectiveOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...(effectiveOrigin !== "*" ? { "Vary": "Origin" } : {}),
  };
}

// ─── Input Sanitization ───

export function sanitizeString(input: string, maxLength = 200): string {
  return input
    .slice(0, maxLength)
    .replace(/[<>&"']/g, (c) => {
      const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#x27;" };
      return map[c] || c;
    })
    .trim();
}

// ─── Password Validation ───

export function validatePassword(password: string): string | null {
  if (password.length < config.passwordMinLength) {
    return `password must be at least ${config.passwordMinLength} characters`;
  }
  if (!/[a-zA-Z]/.test(password)) return "password must contain at least one letter";
  if (!/[0-9]/.test(password)) return "password must contain at least one number";
  return null; // valid
}

// ─── Extract Client IP ───

export function getClientIP(req: import("http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}
