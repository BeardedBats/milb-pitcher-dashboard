"""Redis cache abstraction layer using Upstash Redis.

Provides L2 cache (Redis) behind the existing L1 (in-memory dict) caches.
Falls back gracefully when Redis is unavailable (e.g., local development).
"""
import os
import json

_redis = None
_redis_checked = False


def _get_redis():
    """Lazy-initialize the Upstash Redis client."""
    global _redis, _redis_checked
    if _redis_checked:
        return _redis
    _redis_checked = True
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if url and token:
        try:
            from upstash_redis import Redis
            _redis = Redis(url=url, token=token)
        except Exception as e:
            print(f"[Redis] Failed to connect: {e}")
            _redis = None
    return _redis


def redis_get(key):
    """Get a value from Redis. Returns deserialized Python object or None."""
    r = _get_redis()
    if r is None:
        return None
    try:
        val = r.get(key)
        if val is None:
            return None
        # upstash-redis Python SDK returns the value already decoded
        if isinstance(val, str):
            return json.loads(val)
        return val
    except Exception as e:
        print(f"[Redis] GET error for {key}: {e}")
        return None


def redis_mget(keys):
    """Batch-get multiple keys in one Redis round-trip, falling back to
    per-key GETs on failure.

    Returns a list of deserialized values aligned with `keys` (None for any
    miss). MGET cuts command volume vs. N individual GETs, but Upstash's
    REST API caps the combined response size (~5 MB in practice). When the
    combined payload exceeds the cap the SDK raises — without a fallback
    the caller would mistake the entire chunk for "missing", which can
    silently corrupt read paths (we hit exactly this in _load_persisted_range
    on regular-season ranges, where per-day payloads are 2-3 MB each).

    The fallback below ensures correctness at the cost of N GET commands
    when MGET fails. Callers reading large payloads should pass small
    chunks (or just use redis_get).
    """
    keys = list(keys)
    if not keys:
        return []
    r = _get_redis()
    if r is None:
        return [None] * len(keys)
    try:
        raw = r.mget(*keys)
    except Exception as e:
        print(f"[Redis] MGET error ({len(keys)} keys, falling back to per-key GET): {e}")
        return [redis_get(k) for k in keys]
    out = []
    for val in raw:
        if val is None:
            out.append(None)
        elif isinstance(val, str):
            try:
                out.append(json.loads(val))
            except Exception:
                out.append(None)
        else:
            out.append(val)
    return out


def redis_set(key, value, ttl=None):
    """Set a value in Redis. Serializes to JSON."""
    r = _get_redis()
    if r is None:
        return
    try:
        data = json.dumps(value)
        if ttl:
            r.setex(key, ttl, data)
        else:
            r.set(key, data)
    except Exception as e:
        print(f"[Redis] SET error for {key}: {e}")


def redis_delete(key):
    """Delete a single key from Redis."""
    r = _get_redis()
    if r is None:
        return
    try:
        r.delete(key)
    except Exception as e:
        print(f"[Redis] DELETE error for {key}: {e}")


def redis_delete_many(keys):
    """Delete exact keys from Redis."""
    r = _get_redis()
    if r is None:
        return 0
    keys = [k for k in keys if k]
    if not keys:
        return 0
    deleted = 0
    try:
        for key in keys:
            r.delete(key)
            deleted += 1
    except Exception as e:
        print(f"[Redis] DELETE many error: {e}")
    return deleted


def redis_sadd(key, *values, ttl=None):
    """Add values to a Redis set."""
    r = _get_redis()
    if r is None or not values:
        return
    try:
        r.sadd(key, *values)
        if ttl:
            r.expire(key, ttl)
    except Exception as e:
        print(f"[Redis] SADD error for {key}: {e}")


def redis_smembers(key):
    """Return members from a Redis set as strings."""
    r = _get_redis()
    if r is None:
        return set()
    try:
        members = r.smembers(key) or []
        return {m.decode("utf-8") if isinstance(m, bytes) else str(m) for m in members}
    except Exception as e:
        print(f"[Redis] SMEMBERS error for {key}: {e}")
        return set()


def redis_srem(key, *values):
    """Remove values from a Redis set."""
    r = _get_redis()
    if r is None or not values:
        return
    try:
        r.srem(key, *values)
    except Exception as e:
        print(f"[Redis] SREM error for {key}: {e}")


def redis_incr(key):
    """Atomically increment an integer key in Redis. Returns the new value."""
    r = _get_redis()
    if r is None:
        return None
    try:
        return r.incr(key)
    except Exception as e:
        print(f"[Redis] INCR error for {key}: {e}")
        return None


def redis_available():
    """Check if Redis is available."""
    return _get_redis() is not None
