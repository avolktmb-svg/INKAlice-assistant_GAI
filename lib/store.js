// Compare-and-set: параллельные запросы не перезаписывают чужую историю.
const CAS = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`;
const RATE = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class RedisStore {
  constructor(config, fetcher = fetch) {
    this.config = config;
    this.fetch = fetcher;
  }

  async command(args, signal) {
    const res = await this.fetch(this.config.redisUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.redisToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1200)]) : AbortSignal.timeout(1200)
    });
    if (!res.ok) throw new Error("STORAGE_UNAVAILABLE");
    const data = await res.json();
    if (data.error) throw new Error("STORAGE_COMMAND_FAILED");
    return data.result;
  }

  async get(key, signal) {
    const raw = await this.command(["GET", key], signal);
    return raw ? JSON.parse(raw) : null;
  }

  async update(key, transform, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await this.command(["GET", key], signal);
      const current = raw ? JSON.parse(raw) : null;
      const change = transform(current);
      if (!change.write) return change.result;
      const ok = await this.command(["EVAL", CAS, 1, key, raw || "",
        JSON.stringify(change.value), this.config.historyTTL], signal);
      if (ok === 1) return change.result;
    }
    throw new Error("STORAGE_BUSY");
  }

  async count(key, signal) {
    return this.command(["EVAL", RATE, 1, key, 172800], signal);
  }
}

// Только для локальной демонстрации и тестов. Production всегда использует Redis.
export class MemoryStore {
  constructor() { this.values = new Map(); this.counts = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) || null); }
  async update(key, transform) {
    const change = transform(structuredClone(this.values.get(key) || null));
    if (change.write) this.values.set(key, structuredClone(change.value));
    return change.result;
  }
  async count(key) {
    const value = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, value);
    return value;
  }
}
