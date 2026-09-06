const WINDOW_MS = 60 * 1000;

function setSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  // SEC-009: Add Content-Security-Policy and HSTS
  // This is an API-only backend; a restrictive CSP prevents abuse if any HTML is ever served.
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

function createRateLimiter({ windowMs = WINDOW_MS, max = 120, message = "Too many requests" } = {}) {
  const store = new Map();

  return (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const routeKey = `${req.method}:${req.baseUrl || ""}:${req.path || ""}`;
    const key = `${ip}:${routeKey}`;
    const now = Date.now();

    const record = store.get(key);
    if (!record || now - record.start > windowMs) {
      store.set(key, { start: now, count: 1 });
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      return res.status(429).json({
        success: false,
        message,
      });
    }

    return next();
  };
}

function cleanupRateLimitStore() {
  const maxAge = WINDOW_MS * 5;
  return (store) => {
    const now = Date.now();
    for (const [key, value] of store.entries()) {
      if (now - value.start > maxAge) {
        store.delete(key);
      }
    }
  };
}

module.exports = {
  setSecurityHeaders,
  createRateLimiter,
  cleanupRateLimitStore,
};
