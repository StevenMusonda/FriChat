/**
 * Simple in-memory rate limiter
 * Good enough for a single server instance; use a shared store if you scale out
 */

/**
 * Create a rate limiting middleware
 * @param {Object} options - { windowMs, max, message }
 */
function rateLimit({ windowMs, max, message }) {
    const hits = new Map(); // ip -> { count, resetAt }

    // Periodically drop expired entries so the map doesn't grow forever
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) {
                hits.delete(key);
            }
        }
    }, windowMs).unref();

    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }

        entry.count++;

        if (entry.count > max) {
            res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
            return res.status(429).json({
                success: false,
                message: message || 'Too many requests, please try again later'
            });
        }

        next();
    };
}

module.exports = { rateLimit };
