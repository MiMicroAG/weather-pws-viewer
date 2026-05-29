const express = require('express');
const morgan = require('morgan');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const WU_API_KEY = process.env.WU_API_KEY || '';
const WU_BASE = 'https://api.weather.com';

// --- F10: Security headers ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));

app.use(morgan('short'));
app.use(express.static(path.join(__dirname, 'public')));

// --- F4: In-memory cache with LRU eviction (max 1000 entries) ---
const CACHE_MAX = 1000;
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttlMs) {
  // Evict oldest entries if at capacity
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Periodic cache cleanup (every 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 600000);

// --- F1: Stations allowlist ---
const stationsPath = path.join(__dirname, 'config', 'stations.json');
let stations = [];
const allowedStationIds = new Set();
try {
  stations = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
  for (const s of stations) {
    allowedStationIds.add(s.id);
  }
} catch (e) {
  console.error('Failed to load stations.json:', e.message);
}

app.get('/api/stations', (_req, res) => {
  res.json(stations);
});

// --- Healthz ---
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- F2/F3: WU fetch helper with timeout and retry ---
async function wuFetch(urlPath, params) {
  if (!WU_API_KEY) {
    const err = new Error('WU_API_KEY is not configured');
    err.statusCode = 503;
    throw err;
  }
  const url = new URL(urlPath, WU_BASE);
  url.searchParams.set('apiKey', WU_API_KEY);
  url.searchParams.set('format', 'json');
  url.searchParams.set('units', 'm');
  url.searchParams.set('numericPrecision', 'decimal');
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const urlStr = url.toString();
  let lastErr;

  // Max 3 attempts (1 initial + 2 retries)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // F2: 10s timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      let resp;
      try {
        resp = await fetch(urlStr, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (resp.ok) {
        return resp.json();
      }

      const status = resp.status;

      // F3: Retry on 429 or 5xx
      if (status === 429) {
        if (attempt >= 2) break;
        const retryAfter = resp.headers.get('retry-after');
        const delayMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 10000) : (attempt === 0 ? 1000 : 2000);
        await sleep(delayMs);
        continue;
      }

      if (status >= 500) {
        if (attempt >= 2) break;
        const delayMs = attempt === 0 ? 500 : 1500;
        await sleep(delayMs);
        continue;
      }

      // 4xx (non-429): fail immediately
      // F6: log details, return generic message
      const body = await resp.text().catch(() => '');
      console.error(`WU API error: ${status} ${urlPath} ${body.slice(0, 500)}`);
      const err = new Error('upstream error');
      err.statusCode = status;
      throw err;

    } catch (e) {
      if (e.name === 'AbortError') {
        // F2: timeout
        const err = new Error('upstream timeout');
        err.statusCode = 504;
        throw err;
      }
      if (e.statusCode) throw e;
      lastErr = e;
    }
  }

  // All retries exhausted
  // F6: log details server-side, generic message to client
  if (lastErr) {
    console.error(`WU API failed after retries: ${urlPath}`, lastErr.message);
  }
  const err = new Error('upstream error');
  err.statusCode = 502;
  throw err;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Normalize current observation ---
function normalizeCurrent(obs, stationId) {
  if (!obs) return null;
  const m = obs.metric || {};
  return {
    stationId,
    obsTimeUtc: obs.obsTimeUtc || null,
    obsTimeLocal: obs.obsTimeLocal || null,
    tempC: m.temp ?? null,
    dewptC: m.dewpt ?? null,
    humidity: obs.humidity ?? null,
    pressureHpa: m.pressure ?? null,
    windDir: obs.winddir ?? null,
    windSpeedMs: m.windSpeed != null ? round2(m.windSpeed / 3.6) : null,
    windGustMs: m.windGust != null ? round2(m.windGust / 3.6) : null,
    precipRateMmH: m.precipRate ?? null,
    precipTotalMm: m.precipTotal ?? null,
    solarRadiationWm2: obs.solarRadiation ?? null,
    uv: obs.uv ?? null,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// --- Current observations ---
app.get('/api/observations/current', async (req, res) => {
  const stationId = req.query.stationId;
  if (!stationId) return res.status(400).json({ error: 'stationId required' });

  // F1: allowlist check
  if (!allowedStationIds.has(stationId)) {
    return res.status(404).json({ error: 'Unknown stationId' });
  }

  const cacheKey = `current:${stationId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await wuFetch(`/v2/pws/observations/current`, { stationId });
    const obs = data.observations && data.observations[0];
    const result = normalizeCurrent(obs, stationId);
    if (result) {
      cacheSet(cacheKey, result, 60000);
    }
    res.json(result || { error: 'No observation data' });
  } catch (err) {
    // F6: generic error to client
    const status = err.statusCode || 500;
    const message = err.statusCode ? err.message : 'upstream error';
    if (!err.statusCode) console.error('Unexpected error in /current:', err);
    res.status(status).json({ error: message, status });
  }
});

// --- History observations ---

// Date helpers (JST)
function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  return jst.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(addDays(endDate, -i));
  }
  return dates;
}

function formatDateParam(dateStr) {
  return dateStr.replace(/-/g, '');
}

// F5: Validate endDate
function validateEndDate(endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return false;
  const d = new Date(endDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  // Reconstruct to ensure valid calendar date (e.g. reject 2024-02-30)
  const reconstructed = d.toISOString().slice(0, 10);
  if (reconstructed !== endDate) return false;
  // Not in the future (JST)
  const today = todayJST();
  if (endDate > today) return false;
  // Within past 2 years
  const twoYearsAgo = addDays(today, -730);
  if (endDate < twoYearsAgo) return false;
  return true;
}

// Normalize history point
function normalizeHistoryPoint(obs, granularity) {
  if (!obs) return null;
  const m = obs.metric || {};
  const point = {
    tsLocal: obs.obsTimeLocal || null,
  };

  if (granularity === 'day') {
    point.tempMaxC = m.tempHigh ?? m.tempMax ?? null;
    point.tempMinC = m.tempLow ?? m.tempMin ?? null;
    point.tempAvgC = m.tempAvg ?? null;
    point.dewptAvgC = m.dewptAvg ?? null;
    point.humidityAvg = obs.humidityAvg ?? null;
    // F11: prefer mean/avg over max for daily pressure
    point.pressureHpa = m.pressureMean ?? m.pressureAvg ?? m.pressureMax ?? null;
    point.windSpeedAvgMs = m.windspeedAvg != null ? round2(m.windspeedAvg / 3.6) : null;
    point.windGustMaxMs = m.windgustHigh != null ? round2(m.windgustHigh / 3.6) : null;
    point.windDir = obs.winddirAvg ?? null;
    point.precipTotalMm = m.precipTotal ?? null;
  } else {
    point.tempC = m.temp ?? m.tempHigh ?? m.tempAvg ?? null;
    point.dewptC = m.dewpt ?? m.dewptHigh ?? m.dewptAvg ?? null;
    point.humidity = obs.humidity ?? obs.humidityHigh ?? obs.humidityAvg ?? null;
    point.pressureHpa = m.pressure ?? m.pressureMax ?? m.pressureMean ?? null;
    point.windDir = obs.winddir ?? obs.winddirAvg ?? null;
    point.windSpeedMs = m.windSpeed != null ? round2(m.windSpeed / 3.6) :
                        m.windspeedHigh != null ? round2(m.windspeedHigh / 3.6) :
                        m.windspeedAvg != null ? round2(m.windspeedAvg / 3.6) : null;
    point.windGustMs = m.windGust != null ? round2(m.windGust / 3.6) :
                       m.windgustHigh != null ? round2(m.windgustHigh / 3.6) : null;
    point.precipRateMmH = m.precipRate ?? null;
    point.precipTotalMm = m.precipTotal ?? null;
    point.solarRadiationWm2 = obs.solarRadiation ?? obs.solarRadiationHigh ?? null;
    point.uv = obs.uv ?? obs.uvHigh ?? null;
  }

  return point;
}

// Range config
const RANGE_CONFIG = {
  '24h': { days: 1, granularity: '5min', endpoint: 'all' },
  '1d':  { days: 1, granularity: '5min', endpoint: 'all' },
  '1w':  { days: 7, granularity: 'hour', endpoint: 'hourly' },
  '2w':  { days: 14, granularity: 'hour', endpoint: 'hourly' },
  '1mo': { days: 30, granularity: 'day', endpoint: 'daily' },
  '6mo': { days: 180, granularity: 'day', endpoint: 'daily' },
  '1y':  { days: 365, granularity: 'day', endpoint: 'daily' },
};

async function fetchDayData(stationId, dateStr, endpoint) {
  const today = todayJST();
  const isToday = dateStr === today;

  let urlPath;
  if (isToday && (endpoint === 'all' || endpoint === 'hourly')) {
    urlPath = `/v2/pws/observations/${endpoint}/1day`;
    const cacheKey = `day:${stationId}:${endpoint}:${dateStr}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const data = await wuFetch(urlPath, { stationId });
    const result = data.observations || [];
    cacheSet(cacheKey, result, 600000);
    return result;
  } else {
    urlPath = `/v2/pws/history/${endpoint}`;
    const cacheKey = `day:${stationId}:${endpoint}:${dateStr}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const data = await wuFetch(urlPath, { stationId, date: formatDateParam(dateStr) });
    const result = data.observations || [];
    const ttl = isToday ? 600000 : 86400000;
    cacheSet(cacheKey, result, ttl);
    return result;
  }
}

app.get('/api/observations/history', async (req, res) => {
  const stationId = req.query.stationId;
  const range = req.query.range || '24h';
  const endDate = req.query.endDate || todayJST();

  if (!stationId) return res.status(400).json({ error: 'stationId required' });

  // F1: allowlist check
  if (!allowedStationIds.has(stationId)) {
    return res.status(404).json({ error: 'Unknown stationId' });
  }

  // F5: endDate validation
  if (!validateEndDate(endDate)) {
    return res.status(400).json({ error: 'Invalid endDate' });
  }

  const config = RANGE_CONFIG[range];
  if (!config) return res.status(400).json({ error: `Invalid range: ${range}. Valid: ${Object.keys(RANGE_CONFIG).join(', ')}` });

  // Check response cache for the full request
  const responseCacheKey = `history:${stationId}:${range}:${endDate}`;
  const responseCached = cacheGet(responseCacheKey);
  if (responseCached) return res.json(responseCached);

  const dates = dateRange(endDate, config.days);
  const missingDates = [];
  let partial = false;

  try {
    const pLimitModule = await import('p-limit');
    const pLimit = pLimitModule.default;
    const limit = pLimit(5);

    const results = await Promise.all(
      dates.map(date => limit(async () => {
        try {
          return { date, observations: await fetchDayData(stationId, date, config.endpoint) };
        } catch (err) {
          missingDates.push(date);
          partial = true;
          return { date, observations: [] };
        }
      }))
    );

    const allObs = results.flatMap(r => r.observations);
    const points = allObs
      .map(obs => normalizeHistoryPoint(obs, config.granularity))
      .filter(Boolean);

    const result = {
      stationId,
      range,
      granularity: config.granularity,
      endDate,
      partial,
      missingDates,
      points,
    };

    // F7: Don't cache partial responses
    if (!partial) {
      const today = todayJST();
      const includesToday = dates.includes(today);
      cacheSet(responseCacheKey, result, includesToday ? 600000 : 3600000);
    }

    res.json(result);
  } catch (err) {
    // F6: generic error to client
    const status = err.statusCode || 500;
    const message = err.statusCode ? err.message : 'upstream error';
    if (!err.statusCode) console.error('Unexpected error in /history:', err);
    res.status(status).json({ error: message, status });
  }
});

app.listen(PORT, () => {
  console.log(`Weather PWS viewer running on port ${PORT}`);
  console.log(`API key configured: ${WU_API_KEY ? 'Yes' : 'No'}`);
  console.log(`Allowed stations: ${[...allowedStationIds].join(', ')}`);
});
