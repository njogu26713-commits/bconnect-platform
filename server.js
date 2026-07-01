const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const { Readable } = require('stream');
const dns = require('dns');
const os = require('os');
const { sendEmail, passwordResetEmail, paymentReceiptEmail, bookingConfirmationEmail, landlordPaymentAlertEmail, tenantJoinRequestEmail, welcomeEmail, emailVerificationEmail, depositConfirmationEmail } = require('./email');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const OpenAI = require('openai');
const cloudinaryPkg = require('cloudinary');
const cloudinary = cloudinaryPkg.v2;
dotenv.config({ override: true });

// Cloudinary setup — only active when all three env vars are present
const CLOUDINARY_ENABLED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  console.log('[OK] Cloudinary configured — uploads will use Cloudinary CDN');
} else {
  console.log('[INFO] Cloudinary not configured — image uploads will use MongoDB GridFS');
}

// Helper: upload a buffer to Cloudinary and return { url, thumbUrl }
async function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'bconnect', ...options },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(buffer);
  });
}

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  MONGODB_URI,
  XAI_API_KEY,
  JWT_SECRET = 'your_secret_key_change_in_production',
  NODE_ENV = 'development',
  PORT = 3000,
  ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:8000',
  EMAIL_USER,
  EMAIL_PASS
} = process.env;

const missingOptionalEnv = [
  ['MPESA_CONSUMER_KEY', MPESA_CONSUMER_KEY],
  ['MPESA_CONSUMER_SECRET', MPESA_CONSUMER_SECRET],
  ['MPESA_SHORTCODE', MPESA_SHORTCODE],
  ['MPESA_PASSKEY', MPESA_PASSKEY],
  ['MPESA_CALLBACK_URL', MPESA_CALLBACK_URL],
  ['MONGODB_URI', MONGODB_URI]
].filter(([, v]) => !v).map(([k]) => k);

if (missingOptionalEnv.length) {
  console.log(`[INFO] Optional env vars not set (${missingOptionalEnv.join(', ')}). Related features are disabled.`);
}

const app = express();
app.set('trust proxy', 1);

// Secure CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = ALLOWED_ORIGINS.split(',').map(o => o.trim());
    // Allow all origins for development
    callback(null, true);
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
};

app.use(compression());
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Allow iframe embedding (for Replit preview pane)
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

// Debug middleware - log all requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: NODE_ENV === 'production' ? 600 : 5000,
  skip: (req) => {
    // Don't rate-limit GET/HEAD (pages, static assets, read-only API); only throttle mutations
    return req.method === 'GET' || req.method === 'HEAD';
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests from this IP, please try again later.' });
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: NODE_ENV === 'production' ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many login attempts, please wait a few minutes and try again.' });
  }
});

app.use(limiter); // Apply rate limiting to all routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Serve static files securely
// In dev, disable caching for all static files so changes are always visible immediately
app.use((req, res, next) => {
  if (NODE_ENV !== 'production') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static('.', {
  dotfiles: 'deny',
  maxAge: NODE_ENV === 'production' ? '1d' : 0,
  etag: NODE_ENV === 'production'
}));

// Serve uploaded listing images with caching (legacy local files)
app.use('/uploads', express.static('uploads', {
  maxAge: '30d',
  etag: true,
  lastModified: true
}));

// Serve files stored in MongoDB GridFS
app.get('/api/files/:id', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    let fileId;
    try { fileId = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid file id' }); }
    const files = await bucket.find({ _id: fileId }).toArray();
    if (!files.length) return res.status(404).json({ error: 'File not found' });
    const file = files[0];
    const etag = '"' + file._id.toString() + '"';
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    // Determine correct Content-Type — GridFS sometimes stores 'application/octet-stream'
    // for images uploaded via multer. Detect from filename extension and default to image/jpeg.
    let contentType = file.contentType || 'application/octet-stream';
    if (!contentType || contentType === 'application/octet-stream') {
      const fn = (file.filename || '').toLowerCase();
      if (fn.endsWith('.png'))  contentType = 'image/png';
      else if (fn.endsWith('.gif'))  contentType = 'image/gif';
      else if (fn.endsWith('.webp')) contentType = 'image/webp';
      else if (fn.endsWith('.svg'))  contentType = 'image/svg+xml';
      else if (fn.endsWith('.mp4'))  contentType = 'video/mp4';
      else if (fn.endsWith('.webm')) contentType = 'video/webm';
      else contentType = 'image/jpeg'; // safe default — most uploads are photos
    }
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('ETag', etag);
    res.set('Content-Length', file.length);
    bucket.openDownloadStream(fileId).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ HOME PAGE ROUTE ============
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/website.html');
});

app.get('/home', (req, res) => {
  res.sendFile(__dirname + '/website.html');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// When MongoDB isn't connected, short-circuit /api/* requests with a clean 503
// instead of letting handlers crash on `db.collection(...)`.
// Endpoints that should work even when the DB is down (health, status, etc.)
const DB_OPTIONAL_PATHS = new Set(['/health', '/status', '/ping']);
app.use('/api', (req, res, next) => {
  if (db) return next();
  const cleanPath = (req.path || '').split('?')[0];
  if (DB_OPTIONAL_PATHS.has(cleanPath)) return next();
  return res.status(503).json({
    success: false,
    products: [],
    orders: [],
    profiles: [],
    items: [],
    error: 'Database is temporarily unavailable. Please try again in a moment.'
  });
});

// MongoDB connection (with auto-retry, heartbeat, and reconnect)
let mongoClient;
let db;
let isReconnecting = false;
let heartbeatTimer = null;

function attachMongoListeners(client) {
  if (!client) return;
  client.on('serverHeartbeatFailed', (e) => {
    console.warn('[WARN] Mongo heartbeat failed:', (e && e.failure && e.failure.message) || 'unknown');
  });
  client.on('error', (err) => {
    console.warn('[WARN] Mongo client error:', err && err.message);
    scheduleReconnect();
  });
  client.on('close', () => {
    console.warn('[WARN] Mongo connection closed.');
    scheduleReconnect();
  });
  client.on('topologyClosed', () => {
    console.warn('[WARN] Mongo topology closed.');
    scheduleReconnect();
  });
}

async function connectToMongoDB({ silent = false } = {}) {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || MONGODB_URI;
  if (!mongoUri) {
    if (!silent) console.log('[INFO] MONGODB_URI not set — starting in degraded mode (no database).');
    return false;
  }

  let attempt = 0;
  const maxDelayMs = 30000;
  const maxBootAttempts = 5;

  while (attempt < maxBootAttempts) {
    attempt++;
    try {
      if (!silent || attempt === 1) {
        console.log('Attempting to connect to MongoDB Atlas (attempt ' + attempt + '): ' + mongoUri.substring(0, 30) + '...');
      }
      const client = new MongoClient(mongoUri, {
        maxPoolSize: 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 60000,
        connectTimeoutMS: 15000,
        retryWrites: true,
        retryReads: true,
        heartbeatFrequencyMS: 10000
      });
      await client.connect();
      const newDb = client.db('bconnect');
      await newDb.command({ ping: 1 });

      const oldClient = mongoClient;
      mongoClient = client;
      db = newDb;
      attachMongoListeners(mongoClient);
      if (oldClient && oldClient !== client) {
        try { await oldClient.close(true); } catch (_) {}
      }
      console.log('[OK] Successfully connected to MongoDB Atlas.');
      startHeartbeat();
      return true;
    } catch (error) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn('[WARN] MongoDB connection failed (attempt ' + attempt + '): ' + error.message);
      if (attempt < maxBootAttempts) {
        console.warn('   Retrying in ' + Math.round(delay / 1000) + 's...');
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.warn('   Could not establish initial MongoDB connection. Continuing in degraded mode; a background watchdog will keep trying.');
  scheduleReconnect();
  return false;
}

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  let delay = 2000;
  const maxDelay = 30000;
  const tick = async () => {
    try {
      const ok = await connectToMongoDB({ silent: true });
      if (ok) {
        isReconnecting = false;
        return;
      }
    } catch (e) {
      console.warn('Reconnect attempt error:', e && e.message);
    }
    delay = Math.min(delay * 2, maxDelay);
    setTimeout(tick, delay);
  };
  setTimeout(tick, delay);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    if (!db) return;
    try {
      await db.command({ ping: 1 });
    } catch (err) {
      console.warn('[WARN] Mongo heartbeat ping failed:', err && err.message);
      scheduleReconnect();
    }
  }, 30000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.warn('[WARN] Unhandled promise rejection:', msg);
  if (/Mongo|topology|connection/i.test(msg)) scheduleReconnect();
});
process.on('uncaughtException', (err) => {
  console.warn('[WARN] Uncaught exception:', err && err.message);
  if (err && /Mongo|topology|connection/i.test(err.message || '')) scheduleReconnect();
});

// Initialize Grok (xAI) client
const genAI = XAI_API_KEY ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: 'https://api.x.ai/v1' }) : null;

if (!XAI_API_KEY) {
  console.log('[INFO] XAI_API_KEY not set — AI assistant endpoints disabled.');
} else {
  console.log('[OK] Grok AI client initialized');
}

// ── WhatsApp Bot ────────────────────────────────────────────────────────────
let waBot = null;
const WHATSAPP_BOT_ENABLED = process.env.WHATSAPP_BOT_ENABLED === 'true';
if (WHATSAPP_BOT_ENABLED) {
  try {
    waBot = require('./whatsapp-bot/index');
    console.log('[OK] WhatsApp Bot module loaded');
  } catch (e) {
    console.warn('[WARN] WhatsApp Bot failed to load:', e.message);
  }
}

// GET /api/admin/whatsapp-qr — returns QR code data URL for scanning
app.get('/api/admin/whatsapp-qr', (req, res) => {
  if (!WHATSAPP_BOT_ENABLED || !waBot) {
    return res.json({ success: false, botEnabled: false, connected: false });
  }
  const { qr, dataUrl, pairingCode, pairingPhone, connected, mode } = waBot.getQR();
  res.json({ success: true, botEnabled: true, connected, mode: mode || 'qr', qr: qr || null, dataUrl: dataUrl || null, pairingCode: pairingCode || null, pairingPhone: pairingPhone || null });
});

// POST /api/admin/whatsapp-disconnect — logout current session and clear auth for re-pairing
app.post('/api/admin/whatsapp-disconnect', async (req, res) => {
  if (!WHATSAPP_BOT_ENABLED || !waBot) {
    return res.json({ success: false, error: 'Bot not enabled' });
  }
  try {
    await waBot.disconnectAndReset();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// POST /api/admin/whatsapp-reconnect — restart connection keeping existing session
app.post('/api/admin/whatsapp-reconnect', async (req, res) => {
  if (!WHATSAPP_BOT_ENABLED || !waBot) {
    return res.json({ success: false, error: 'Bot not enabled' });
  }
  try {
    const result = await waBot.reconnect();
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// POST /api/admin/whatsapp-refresh-code — request a fresh pairing code from WhatsApp
app.post('/api/admin/whatsapp-refresh-code', async (req, res) => {
  if (!WHATSAPP_BOT_ENABLED || !waBot) {
    return res.json({ success: false, error: 'Bot not enabled' });
  }
  try {
    const phoneNumber = (req.body && req.body.phoneNumber) ? String(req.body.phoneNumber).replace(/\D/g, '') : '';
    const result = await waBot.refreshPairingCode(phoneNumber);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Gemini models available on the free-tier v1beta endpoint (in fallback order)
const GEMINI_MODEL_CHAIN = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

// Estimated free-tier daily request quotas per model
const GEMINI_MODEL_QUOTAS = {
  'gemini-2.5-flash':      500,
  'gemini-2.5-flash-lite': 1500,
  'gemini-2.0-flash':      1500,
  'gemini-2.0-flash-lite': 1500,
};

// In-memory response cache (1-hour TTL) — avoids burning quota on identical repeat calls
const _aiCache = new Map();
const AI_CACHE_TTL = 60 * 60 * 1000;

// AI usage tracking — resets daily (date check on each call)
let _aiUsage = {
  date: new Date().toISOString().slice(0, 10),
  totalCalls: 0,       // calls to generateGeminiResponse
  cacheHits: 0,        // served from cache (no API call)
  failedCalls: 0,      // all models exhausted
  successModel: null,  // last model that responded successfully
  models: Object.fromEntries(GEMINI_MODEL_CHAIN.map(m => [m, {
    requests: 0,          // times this model was tried via the API
    successes: 0,
    quotaExhausted: false,
    lastUsed: null,
  }])),
};

function _aiUsageResetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (_aiUsage.date !== today) {
    _aiUsage = {
      date: today,
      totalCalls: 0, cacheHits: 0, failedCalls: 0, successModel: null,
      models: Object.fromEntries(GEMINI_MODEL_CHAIN.map(m => [m, {
        requests: 0, successes: 0, quotaExhausted: false, lastUsed: null,
      }])),
    };
  }
}

// Parse "retry in X.Xs" or "retryDelay":"Xs" from Gemini 429 bodies
function parseRetryDelay(msg) {
  const m = msg.match(/retry(?:ing)? in (\d+(?:\.\d+)?)\s*s/i)
           || msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  return m ? Math.ceil(parseFloat(m[1])) * 1000 : 15000;
}

async function generateGeminiResponse(prompt, { maxTokens = 500, temperature = 0.7 } = {}) {
  if (!genAI) throw new Error('Gemini API key not configured.');
  _aiUsageResetIfNewDay();
  _aiUsage.totalCalls++;

  // Serve from cache when possible
  const cacheKey = crypto.createHash('md5').update(prompt + String(maxTokens)).digest('hex');
  const cached = _aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
    console.log('[AI] Cache hit — skipping API call');
    _aiUsage.cacheHits++;
    return cached.text;
  }

  let lastErr;
  for (const modelName of GEMINI_MODEL_CHAIN) {
    const stat = _aiUsage.models[modelName] || { requests: 0, successes: 0, quotaExhausted: false, lastUsed: null };
    _aiUsage.models[modelName] = stat;

    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const model = genAI.getGenerativeModel(
          { model: modelName, generationConfig: { maxOutputTokens: maxTokens, temperature } }
        );
        stat.requests++;
        stat.lastUsed = new Date().toISOString();
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        stat.successes++;
        _aiUsage.successModel = modelName;
        console.log(`[AI] ✓ ${modelName}${attempt > 0 ? ' (retry)' : ''}`);
        _aiCache.set(cacheKey, { text, ts: Date.now() });
        return text;
      } catch (err) {
        lastErr = err;
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('Too Many Requests');
        const isDead = msg.includes('404') || msg.includes('not found') ||
                       msg.includes('503') || msg.includes('not supported');

        if (!is429 && !isDead) throw err;

        if (is429 && attempt === 0) {
          const delay = parseRetryDelay(msg);
          if (delay <= 25000) {
            console.warn(`[AI] ${modelName} rate-limited — retrying in ${delay / 1000}s…`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          stat.quotaExhausted = true;
          console.warn(`[AI] ${modelName} daily quota exhausted (retry in ${Math.round(delay / 1000)}s) — trying next…`);
        } else {
          console.warn(`[AI] ${modelName} unavailable (${is429 ? '429' : '404/503'}) — trying next…`);
        }
        break;
      }
    }
  }

  _aiUsage.failedCalls++;
  const finalErr = new Error(
    'All Gemini models are currently unavailable. The free-tier daily quota may be exhausted. ' +
    'Quota resets at midnight PT. To remove limits visit https://aistudio.google.com and enable billing.'
  );
  finalErr.quotaExhausted = true;
  throw finalErr;
}

// JWT Token Generation
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

// JWT Verification Middleware
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Middleware to verify user authentication and role
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    // Get user from MongoDB (userId stored as string in JWT)
    let lookupId;
    try { lookupId = new ObjectId(decoded.userId); } catch (_) { lookupId = decoded.userId; }
    const user = await db.collection('profiles').findOne({ _id: lookupId });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({ error: 'Authentication error' });
  }
};

// Tenant-specific auth middleware — checks tenants first, then profiles (unified login)
const requireTenantAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    let lookupId;
    try { lookupId = new ObjectId(decoded.userId); } catch (_) { lookupId = decoded.userId; }

    // Try tenants collection first, then fall back to profiles (for unified-login users)
    let user = await db.collection('tenants').findOne({ $or: [{ _id: lookupId }, { profileId: lookupId }] });
    if (!user) {
      const profile = await db.collection('profiles').findOne({ _id: lookupId });
      if (profile) {
        // Find matching tenant by email for extra data; use profile as fallback
        const tByEmail = profile.email
          ? await db.collection('tenants').findOne({ email: profile.email.toLowerCase() })
          : null;
        user = tByEmail
          ? { ...tByEmail, _id: tByEmail._id, profileId: profile._id, email: profile.email, name: profile.name || tByEmail.fullName }
          : { _id: profile._id, email: profile.email, name: profile.name, fullName: profile.name, phone: profile.phone };
      }
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication error' });
  }
};

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) {
    return '254' + digits.slice(1);
  }
  if (/^7\d{8}$/.test(digits)) {
    return '254' + digits;
  }
  if (/^254[17]\d{8}$/.test(digits)) {
    return digits;
  }
  return null;
}

function getTimestamp() {
  const d = new Date();
  const YYYY = d.getFullYear().toString();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${YYYY}${MM}${DD}${hh}${mm}${ss}`;
}

function getPassword(timestamp) {
  const password = `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`;
  return Buffer.from(password).toString('base64');
}

async function fetchMpesaToken() {
  const url = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`,
    },
  });
  return response.data.access_token;
}

function scoreProductForRecommendation(product, query = '') {
  const searchTerms = (query || '').toLowerCase().split(/\W+/).filter(Boolean);
  const text = `${product.name || ''} ${product.description || ''} ${product.category || ''} ${(product.profiles?.name) || ''}`.toLowerCase();

  let score = 0;
  if (product.premium_featured) score += 70;
  if (product.premium_trending) score += 50;
  if (product.premium_stream) score += 30;

  const featuredKeywords = /\b(best|top|premium|exclusive|official|recommended|trusted|verified)\b/;
  const trendingKeywords = /\b(popular|hot|deal|discount|urgent|new|latest)\b/;
  const streamKeywords = /\b(service|housing|rent|lease|booking|stream)\b/;

  if (featuredKeywords.test(text)) score += 20;
  if (trendingKeywords.test(text)) score += 15;
  if (streamKeywords.test(text)) score += 10;

  searchTerms.forEach(term => {
    if (!term) return;
    if ((product.name || '').toLowerCase().includes(term)) score += 30;
    if ((product.description || '').toLowerCase().includes(term)) score += 15;
    if ((product.category || '').toLowerCase().includes(term)) score += 10;
    if ((product.profiles?.name || '').toLowerCase().includes(term)) score += 5;
  });

  return score;
}

app.post('/stk-push', async (req, res) => {
  try {
    const { item, amount, phone, seller_id, product_id, product_ids, buyer_id, buyer_name, payment_type, property_code, property_id, buyer_email } = req.body;

    if (!item || !amount || !phone) {
      return res.status(400).json({ error: 'Missing required fields: item, amount, phone.' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Phone number must be numeric and valid (07XXXXXXXX or 2547XXXXXXXX).'});
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a valid positive number.' });
    }

    const paymentItem = item.toString().trim().substring(0, 100);
    const orderId = `BC${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`;

    // Resolve buyer_id from auth token if not provided
    const resolvedBuyerId = buyer_id || (req.user ? String(req.user._id) : null);
    const resolvedBuyerName = buyer_name || (req.user ? (req.user.full_name || req.user.name || req.user.email || null) : null);

    // AUTO-SUCCEED: create order directly as COMPLETE (bypassing M-PESA for now)
    const mongoResponse = await db.collection('orders').insertOne({
      order_id: orderId,
      item: paymentItem,
      amount: parsedAmount,
      phone: normalizedPhone,
      payment_method: 'M-PESA',
      payment_status: 'COMPLETE',
      status: 'completed',
      seller_id: seller_id || null,
      product_id: product_id || null,
      product_ids: product_ids || null,
      buyer_id: resolvedBuyerId,
      buyer_name: resolvedBuyerName,
      payment_type: payment_type || 'order',
      property_code: property_code || null,
      property_id_ref: property_id || null,
      buyer_email: buyer_email || null,
      mpesa_response: { auto_succeeded: true },
      created_at: new Date(),
    });

    if (!mongoResponse.acknowledged) {
      console.error('MongoDB insert error');
      return res.status(500).json({ error: 'Order could not be saved to database.' });
    }

    // Fire updateOrderStatus to trigger seller notifications, transaction update, email, etc.
    try {
      await updateOrderStatus(orderId, 'COMPLETE', { auto_succeeded: true, simulated_at: new Date() });
    } catch (updateErr) {
      console.error('Auto-succeed updateOrderStatus error:', updateErr);
    }

    // Auto-create transaction record as completed
    try {
      await db.collection('transactions').insertOne({
        order_id: orderId,
        user_id: req.user?._id || null,
        amount: parsedAmount,
        currency: 'KES',
        type: 'payment',
        status: 'completed',
        payment_method: 'mpesa',
        transaction_ref: orderId,
        metadata: {
          item: paymentItem,
          phone: normalizedPhone,
          auto_succeeded: true
        },
        created_at: new Date()
      });
    } catch (transError) {
      console.error('Transaction creation error:', transError);
    }

    // Resolve the email to send to — prefer authenticated user, fall back to buyer_email in body
    const recipientEmail = (req.user && req.user.email) ? req.user.email : (buyer_email || null);
    const recipientName  = (req.user ? (req.user.full_name || req.user.name || req.user.email) : null)
                           || resolvedBuyerName || recipientEmail || 'Customer';

    // Notify the buyer and send receipt email (if we have an email address)
    if (req.user && req.user._id) {
      try {
        await db.collection('notifications').insertOne({
          user_id: req.user._id,
          type: 'order',
          title: payment_type === 'deposit' ? 'Deposit Paid — Property Code Inside' : 'Payment Successful',
          message: payment_type === 'deposit'
            ? `Your security deposit of KES ${parsedAmount} for "${paymentItem}" was received. Your property code: ${property_code || 'N/A'}`
            : `Your payment of KES ${parsedAmount} for "${paymentItem}" was successful.`,
          data: { order_id: orderId, amount: parsedAmount, property_code: property_code || null },
          created_at: new Date()
        });
      } catch (notifError) {
        console.error('Notification creation error:', notifError);
      }
    }

    if (recipientEmail) {
      try {
        if (payment_type === 'deposit' && property_code) {
          // Deposit-specific email — prominently shows the property code
          const depositData = {
            orderId,
            item:         paymentItem,
            amount:       parsedAmount,
            phone:        normalizedPhone,
            propertyCode: property_code,
            date:         new Date()
          };
          const { text, html } = depositConfirmationEmail(recipientName, depositData);
          sendEmail(recipientEmail, `Deposit Confirmed — Property Code: ${property_code}`, text, html);
          db.collection('orders').updateOne({ order_id: orderId }, { $set: { receipt_email_sent: true } }).catch(() => {});
        } else if (req.user && req.user.email) {
          // Standard receipt email with PDF for authenticated buyers
          const receiptData = {
            orderId,
            item: paymentItem,
            amount: parsedAmount,
            phone: normalizedPhone,
            paymentType: 'order',
            date: new Date()
          };
          const { text, html } = paymentReceiptEmail(recipientName, receiptData);
          sendEmail(req.user.email, 'Payment Confirmed — BConnect Receipt', text, html);
          db.collection('orders').updateOne({ order_id: orderId }, { $set: { receipt_email_sent: true } }).catch(() => {});
        }
      } catch (emailErr) {
        console.error('STK email error:', emailErr.message);
      }
    }

    return res.json({
      success: true,
      orderId,
      message: 'Payment successful.',
      checkoutRequestID: null,
      mpesaResponse: { auto_succeeded: true },
    });
  } catch (error) {
    console.error(error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Payment failed: ' + (error.message || 'Unknown error') });
  }
});

async function updateOrderStatus(orderId, status, callbackData) {
  const statusFields = { payment_status: status, mpesa_callback: callbackData, updated_at: new Date() };
  if (status === 'COMPLETE') statusFields.status = 'completed';
  if (status === 'FAILED')   statusFields.status = 'failed';

  const response = await db.collection('orders').updateOne(
    { order_id: orderId },
    { $set: statusFields }
  );

  if (response.matchedCount === 0) {
    console.error('Order not found for update');
    throw new Error('Order not found');
  }

  // Auto-create notification for completed orders
  if (status === 'COMPLETE') {
    try {
      // Get order details to create notification
      const orderData = await db.collection('orders').findOne({ order_id: orderId });

      if (orderData) {
        // Update transaction status to completed
        await db.collection('transactions').updateOne(
          { order_id: orderId },
          {
            $set: {
              status: 'completed',
              updated_at: new Date()
            }
          }
        );

        // Notify the seller if this order has a seller_id
        if (orderData.seller_id) {
          try {
            let sellerObjectId;
            try { sellerObjectId = new ObjectId(orderData.seller_id); } catch(e) { sellerObjectId = null; }
            const sellerProfile = sellerObjectId
              ? await db.collection('profiles').findOne({ _id: sellerObjectId })
              : null;

            await db.collection('notifications').insertOne({
              user_id: sellerObjectId || orderData.seller_id,
              type: 'sale',
              title: 'New Sale!',
              message: `You made a sale of KES ${orderData.amount} for "${orderData.item}". Earnings updated on your dashboard.`,
              data: { order_id: orderId, amount: orderData.amount, buyer_name: orderData.buyer_name || 'A buyer' },
              created_at: new Date()
            });

            if (sellerProfile?.email) {
              const sellerName = sellerProfile.full_name || sellerProfile.name || 'Seller';
              const subject = `New Sale on BConnect — KES ${orderData.amount}`;
              const text = `Hi ${sellerName},\n\nGreat news! A buyer just purchased "${orderData.item}" for KES ${orderData.amount}.\n\nOrder Reference: ${orderId}\nBuyer: ${orderData.buyer_name || 'Anonymous'}\n\nLog in to your seller dashboard to view all your orders and earnings.\n\n— The BConnect Team`;
              const html = `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px">
                <h2 style="color:#00e676;margin-bottom:8px"> New Sale!</h2>
                <p style="color:#374151">Hi <strong>${sellerName}</strong>,</p>
                <p style="color:#374151">A buyer just purchased one of your listings!</p>
                <div style="background:#fff;border-radius:10px;padding:16px 20px;margin:16px 0;border-left:4px solid #00e676">
                  <div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px">ITEM</span><br><strong style="color:#0a0f1e">${orderData.item}</strong></div>
                  <div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px">AMOUNT</span><br><strong style="color:#00c45f;font-size:18px">KES ${Number(orderData.amount).toLocaleString()}</strong></div>
                  <div><span style="color:#6b7280;font-size:12px">ORDER REF</span><br><code style="color:#374151;font-size:12px">${orderId}</code></div>
                </div>
                <a href="/seller-dashboard.html" style="display:inline-block;background:#0a0f1e;color:#00e676;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">View Seller Dashboard →</a>
                <p style="color:#9ca3af;font-size:12px;margin-top:20px">— The BConnect Team</p>
              </div>`;
              sendEmail(sellerProfile.email, subject, text, html).catch(e => console.error('Seller sale email error:', e));
            }
          } catch (sellerNotifErr) {
            console.error('Seller sale notification error:', sellerNotifErr);
          }
        }

        // Look up buyer: try phone first, fall back to buyer_id
        let userData = await db.collection('profiles').findOne({ phone: orderData.phone });
        if (!userData && orderData.buyer_id) {
          let buyerObjId;
          try { buyerObjId = new ObjectId(orderData.buyer_id); } catch(e) { buyerObjId = null; }
          if (buyerObjId) userData = await db.collection('profiles').findOne({ _id: buyerObjId });
        }

        if (userData) {
          await db.collection('notifications').insertOne({
            user_id: userData._id,
            type: 'order',
            title: 'Payment Completed',
            message: `Your payment of KES ${orderData.amount} for "${orderData.item}" has been completed successfully.`,
            data: { order_id: orderId, amount: orderData.amount, status: 'completed' },
            created_at: new Date()
          });

          // Send receipt email with PDF — skip if already sent by stk-push for this order
          if (userData.email && !orderData.receipt_email_sent) {
            const receiptData = {
              orderId,
              item: orderData.item,
              amount: orderData.amount,
              phone: orderData.phone,
              paymentType: orderData.payment_type || 'order',
              date: new Date()
            };
            const recipientName = userData.full_name || userData.email;
            const { text, html } = paymentReceiptEmail(recipientName, receiptData);
            sendEmail(userData.email, 'Payment Confirmed — BConnect Receipt', text, html);
          }
        }
      }
    } catch (notifError) {
      console.error('Order completion notification error:', notifError);
      // Don't fail the order update if notification fails
    }
  } else if (status === 'FAILED') {
    try {
      // Update transaction status to failed
      await db.collection('transactions').updateOne(
        { order_id: orderId },
        {
          $set: {
            status: 'failed',
            updated_at: new Date()
          }
        }
      );
    } catch (transError) {
      console.error('Transaction status update error:', transError);
    }
  }

  return response;
}

app.post('/mpesa/callback', async (req, res) => {
  try {
    const body = req.body;
    const callback = body?.Body?.stkCallback || body?.Body?.StkCallback || body?.stkCallback || body;

    if (!callback || typeof callback.ResultCode === 'undefined') {
      console.warn('Invalid STK callback payload', JSON.stringify(body));
      return res.status(400).json({ error: 'Invalid STK callback payload' });
    }

    const resultCode = callback.ResultCode;
    const orderStatus = resultCode === 0 ? 'COMPLETE' : 'FAILED';
    const callbackMetadata = callback.CallbackMetadata?.Item || callback.callbackMetadata?.item || [];
    const accountReference = Array.isArray(callbackMetadata)
      ? callbackMetadata.find(item => item.Name === 'AccountReference' || item.name === 'AccountReference')?.Value
        || callbackMetadata.find(item => item.Name === 'AccountReference' || item.name === 'AccountReference')?.value
      : null;

    if (accountReference) {
      await updateOrderStatus(accountReference, orderStatus, callback);
    } else {
      console.warn('STK callback missing AccountReference, unable to map to order', callback);
    }

    return res.json({ success: true, status: orderStatus });
  } catch (error) {
    console.error('Mpesa callback processing failed:', error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Callback process error' });
  }
});

app.get('/order-status', async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const data = await db.collection('orders').findOne(
      { order_id: orderId },
      { projection: { payment_status: 1, mpesa_response: 1, mpesa_callback: 1 } }
    );

    if (!data) {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.json({
      success: true,
      orderId,
      paymentStatus: data.payment_status,
      mpesaResponse: data.mpesa_response,
      mpesaCallback: data.mpesa_callback,
    });
  } catch (error) {
    console.error('Order status lookup failed:', error);
    return res.status(500).json({ error: 'Order status lookup failed' });
  }
});

app.get('/config', (_req, res) => {
  res.json({
    database: 'MongoDB Atlas',
    // Don't expose any credentials here!
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Detailed health check: MongoDB + optional services + uptime
app.get('/api/health', async (_req, res) => {
  const result = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    environment: NODE_ENV,
    services: {}
  };

  // MongoDB
  if (!process.env.MONGODB_URI) {
    result.services.mongodb = { configured: false, status: 'not_configured' };
  } else if (!db) {
    result.services.mongodb = { configured: true, status: 'disconnected' };
    result.status = 'degraded';
  } else {
    try {
      await db.command({ ping: 1 });
      result.services.mongodb = { configured: true, status: 'connected' };
    } catch (err) {
      result.services.mongodb = { configured: true, status: 'error', message: err.message };
      result.status = 'degraded';
    }
  }

  // Grok AI
  result.services.gemini = {
    configured: Boolean(process.env.XAI_API_KEY),
    status: process.env.XAI_API_KEY ? 'enabled' : 'not_configured'
  };

  // M-Pesa
  const mpesaVars = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL'];
  const mpesaConfigured = mpesaVars.every((v) => Boolean(process.env[v]));
  result.services.mpesa = {
    configured: mpesaConfigured,
    status: mpesaConfigured ? 'enabled' : 'not_configured'
  };

  // Email
  const emailConfigured = Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
  result.services.email = {
    configured: emailConfigured,
    status: emailConfigured ? 'enabled' : 'not_configured'
  };

  res.json(result);
});


// Direct admin access — auto-login page for admin use
app.get('/admin-access', async (req, res) => {
  try {
    if (!db) return res.status(500).send('Database not connected');
    const { key } = req.query;
    const ACCESS_KEY = process.env.ADMIN_SETUP_KEY || 'bconnect-admin-setup-2024';
    if (key !== ACCESS_KEY) return res.status(403).send('Access denied');

    const admin = await db.collection('profiles').findOne({ email: 'githinjibrian49@gmail.com' });
    if (!admin) return res.status(404).send('Admin account not found');

    const token = generateToken(admin._id.toString());
    const user = { id: admin._id.toString(), email: admin.email, name: admin.full_name, role: 'admin' };

    res.send(`<!DOCTYPE html><html><head><title>Admin Access</title></head><body>
      <p style="font-family:sans-serif;padding:20px;">Logging you in...</p>
      <script>
        localStorage.setItem('token', '${token}');
        localStorage.setItem('authToken', '${token}');
        localStorage.setItem('user', '${JSON.stringify(user)}');
        localStorage.setItem('userProfile', '${JSON.stringify({ name: user.name, email: user.email, role: user.role })}');
        window.location.href = '/admin.html';
      </script>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Test email endpoint — send any email type with sample data
app.post('/api/test-email', async (req, res) => {
  try {
    const { to, type = 'welcome' } = req.body;
    if (!to) return res.status(400).json({ error: 'Missing "to" email address' });

    const {
      sendEmail, welcomeEmail, emailVerificationEmail, passwordResetEmail,
      paymentReceiptEmail, bookingConfirmationEmail, landlordPaymentAlertEmail,
      depositConfirmationEmail
    } = require('./email');

    let subject, html, text;

    switch (type) {
      case 'welcome':
        ({ html, text } = welcomeEmail('Jane Mwangi', 'landlord'));
        subject = '👋 Welcome to BConnect!';
        break;
      case 'verify':
        ({ html, text } = emailVerificationEmail('Jane Mwangi', 'https://bconnect.replit.app/verify?token=SAMPLE123'));
        subject = '✅ Verify Your BConnect Email';
        break;
      case 'reset':
        ({ html, text } = passwordResetEmail('Jane Mwangi', 'https://bconnect.replit.app/reset-password?token=SAMPLE123'));
        subject = '🔑 BConnect Password Reset';
        break;
      case 'receipt':
        ({ html, text } = paymentReceiptEmail('Jane Mwangi', {
          orderId: 'ORD-' + Date.now(),
          item: 'Cozy 2BR Apartment – Kilimani',
          amount: 25000,
          phone: '0712345678',
          paymentType: 'rent',
          date: new Date()
        }));
        subject = '🧾 Payment Receipt – BConnect';
        break;
      case 'booking':
        ({ html, text } = bookingConfirmationEmail('Jane Mwangi', {
          propertyName: 'Modern Studio – Westlands',
          location: 'Westlands, Nairobi',
          date: new Date().toLocaleDateString('en-KE'),
          time: '2:00 PM',
          phone: '0712345678'
        }));
        subject = '📅 Viewing Booked – BConnect';
        break;
      case 'landlord-alert':
        ({ html, text } = landlordPaymentAlertEmail('David Kamau', {
          tenantName: 'Jane Mwangi',
          tenantPhone: '0712345678',
          propertyName: 'Cozy 2BR Apartment – Kilimani',
          amount: 25000,
          reference: 'RBK' + Math.floor(Math.random() * 100000),
          paymentType: 'rent',
          date: new Date()
        }));
        subject = '💰 Rent Payment Received – BConnect';
        break;
      case 'deposit':
        ({ html, text } = depositConfirmationEmail('Jane Mwangi', {
          orderId: 'ORD-' + Date.now(),
          item: 'Modern Studio – Westlands',
          amount: 50000,
          phone: '0712345678',
          propertyCode: 'BC' + Math.floor(Math.random() * 900000 + 100000),
          date: new Date()
        }));
        subject = '🏠 Security Deposit Confirmed – BConnect';
        break;
      default:
        return res.status(400).json({ error: `Unknown email type: ${type}` });
    }

    const sent = await sendEmail(to, subject, text, html);

    if (sent) {
      res.json({ success: true, message: `"${type}" email sent to ${to}` });
    } else {
      res.status(500).json({ success: false, message: 'Email not sent — check EMAIL_USER and EMAIL_PASS secrets are configured' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin setup — create first admin user or promote existing user
app.post('/api/admin/setup', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });

    const { email, password, fullName, secretKey } = req.body;

    // Require a setup secret key to prevent abuse
    const SETUP_KEY = process.env.ADMIN_SETUP_KEY || 'bconnect-admin-setup-2024';
    if (secretKey !== SETUP_KEY) {
      return res.status(403).json({ error: 'Invalid setup key' });
    }

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'email, password, and fullName are required' });
    }

    const existing = await db.collection('profiles').findOne({ email: email.toLowerCase() });

    if (existing) {
      // Promote existing user to admin
      await db.collection('profiles').updateOne(
        { email: email.toLowerCase() },
        { $set: { role: 'admin', updatedAt: new Date() } }
      );
      return res.json({ success: true, message: `User ${email} promoted to admin` });
    }

    // Create new admin user
    const hashedPassword = await bcrypt.hash(password, 12);
    const newAdmin = {
      email: email.toLowerCase(),
      full_name: fullName,
      role: 'admin',
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await db.collection('profiles').insertOne(newAdmin);
    const token = generateToken(result.insertedId.toString());

    res.json({ success: true, message: 'Admin account created', token, user: { id: result.insertedId, email, name: fullName, role: 'admin' } });
  } catch (error) {
    console.error('Admin setup error:', error);
    res.status(500).json({ error: 'Setup failed: ' + error.message });
  }
});

// Admin product list for dashboard
app.get('/api/admin/products', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, products: [] });
    }
    
    const products = await db.collection('properties')
      .find({ category: { $ne: 'Housing/Rentals' } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    return res.json({ success: true, products: products || [] });
  } catch (error) {
    console.error('Admin products endpoint error:', error);
    return res.json({ success: true, products: [] });
  }
});

// Update product/property status
app.put('/api/admin/products/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });

    const { id } = req.params;
    const { title, description, price, status, active, images, imageUrl, image_url,
            category, location, bedrooms, bathrooms, deposit, rooms_available, total_rooms } = req.body;

    const updateObject = { updated_at: new Date() };
    if (title !== undefined) updateObject.title = title.trim();
    if (description !== undefined) updateObject.description = description.trim();
    if (price !== undefined) updateObject.price = parseFloat(price);
    if (status !== undefined) updateObject.status = status;
    if (active !== undefined) updateObject.active = active;
    if (category !== undefined) updateObject.category = category.trim();
    if (location !== undefined) updateObject.location = location.trim();
    if (bedrooms !== undefined && bedrooms !== '') updateObject.bedrooms = parseInt(bedrooms);
    if (bathrooms !== undefined && bathrooms !== '') updateObject.bathrooms = parseInt(bathrooms);
    if (deposit !== undefined && deposit !== null && deposit !== '') updateObject.deposit = parseFloat(deposit);
    if (rooms_available !== undefined && rooms_available !== '') updateObject.units_available = parseInt(rooms_available);
    if (total_rooms !== undefined && total_rooms !== '') updateObject.total_units = parseInt(total_rooms);

    const rawImg = imageUrl || image_url || (Array.isArray(images) ? images[0] : images) || null;
    if (rawImg !== null) {
      const imgUrl = rawImg.trim();
      updateObject.images    = imgUrl ? [imgUrl] : [];
      updateObject.imageUrl  = imgUrl;
      updateObject.image_url = imgUrl;
    } else if (Array.isArray(images)) {
      const imgUrl = images[0] || '';
      updateObject.images    = images;
      updateObject.imageUrl  = imgUrl;
      updateObject.image_url = imgUrl;
    }

    const result = await db.collection('properties').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateObject }
    );

    if (result.matchedCount === 0) return res.status(404).json({ error: 'Product not found' });
    return res.json({ success: true, message: 'Product updated successfully' });
  } catch (error) {
    console.error('Item update endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Toggle featured status
app.patch('/api/admin/products/:id/featured', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const item = await db.collection('properties').findOne({ _id: new ObjectId(id) });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const newVal = !item.premium_featured;
    await db.collection('properties').updateOne(
      { _id: new ObjectId(id) },
      { $set: { premium_featured: newVal, updated_at: new Date() } }
    );
    return res.json({ success: true, premium_featured: newVal });
  } catch (error) {
    console.error('Toggle featured error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete product
app.delete('/api/admin/products/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const result = await db.collection('properties').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Product not found' });
    return res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Product deletion failed:', error);
    return res.status(500).json({ error: 'Product deletion failed' });
  }
});

// Update service
app.put('/api/admin/services/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });

    const { id } = req.params;
    const { title, description, price, status, active, images, imageUrl, image_url } = req.body;

    const updateObject = { updated_at: new Date() };
    if (title) updateObject.title = title.trim();
    if (description !== undefined) updateObject.description = description.trim();
    if (price) updateObject.price = parseFloat(price);
    if (status) updateObject.status = status;
    if (active !== undefined) updateObject.active = active;

    // Normalise image — always store both images[] AND imageUrl/image_url
    const rawImg = imageUrl || image_url || (Array.isArray(images) ? images[0] : images) || null;
    if (rawImg !== null) {
      const imgUrl = rawImg.trim();
      updateObject.images    = imgUrl ? [imgUrl] : [];
      updateObject.imageUrl  = imgUrl;
      updateObject.image_url = imgUrl;
    } else if (Array.isArray(images)) {
      const imgUrl = images[0] || '';
      updateObject.images    = images;
      updateObject.imageUrl  = imgUrl;
      updateObject.image_url = imgUrl;
    }

    const result = await db.collection('services').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateObject }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    return res.json({ success: true, message: 'Service updated successfully' });
  } catch (error) {
    console.error('Service update endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete service
app.delete('/api/admin/services/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const result = await db.collection('services').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Service not found' });
    return res.json({ success: true, message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Service deletion failed:', error);
    return res.status(500).json({ error: 'Service deletion failed' });
  }
});

// Admin services list for dashboard
app.get('/api/admin/services', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, services: [] });
    // Fetch from both: dedicated services collection AND properties with service category
    const [fromServicesCol, fromProperties] = await Promise.all([
      db.collection('services').find({}).sort({ created_at: -1 }).limit(200).toArray().catch(() => []),
      db.collection('properties')
        .find({ category: { $in: ['services', 'service'] } })
        .sort({ created_at: -1 }).limit(200).toArray()
    ]);
    // Merge and deduplicate by _id
    const seen = new Set();
    const services = [...fromServicesCol, ...fromProperties].filter(s => {
      const k = String(s._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return res.json({ success: true, services });
  } catch (error) {
    console.error('Admin services endpoint error:', error);
    return res.json({ success: true, services: [] });
  }
});

// Toggle featured for service
app.patch('/api/admin/services/:id/featured', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const item = await db.collection('services').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Service not found' });
    const newVal = !item.premium_featured;
    await db.collection('services').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { premium_featured: newVal, updated_at: new Date() } }
    );
    return res.json({ success: true, premium_featured: newVal });
  } catch (e) { return res.status(500).json({ error: 'Server error' }); }
});

// Toggle featured for property
app.patch('/api/admin/properties/:id/featured', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const item = await db.collection('properties').findOne({ _id: new ObjectId(req.params.id) });
    if (!item) return res.status(404).json({ error: 'Property not found' });
    const newVal = !item.premium_featured;
    await db.collection('properties').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { premium_featured: newVal, updated_at: new Date() } }
    );
    return res.json({ success: true, premium_featured: newVal });
  } catch (e) { return res.status(500).json({ error: 'Server error' }); }
});

// Add new service (admin)
app.post('/api/admin/services', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { title, description, price, category, location, imageUrl, images } = req.body;
    if (!title || !category) return res.status(400).json({ error: 'Title and category are required' });
    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []);
    const imgUrl = imgArr[0] || imageUrl || '';
    const doc = {
      title: title.trim(),
      description: (description || '').trim(),
      price: parseFloat(price) || 0,
      category: category.trim(),
      location: (location || '').trim(),
      images: imgArr,
      imageUrl: imgUrl,
      image_url: imgUrl,
      service_type: category.trim(),
      active: true,
      created_at: new Date(),
      updated_at: new Date()
    };
    const result = await db.collection('services').insertOne(doc);
    return res.status(201).json({ success: true, service: { ...doc, _id: result.insertedId } });
  } catch (err) {
    console.error('Add service error:', err);
    return res.status(500).json({ error: 'Failed to add service' });
  }
});

// Add new housing property listing (admin)
app.post('/api/admin/properties', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { title, description, price, location, bedrooms, bathrooms, imageUrl, images,
            deposit, rooms_available, total_rooms, property_type } = req.body;
    if (!title || !location) return res.status(400).json({ error: 'Title and location are required' });
    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []);
    const imgUrl = imgArr[0] || imageUrl || '';
    const doc = {
      title: title.trim(),
      description: (description || '').trim(),
      price: parseFloat(price) || 0,
      category: 'Housing/Rentals',
      location: location.trim(),
      bedrooms: bedrooms ? parseInt(bedrooms) : null,
      bathrooms: bathrooms ? parseInt(bathrooms) : null,
      property_type: property_type || null,
      deposit: deposit ? parseFloat(deposit) : null,
      units_available: rooms_available ? parseInt(rooms_available) : null,
      total_units: total_rooms ? parseInt(total_rooms) : null,
      images: imgArr,
      imageUrl: imgUrl,
      image_url: imgUrl,
      active: true,
      status: 'available',
      created_at: new Date(),
      updated_at: new Date()
    };
    const result = await db.collection('properties').insertOne(doc);
    return res.status(201).json({ success: true, property: { ...doc, _id: result.insertedId } });
  } catch (err) {
    console.error('Add property error:', err);
    return res.status(500).json({ error: 'Failed to add property' });
  }
});

// Get admin dashboard statistics
app.get('/api/admin/stats', async (req, res) => {
  try {
    if (!db) {
      return res.json({
        success: true,
        stats: {
          totalUsers: 0,
          totalOrders: 0,
          totalRevenue: 0,
          activeListings: 0,
          todayRevenue: 0
        }
      });
    }
    
    // Get total users count from MongoDB
    const totalUsers = await db.collection('profiles').countDocuments();
    
    // Get total orders count
    const totalOrders = await db.collection('orders').countDocuments();
    
    // Get total revenue from completed orders
    const revenueData = await db.collection('orders')
      .find({ status: 'delivered' })
      .project({ total_amount: 1 })
      .toArray();
    
    const totalRevenue = revenueData.reduce((sum, order) => sum + (order.total_amount || 0), 0);
    
    // Get active listings (properties with status available)
    const activeListings = await db.collection('properties')
      .countDocuments({ status: 'available' });
    
    // Calculate today's revenue
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRevenueData = await db.collection('orders')
      .find({ 
        status: 'delivered',
        created_at: { $gte: today }
      })
      .project({ total_amount: 1 })
      .toArray();
    
    const todayRevenue = todayRevenueData.reduce((sum, order) => sum + (order.total_amount || 0), 0);
    
    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalOrders: totalOrders || 0,
        totalRevenue,
        activeListings: activeListings || 0,
        todayRevenue
      }
    });

  } catch (error) {
    console.error('Admin stats endpoint error:', error);
    res.json({
      success: true,
      stats: {
        totalUsers: 0,
        totalOrders: 0,
        totalRevenue: 0,
        activeListings: 0,
        todayRevenue: 0
      }
    });
  }
});

// Get users for admin management
app.get('/api/admin/users', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, users: [] });
    }
    
    const users = await db.collection('profiles')
      .find({})
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    res.json({ success: true, users: users || [] });
  } catch (error) {
    console.error('Admin users endpoint error:', error);
    res.json({ success: true, users: [] });
  }
});

// GET /api/admin/unverified-users — fetch all accounts pending email verification
app.get('/api/admin/unverified-users', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, users: [], total: 0 });
    const users = await db.collection('profiles')
      .find({ email_verified: false })
      .sort({ created_at: -1 })
      .project({ password: 0, verification_token: 0 })
      .toArray();
    return res.json({ success: true, users, total: users.length });
  } catch (err) {
    console.error('Unverified users error:', err);
    return res.status(500).json({ error: 'Failed to fetch unverified users' });
  }
});

// POST /api/admin/users/:id/verify — manually mark account as verified
app.post('/api/admin/users/:id/verify', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const id = req.params.id;
    const user = await db.collection('profiles').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.collection('profiles').updateOne(
      { _id: new ObjectId(id) },
      { $set: { email_verified: true, updated_at: new Date() }, $unset: { verification_token: '', verification_token_expires: '' } }
    );
    // Send welcome email
    const { text: wText, html: wHtml } = welcomeEmail(user.full_name, user.role);
    sendEmail(user.email, 'Welcome to BConnect!', wText, wHtml);
    return res.json({ success: true, message: 'Account verified and welcome email sent' });
  } catch (err) {
    console.error('Manual verify error:', err);
    return res.status(500).json({ error: 'Failed to verify account' });
  }
});

// POST /api/admin/users/:id/resend-verification — resend verification email to user
app.post('/api/admin/users/:id/resend-verification', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const id = req.params.id;
    const user = await db.collection('profiles').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified) return res.json({ success: true, message: 'Account is already verified' });

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.collection('profiles').updateOne(
      { _id: new ObjectId(id) },
      { $set: { verification_token: verificationToken, verification_token_expires: verificationExpiry } }
    );
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5000';
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;
    const { text: vText, html: vHtml } = emailVerificationEmail(user.full_name, verifyUrl);
    await sendEmail(user.email, 'Verify your BConnect email', vText, vHtml);
    return res.json({ success: true, message: `Verification email sent to ${user.email}` });
  } catch (err) {
    console.error('Admin resend verify error:', err);
    return res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// Create new user (admin)
app.post('/api/admin/users', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }
    
    // Support both full_name (internal) and name (frontend input)
    const full_name = req.body.full_name || req.body.name;
    const { email, role, status } = req.body;
    
    if (!full_name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }
    
    const newUser = {
      full_name,
      email: email.toLowerCase(),
      role: role || 'student',
      status: status || 'active',
      created_at: new Date(),
      updated_at: new Date()
    };
    
    const result = await db.collection('profiles').insertOne(newUser);
    
    res.json({ success: true, message: 'User created successfully', user: { ...newUser, _id: result.insertedId } });
  } catch (error) {
    console.error('Admin create user error:', error);
    res.status(500).json({ error: 'Failed to create user', details: error.message });
  }
});

// Get transactions for admin
app.get('/api/admin/transactions', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }
    
    const { status, date } = req.query;
    
    let query = {};
    if (status && status !== 'all') {
      query.status = status;
    }
    
    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      query.created_at = { $gte: startDate, $lt: endDate };
    }
    
    const transactions = await db.collection('orders')
      .find(query)
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    res.json({ success: true, transactions: transactions || [] });
  } catch (error) {
    console.error('Admin transactions endpoint error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/sellers', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    // Fetch sellers by role (include 'seller' and 'vendor' variants)
    const sellers = await db.collection('profiles')
      .find({ role: { $in: ['seller', 'vendor', 'Seller'] } })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();

    // Also find sellers who have listings but may not have role='seller' exactly
    const listingSellerIds = await db.collection('properties').distinct('seller_id');
    const missingIds = listingSellerIds.filter(sid => {
      if (!sid) return false;
      return !sellers.some(s => String(s._id) === String(sid));
    });
    if (missingIds.length > 0) {
      const { ObjectId } = require('mongodb');
      const extra = await db.collection('profiles').find({
        $or: missingIds.slice(0, 50).map(id => {
          try { return { _id: new ObjectId(id) }; } catch (_) { return null; }
        }).filter(Boolean)
      }).toArray();
      sellers.push(...extra);
    }

    // Enrich with product count and total earnings
    const enriched = await Promise.all(sellers.map(async s => {
      const sid = String(s._id);
      const productCount = await db.collection('properties').countDocuments({ seller_id: sid });
      const earningsAgg = await db.collection('orders').aggregate([
        { $match: { seller_id: sid, $or: [{ status: 'completed' }, { payment_status: 'COMPLETE' }] } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).toArray();
      const totalEarnings = earningsAgg[0]?.total || 0;
      const orderCount = await db.collection('orders').countDocuments({
        seller_id: sid, $or: [{ status: 'completed' }, { payment_status: 'COMPLETE' }]
      });
      const withdrawalAgg = await db.collection('seller_withdrawals').aggregate([
        { $match: { sellerId: sid, status: { $in: ['completed', 'approved', 'pending'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).toArray().catch(() => []);
      const totalWithdrawn = withdrawalAgg[0]?.total || 0;
      const currentBalance = Math.max(0, totalEarnings - totalWithdrawn);
      return { ...s, productCount, totalEarnings, orderCount, totalWithdrawn, currentBalance };
    }));
    return res.json({ success: true, sellers: enriched });
  } catch (error) {
    console.error('Admin sellers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/seller-listings/:sellerId — listings belonging to a specific seller
app.get('/api/admin/seller-listings/:sellerId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, listings: [] });
    const { sellerId } = req.params;
    const listings = await db.collection('properties')
      .find({ seller_id: sellerId })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    return res.json({ success: true, listings });
  } catch (err) {
    console.error('Admin seller-listings error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/buyers — buyers with order count
app.get('/api/admin/buyers', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const buyers = await db.collection('profiles')
      .find({ role: 'buyer' })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    const enriched = await Promise.all(buyers.map(async b => {
      const orderCount = await db.collection('orders').countDocuments({ buyer_id: String(b._id) });
      const totalSpent = await db.collection('orders').aggregate([
        { $match: { buyer_id: String(b._id), status: { $in: ['completed', 'paid'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).toArray();
      return { ...b, orderCount, totalSpent: totalSpent[0]?.total || 0 };
    }));
    return res.json({ success: true, buyers: enriched });
  } catch (error) {
    console.error('Admin buyers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/buyer-orders/:buyerId
app.get('/api/admin/buyer-orders/:buyerId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, orders: [] });
    const { buyerId } = req.params;
    const orders = await db.collection('orders')
      .find({ buyer_id: buyerId })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return res.json({ success: true, orders });
  } catch (err) {
    console.error('Admin buyer-orders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/seller-sales/:sellerId
app.get('/api/admin/seller-sales/:sellerId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, orders: [] });
    const { sellerId } = req.params;
    const orders = await db.collection('orders')
      .find({ seller_id: sellerId })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    return res.json({ success: true, orders });
  } catch (err) {
    console.error('Admin seller-sales error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// GET /api/admin/organizers — event organizers with event count
app.get('/api/admin/organizers', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const organizers = await db.collection('profiles')
      .find({ role: { $in: ['organizer', 'event_organizer'] } })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    const enriched = await Promise.all(organizers.map(async o => {
      const eventCount = await db.collection('events').countDocuments({
        $or: [
          { organizer_email: o.email },
          { organizer_id: String(o._id) }
        ]
      });
      const ticketsSold = await db.collection('tickets').countDocuments({
        organizer_email: o.email
      });
      return { ...o, eventCount, ticketsSold };
    }));
    return res.json({ success: true, organizers: enriched });
  } catch (error) {
    console.error('Admin organizers error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/event-submissions — pending event organizer submissions
app.get('/api/admin/event-submissions', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const submissions = await db.collection('events')
      .find({ status: 'pending' })
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();
    return res.json({ success: true, submissions });
  } catch (error) {
    console.error('Admin event submissions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/event-submissions/:id — approve or reject event submission
app.put('/api/admin/event-submissions/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { ObjectId } = require('mongodb');
    const { action } = req.body;
    const update = action === 'approve'
      ? { $set: { status: 'active', active: true, approved_at: new Date() } }
      : { $set: { status: 'rejected', active: false, rejected_at: new Date() } };
    await db.collection('events').updateOne({ _id: new ObjectId(req.params.id) }, update);
    return res.json({ success: true });
  } catch (error) {
    console.error('Admin event submission update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/users/:id/role — change user role
app.put('/api/admin/users/:id/role', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { ObjectId } = require('mongodb');
    const { role } = req.body;
    const validRoles = ['buyer', 'seller', 'tenant', 'landlord', 'organizer', 'admin'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    await db.collection('profiles').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { role, updated_at: new Date() } }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Admin change role error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get product submissions for admin review
app.get('/api/admin/submissions', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const [sellerSubmissions, housingSubmissions] = await Promise.all([
      db.collection('properties').find({ status: 'pending', active: false }).sort({ created_at: -1 }).limit(100).toArray(),
      db.collection('landlord_properties').find({ marketplaceStatus: 'pending' }).sort({ updatedAt: -1 }).limit(100).toArray()
    ]);
    const normalizedHousing = housingSubmissions.map(p => ({
      _id: p._id,
      _source: 'landlord_property',
      title: p.name || 'Property',
      name: p.name || 'Property',
      location: p.location || '',
      price: p.rent || p.monthlyRent || 0,
      rent: p.rent || p.monthlyRent || 0,
      deposit: p.deposit || 0,
      subcategory: p.subcategory || '',
      rooms_remaining: p.roomsRemaining || 0,
      bedrooms: p.bedrooms || '',
      amenities: p.amenities || '',
      description: p.description || '',
      imageUrl: p.imageUrl || p.image_url || '',
      category: 'housing',
      seller_name: p.landlordName || 'Landlord',
      seller_email: p.landlordEmail || '',
      status: 'pending',
      created_at: p.updatedAt || p.createdAt
    }));
    return res.json({ success: true, submissions: [...sellerSubmissions, ...normalizedHousing] });
  } catch (error) {
    console.error('Admin submissions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update submission status (approve/reject)
app.put('/api/admin/submissions/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const { action, rejection_reason, _source } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

    // Housing listings from landlord_properties use a different collection + fields
    if (_source === 'landlord_property') {
      const updateData = {
        marketplaceStatus: action === 'approve' ? 'approved' : 'rejected',
        listOnMarketplace: action === 'approve',
        updatedAt: new Date()
      };
      if (action === 'reject' && rejection_reason) updateData.rejectionReason = rejection_reason;
      const result = await db.collection('landlord_properties').updateOne({ _id: new ObjectId(id) }, { $set: updateData });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Submission not found' });
      return res.json({ success: true });
    }

    // Default: seller product/service submissions in properties collection
    const updateData = {
      status:     action === 'approve' ? 'active' : 'rejected',
      active:     action === 'approve',
      updated_at: new Date()
    };
    if (action === 'reject' && rejection_reason) updateData.rejection_reason = rejection_reason;
    if (action === 'approve') updateData.rejection_reason = null;
    const result = await db.collection('properties').updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Submission not found' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Admin submission update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});


// Get products for marketplace (includes products, services, and housing)
// Image URL sanitizer: strips leading non-URL characters, whitespace, and invalid entries
function sanitizeImageUrl(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;
  // Find the first occurrence of http(s):// and trim everything before it (handles emojis, arrows, labels, etc.)
  const m = s.match(/https?:\/\/\S+/);
  if (m) s = m[0];
  // Drop trailing punctuation that often gets pasted with URLs
  s = s.replace(/[)\],;.]+$/g, '');
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}
function sanitizeImages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(sanitizeImageUrl).filter(Boolean);
}

// ============ HOMEPAGE COMBINED ENDPOINT (in-memory cache 30s) ============
const _homepageCache = { data: null, expiresAt: 0 };

app.get('/api/homepage', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, sliders: [], products: [], services: [], housing: [], featured: [] });

    const now = Date.now();
    if (_homepageCache.data && now < _homepageCache.expiresAt) {
      res.set('X-Cache', 'HIT');
      return res.json(_homepageCache.data);
    }

    const [sliders, products, services, housing, featured] = await Promise.all([
      db.collection('sliders').find({ active: true }).sort({ order: 1 }).limit(20).toArray().catch(() => []),
      db.collection('properties').find({ active: true, $and: [{ listing_type: { $nin: ['service', 'housing'] } }, { category: { $not: /^service/i } }, { category: { $not: /^housing/i } }, { category: { $not: /rental/i } }] }).sort({ created_at: -1 }).limit(12).toArray().catch(() => []),
      db.collection('properties').find({ active: true, $or: [{ listing_type: 'service' }, { category: { $regex: /^service/i } }] }).sort({ created_at: -1 }).limit(6).toArray().catch(() => []),
      db.collection('properties').find({ active: true, $or: [{ listing_type: 'housing' }, { category: { $regex: /^housing/i } }, { category: { $regex: /rental/i } }] }).sort({ created_at: -1 }).limit(6).toArray().catch(() => []),
      db.collection('properties').find({ active: true, premium_featured: true }).sort({ created_at: -1 }).limit(12).toArray().catch(() => [])
    ]);

    const result = { success: true, sliders, products, services, housing, featured };
    _homepageCache.data = result;
    _homepageCache.expiresAt = now + 30000;

    res.set('X-Cache', 'MISS');
    res.json(result);
  } catch (error) {
    console.error('Homepage API error:', error);
    res.json({ success: true, sliders: [], products: [], services: [], housing: [], featured: [] });
  }
});

// ── Featured Sellers ────────────────────────────────────────────────────────
// GET /api/featured-sellers — public; returns up to 5 pinned sellers with profile + one listing
app.get('/api/featured-sellers', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, sellers: [] });
    const settingsDoc = await db.collection('settings').findOne({ _id: 'featured_sellers' }).catch(() => null);
    const pinnedIds = settingsDoc?.sellerIds || [];
    let profiles = [];
    if (pinnedIds.length > 0) {
      const oids = pinnedIds.map(id => { try { return new ObjectId(id); } catch(_) { return null; } }).filter(Boolean);
      profiles = await db.collection('profiles').find({ _id: { $in: oids } }).toArray();
      profiles.sort((a, b) => pinnedIds.indexOf(String(a._id)) - pinnedIds.indexOf(String(b._id)));
    } else {
      const topIds = await db.collection('properties').aggregate([
        { $match: { active: true, seller_id: { $exists: true, $ne: null } } },
        { $group: { _id: '$seller_id', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]).toArray();
      const oids = topIds.map(t => { try { return new ObjectId(t._id); } catch(_) { return null; } }).filter(Boolean);
      if (oids.length > 0) profiles = await db.collection('profiles').find({ _id: { $in: oids } }).toArray();
    }
    const result = await Promise.all(profiles.slice(0, 5).map(async p => {
      const sid = String(p._id);
      const listings = await db.collection('properties')
        .find({ seller_id: sid, active: true })
        .sort({ created_at: -1 })
        .limit(8)
        .toArray();
      const listingCount = await db.collection('properties').countDocuments({ seller_id: sid, active: true });
      return {
        _id: sid,
        name: p.full_name || p.name || p.business_name || p.email || 'BConnect Seller',
        avatar_url: p.avatar_url || null,
        listings,
        listingCount
      };
    }));
    res.json({ success: true, sellers: result.filter(s => s.listings && s.listings.length > 0) });
  } catch (err) {
    console.error('Featured sellers error:', err);
    res.json({ success: true, sellers: [] });
  }
});

// GET /api/admin/featured-sellers — returns current pinned seller IDs
app.get('/api/admin/featured-sellers', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, sellerIds: [] });
    const doc = await db.collection('settings').findOne({ _id: 'featured_sellers' }).catch(() => null);
    res.json({ success: true, sellerIds: doc?.sellerIds || [] });
  } catch (err) {
    res.json({ success: true, sellerIds: [] });
  }
});

// POST /api/admin/featured-sellers — save up to 5 seller IDs
app.post('/api/admin/featured-sellers', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { sellerIds } = req.body;
    if (!Array.isArray(sellerIds)) return res.status(400).json({ error: 'sellerIds must be an array' });
    const ids = sellerIds.slice(0, 5).map(String);
    await db.collection('settings').updateOne(
      { _id: 'featured_sellers' },
      { $set: { sellerIds: ids, updatedAt: new Date() } },
      { upsert: true }
    );
    _homepageCache.data = null;
    res.json({ success: true, sellerIds: ids });
  } catch (err) {
    console.error('Save featured sellers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    // Check if MongoDB is connected
    if (!db) {
      return res.json({ success: true, products: [] });
    }

    const { category, search, premium, all, seller_id, location } = req.query;

    // Build MongoDB query
    const query = {};
    
    // Filter by category - but be flexible (show all if no match)
    if (category && category !== 'all') {
      query.category = category;
    }
    
    // Always enforce active:true for non-admin requests (all=true no longer bypasses this)
    if (!req.query.admin) {
      query.active = true;
    }

    // Seller filter
    if (seller_id) {
      query.seller_id = seller_id;
    }

    // Location filter
    if (location && location !== 'all') {
      query.location = { $regex: location, $options: 'i' };
    }

    // Exclude service and housing types from the products endpoint
    // Services go to /api/services, housing goes to /api/properties
    if (!category || category === 'all') {
      query.$and = query.$and || [];
      // Exclude by listing_type (set at submission time)
      query.$and.push({ listing_type: { $nin: ['service', 'housing'] } });
      // Also exclude by category string (catches legacy data and admin-added items)
      query.$and.push({
        $and: [
          { category: { $not: /^service/i } },
          { category: { $not: /^housing/i } },
          { category: { $not: /rental/i  } }
        ]
      });
    }
    
    // Search filter
    if (search) {
      query.$or = [
        ...(query.$or || []),
        { title: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Premium filters
    if (premium === 'trending') {
      query.premium_trending = true;
    } else if (premium === 'featured') {
      query.premium_featured = true;
    }

    // Fetch from MongoDB - with error handling
    let products = [];
    try {
      products = await db.collection('properties')
        .find(query)
        .sort({ created_at: -1 })
        .toArray();
    } catch (mongoError) {
      console.error('MongoDB query error:', mongoError);
      return res.json({ success: true, products: [] });
    }

    // If category filter returns no results, try without category filter
    // but still exclude service and housing types
    if (category && category !== 'all' && products.length === 0) {
      delete query.category;
      // Re-add the type exclusions in the fallback
      if (!req.query.admin) {
        query.$and = query.$and || [];
        const hasTypeExclusion = query.$and.some(c => c.listing_type);
        if (!hasTypeExclusion) {
          query.$and.push({ listing_type: { $nin: ['service', 'housing'] } });
          query.$and.push({
            $and: [
              { category: { $not: /^service/i } },
              { category: { $not: /^housing/i } },
              { category: { $not: /rental/i  } }
            ]
          });
        }
      }
      try {
        products = await db.collection('properties')
          .find(query)
          .sort({ created_at: -1 })
          .toArray();
      } catch (mongoError2) {
        console.error('MongoDB fallback query error:', mongoError2);
      }
    }

    // Normalize the data structure (also sanitize image URLs)
    const normalizedResults = (products || []).map(product => {
      const cleanedImages = sanitizeImages(product.images);
      const cleanedImageUrl = sanitizeImageUrl(product.image_url) || cleanedImages[0] || null;
      return {
        ...product,
        name: product.title || product.name,
        price: product.price || product.rent_amount,
        images: cleanedImages,
        image_url: cleanedImageUrl
      };
    });

    return res.json({ success: true, products: normalizedResults });
  } catch (error) {
    console.error('Products endpoint error:', error);
    return res.json({ success: true, products: [] });
  }
});

// Add new product (admin)
app.post('/api/products', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const {
      title,
      description,
      price,
      category,
      subcategory,
      location,
      bedrooms,
      bathrooms,
      property_type,
      images,
      seller_id,
      seller_name,
      service_type,
      delivery_available,
      premium_featured,
      variants
    } = req.body;

    // Validate required fields
    if (!title || !category) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    // Normalise image: always store both images[] and imageUrl so every page can read it
    const imgArr = Array.isArray(images) ? images : (images ? [images] : []);
    const imgUrl = imgArr[0] || '';

    // Normalise variants array
    const normVariants = Array.isArray(variants) ? variants.map(v => ({
      name: (v.name || v.category || '').trim(),
      category: (v.name || v.category || '').trim(),
      size: (v.size || '').trim(),
      color: (v.color || '').trim(),
      price: v.price ? parseFloat(v.price) : null,
      stock: v.stock ? parseInt(v.stock) : 0,
      image: (v.image || '').trim()
    })) : [];

    // Base price: use form price or lowest variant price if variants provided
    const basePrice = price ? parseFloat(price) :
      (normVariants.length ? Math.min(...normVariants.map(v => v.price || Infinity).filter(p => isFinite(p))) : 0);

    // Create product object
    const newProduct = {
      title: title.trim(),
      description: description?.trim() || '',
      price: basePrice,
      category: category,
      subcategory: (subcategory || '').trim() || null,
      location: location?.trim() || '',
      bedrooms: bedrooms ? parseInt(bedrooms) : null,
      bathrooms: bathrooms ? parseInt(bathrooms) : null,
      property_type: property_type || null,
      images: imgArr,
      imageUrl: imgUrl,
      image_url: imgUrl,
      seller_id: seller_id || null,
      seller_name: seller_name || null,
      service_type: service_type || null,
      delivery_available: delivery_available || false,
      premium_featured: !!premium_featured,
      variants: normVariants,
      has_variants: normVariants.length > 0,
      active: true,
      created_at: new Date(),
      updated_at: new Date()
    };

    // Insert into MongoDB
    const result = await db.collection('properties').insertOne(newProduct);

    return res.status(201).json({
      success: true,
      message: 'Product added successfully',
      product: { ...newProduct, _id: result.insertedId }
    });
  } catch (error) {
    console.error('Error adding product:', error);
    return res.status(500).json({ error: 'Failed to add product', details: error.message });
  }
});

// Update product (admin)
app.get('/api/products/:id', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { id } = req.params;
    let product = null;
    try { product = await db.collection('properties').findOne({ _id: new ObjectId(id) }); } catch(e) {}
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.json({ success: true, product });
  } catch (err) {
    console.error('GET /api/products/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const { id } = req.params;
    const { title, description, price, category, location, active, images, imageUrl, image_url, video_url, variants } = req.body;

    const updateData = { updated_at: new Date() };

    if (title) updateData.title = title.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (price) updateData.price = parseFloat(price);
    if (category) updateData.category = category;
    if (location !== undefined) updateData.location = location.trim();
    if (active !== undefined) updateData.active = active;
    if (video_url !== undefined) updateData.video_url = video_url || null;
    if (Array.isArray(variants)) {
      updateData.variants = variants.map(v => ({
        category: (v.category || '').trim(),
        size: (v.size || '').trim(),
        color: (v.color || '').trim(),
        price: v.price ? parseFloat(v.price) : null,
        stock: v.stock ? parseInt(v.stock) : 0,
        image: (v.image || '').trim()
      }));
      updateData.has_variants = updateData.variants.length > 0;
    }

    // Normalise image — always store both images[] AND imageUrl/image_url so every page reads it
    const rawImg = imageUrl || image_url || (Array.isArray(images) ? images[0] : images) || null;
    if (rawImg !== null) {
      const imgUrl = rawImg.trim();
      updateData.images    = imgUrl ? [imgUrl] : [];
      updateData.imageUrl  = imgUrl;
      updateData.image_url = imgUrl;
    } else if (Array.isArray(images)) {
      const imgUrl = images[0] || '';
      updateData.images    = images;
      updateData.imageUrl  = imgUrl;
      updateData.image_url = imgUrl;
    }

    const result = await db.collection('properties').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ success: true, message: 'Product updated successfully' });
  } catch (error) {
    console.error('Error updating product:', error);
    return res.status(500).json({ error: 'Failed to update product', details: error.message });
  }
});

// Update product variants only
app.patch('/api/products/:id/variants', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const { variants } = req.body;
    if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });
    const normVariants = variants.map(v => ({
      name: (v.name || v.category || '').trim(),
      category: (v.name || v.category || '').trim(),
      size: (v.size || '').trim(),
      color: (v.color || '').trim(),
      price: v.price ? parseFloat(v.price) : null,
      stock: v.stock ? parseInt(v.stock) : 0,
      image: (v.image || '').trim()
    }));
    const result = await db.collection('properties').updateOne(
      { _id: new ObjectId(id) },
      { $set: { variants: normVariants, has_variants: normVariants.length > 0, updated_at: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Product not found' });
    return res.json({ success: true, variants: normVariants });
  } catch (error) {
    console.error('Error updating variants:', error);
    return res.status(500).json({ error: 'Failed to update variants', details: error.message });
  }
});

// Delete product (admin)
app.delete('/api/products/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const { id } = req.params;

    const result = await db.collection('properties').deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    return res.status(500).json({ error: 'Failed to delete product', details: error.message });
  }
});

// Get services endpoint (public) — always queries the properties collection
app.get('/api/services', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, services: [] });
    }

    const { search } = req.query;
    const query = {
      active: true,
      $or: [
        { listing_type: 'service' },
        { category: { $regex: /^service/i } }
      ]
    };

    if (search) {
      query.$and = [{
        $or: [
          { title: { $regex: search, $options: 'i' } },
          { name:  { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ]
      }];
    }

    const services = await db.collection('properties')
      .find(query)
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    const normalizedResults = (services || []).map(service => ({
      ...service,
      name:  service.title || service.name,
      price: service.price || service.rate || 0
    }));

    return res.json({ success: true, services: normalizedResults });
  } catch (error) {
    console.error('Services endpoint error:', error);
    return res.json({ success: true, services: [] });
  }
});

// Get housing/rentals listings (public)
app.get('/api/housing', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, properties: [] });
    }

    const { search, type } = req.query;
    const query = {
      active: true,
      $or: [
        { listing_type: 'housing' },
        { category: { $regex: /^housing/i } },
        { category: { $regex: /rental/i  } }
      ]
    };

    if (type && type !== 'all') {
      query.property_type = { $regex: type, $options: 'i' };
    }

    if (search) {
      query.$and = [{
        $or: [
          { title:    { $regex: search, $options: 'i' } },
          { name:     { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } }
        ]
      }];
    }

    const items = await db.collection('properties')
      .find(query)
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    // Also pull landlord properties that are approved (or old ones with no marketplaceStatus)
    const lpQuery = {
      $or: [
        { listOnMarketplace: true, marketplaceStatus: 'approved' },
        { listOnMarketplace: true, marketplaceStatus: { $exists: false } },
        { listOnMarketplace: true, marketplaceStatus: null }
      ]
    };
    if (search) {
      lpQuery.$and = [{ $or: [
        { name:        { $regex: search, $options: 'i' } },
        { location:    { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ]}];
    }
    if (type && type !== 'all') {
      if (!lpQuery.$and) lpQuery.$and = [];
      lpQuery.$and.push({ $or: [{ subcategory: { $regex: type, $options: 'i' } }, { propertyType: { $regex: type, $options: 'i' } }] });
    }
    const landlordProps = await db.collection('landlord_properties')
      .find(lpQuery)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    const normalizedLandlord = landlordProps.map(p => ({
      _id: p._id,
      title: p.name || 'Property',
      name: p.name || 'Property',
      price: p.rent || p.monthlyRent || 0,
      rent: p.rent || p.monthlyRent || 0,
      location: p.location || 'Nairobi, Kenya',
      property_type: p.propertyType || 'house',
      subcategory: p.subcategory || '',
      bedrooms: p.bedrooms || 0,
      description: p.description || '',
      amenities: p.amenities ? (typeof p.amenities === 'string' ? p.amenities.split(',').map(a => a.trim()) : p.amenities) : [],
      image_url: p.image_url || p.imageUrl || '',
      code: p.code || '',
      deposit: p.deposit || Math.round((p.rent || p.monthlyRent || 0) * 2),
      units: p.units || 0,
      rooms_remaining: p.roomsRemaining || p.rooms_remaining || 0,
      listing_type: 'housing',
      category: 'housing',
      isLandlordProperty: true,
      active: true,
      created_at: p.updatedAt || p.createdAt
    }));

    const normalized = (items || []).map(p => ({
      ...p,
      title: p.title || p.name || 'Property',
      price: p.price || p.rent || 0
    }));

    return res.json({ success: true, properties: [...normalized, ...normalizedLandlord] });
  } catch (error) {
    console.error('Housing endpoint error:', error);
    return res.json({ success: true, properties: [] });
  }
});

// Lightweight availability polling endpoint — returns status map for all active listings
app.get('/api/housing/availability', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, availability: {} });

    const [props, lprops] = await Promise.all([
      db.collection('properties').find(
        { active: true, $or: [{ listing_type: 'housing' }, { category: { $regex: /housing|rental/i } }] },
        { projection: { _id: 1, rooms_remaining: 1, units: 1, total_rooms: 1 } }
      ).limit(200).toArray(),
      db.collection('landlord_properties').find(
        { $or: [{ listOnMarketplace: true, marketplaceStatus: 'approved' }, { listOnMarketplace: true, marketplaceStatus: { $exists: false } }] },
        { projection: { _id: 1, roomsRemaining: 1, rooms_remaining: 1, units: 1, total_rooms: 1 } }
      ).limit(200).toArray()
    ]);

    const availability = {};

    const classify = (remaining, total) => {
      const r = remaining || 0;
      if (r === 0) return 'full';
      if (r <= 2) return 'limited';
      return 'available';
    };

    for (const p of props) {
      const r = p.rooms_remaining || 0;
      const u = p.units || p.total_rooms || 0;
      availability[String(p._id)] = { rooms_remaining: r, units: u, status: classify(r, u) };
    }
    for (const p of lprops) {
      const r = p.roomsRemaining || p.rooms_remaining || 0;
      const u = p.units || p.total_rooms || 0;
      availability[String(p._id)] = { rooms_remaining: r, units: u, status: classify(r, u) };
    }

    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, availability });
  } catch (err) {
    console.error('Availability endpoint error:', err);
    return res.json({ success: true, availability: {} });
  }
});

// Endpoint to add sample housing properties (for testing)
app.post('/api/admin/add-sample-housing', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const sampleProperties = [
      {
        title: 'Modern Downtown Apartment',
        description: 'Spacious 2-bedroom apartment in the heart of the city with modern amenities.',
        price: 35000,
        location: 'Nairobi CBD',
        bedrooms: 2,
        bathrooms: 1,
        category: 'housing',
        property_type: 'apartment',
        active: true,
        created_at: new Date()
      },
      {
        title: 'Cozy Suburban House',
        description: '3-bedroom house with garden in quiet residential area.',
        price: 45000,
        location: 'Westlands',
        bedrooms: 3,
        bathrooms: 2,
        category: 'housing',
        property_type: 'house',
        active: true,
        created_at: new Date()
      },
      {
        title: 'Luxury Penthouse Suite',
        description: 'Executive penthouse with panoramic city views and premium finishes.',
        price: 85000,
        location: 'Kilimani',
        bedrooms: 3,
        bathrooms: 3,
        category: 'housing',
        property_type: 'apartment',
        active: true,
        premium_featured: true,
        created_at: new Date()
      },
      {
        title: 'Student Housing - Shared Room',
        description: 'Affordable shared accommodation near universities.',
        price: 12000,
        location: 'Kenyatta University Area',
        bedrooms: 1,
        bathrooms: 1,
        category: 'housing',
        property_type: 'apartment',
        active: true,
        created_at: new Date()
      },
      {
        title: 'Family Villa with Garden',
        description: '4-bedroom villa with spacious garden, perfect for families.',
        price: 75000,
        location: 'Runda',
        bedrooms: 4,
        bathrooms: 3,
        category: 'housing',
        property_type: 'house',
        active: true,
        premium_trending: true,
        created_at: new Date()
      },
      {
        title: 'Studio Apartment',
        description: 'Compact and affordable studio apartment, ideal for young professionals.',
        price: 18000,
        location: 'Mombasa Road',
        bedrooms: 1,
        bathrooms: 1,
        category: 'housing',
        property_type: 'apartment',
        active: true,
        created_at: new Date()
      }
    ];

    const result = await db.collection('properties').insertMany(sampleProperties);
    
    return res.json({ 
      success: true, 
      message: `Added ${result.insertedCount} sample housing properties`,
      insertedCount: result.insertedCount
    });
  } catch (error) {
    console.error('Error adding sample properties:', error);
    return res.status(500).json({ error: 'Failed to add sample properties' });
  }
});

// Get current user profile — works for both unified profiles and legacy tenant-only accounts
app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    let lookupId;
    try { lookupId = new ObjectId(req.userId); } catch (_) { lookupId = req.userId; }

    // 1. Try profiles collection first (main + unified-login accounts)
    let raw = await db.collection('profiles').findOne({ _id: lookupId });

    // 2. Fall back to tenants collection (legacy dedicated tenant accounts)
    if (!raw) {
      const tenant = await db.collection('tenants').findOne({ _id: lookupId }, { projection: { password: 0 } });
      if (tenant) {
        raw = {
          _id: tenant._id,
          name: tenant.fullName || tenant.name || '',
          full_name: tenant.fullName || '',
          email: tenant.email || '',
          phone: tenant.phone || '',
          avatar_url: tenant.avatar_url || null,
          role: 'tenant'
        };
      }
    }

    if (!raw) return res.status(404).json({ error: 'Profile not found' });
    const { password: _pw, ...safeProfile } = raw;
    safeProfile.name = safeProfile.name || safeProfile.full_name || '';
    return res.json({ success: true, profile: safeProfile });
  } catch (error) {
    console.error('Profile lookup failed:', error);
    return res.status(500).json({ error: 'Profile lookup failed' });
  }
});

// Update user profile — works for both unified profiles and legacy tenant-only accounts
app.put('/api/profile', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    let lookupId;
    try { lookupId = new ObjectId(req.userId); } catch (_) { lookupId = req.userId; }

    const { name, phone, location, avatar_url } = req.body;

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ error: 'Name must be a non-empty string' });
    }
    if (phone !== undefined && typeof phone !== 'string') {
      return res.status(400).json({ error: 'Phone must be a string' });
    }
    if (location !== undefined && typeof location !== 'string') {
      return res.status(400).json({ error: 'Location must be a string' });
    }
    if (avatar_url !== undefined && typeof avatar_url !== 'string') {
      return res.status(400).json({ error: 'Avatar URL must be a string' });
    }

    const updates = { updated_at: new Date() };
    if (name !== undefined) {
      updates.name = name.trim();
      updates.full_name = name.trim();
    }
    if (phone !== undefined) updates.phone = phone.trim();
    if (location !== undefined) updates.location = location.trim();
    if (avatar_url !== undefined) updates.avatar_url = avatar_url.trim();

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Determine which collection this user belongs to
    const inProfiles = await db.collection('profiles').findOne({ _id: lookupId }, { projection: { _id: 1 } });
    if (inProfiles) {
      await db.collection('profiles').updateOne({ _id: lookupId }, { $set: updates });
      // Also sync fullName on any linked tenant doc
      if (updates.name) {
        await db.collection('tenants').updateOne({ profileId: lookupId }, { $set: { fullName: updates.name, updatedAt: new Date() } }).catch(() => {});
      }
    } else {
      // Legacy tenant-only account — update in tenants collection
      const tenantUpdates = { updatedAt: new Date() };
      if (updates.name) tenantUpdates.fullName = updates.name;
      if (updates.phone) tenantUpdates.phone = updates.phone;
      if (updates.avatar_url !== undefined) tenantUpdates.avatar_url = updates.avatar_url;
      await db.collection('tenants').updateOne({ _id: lookupId }, { $set: tenantUpdates });
    }

    // Re-fetch and return normalized profile
    let rawProfile = await db.collection('profiles').findOne({ _id: lookupId });
    if (!rawProfile) {
      const t = await db.collection('tenants').findOne({ _id: lookupId }, { projection: { password: 0 } });
      if (t) rawProfile = { _id: t._id, name: t.fullName || '', full_name: t.fullName || '', email: t.email || '', phone: t.phone || '', avatar_url: t.avatar_url || null, role: 'tenant' };
    }
    if (!rawProfile) return res.status(404).json({ error: 'Profile not found' });
    const { password: _pw, ...safeProfile } = rawProfile;
    safeProfile.name = safeProfile.name || safeProfile.full_name || '';
    return res.json({ success: true, profile: safeProfile });
  } catch (error) {
    console.error('Profile update failed:', error);
    return res.status(500).json({ error: 'Profile update failed' });
  }
});

// Admin API Endpoints for Properties Management
// Get all properties for admin dashboard (housing only)
app.get('/api/admin/properties', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }
    
    const { status } = req.query;
    
    let query = { category: 'Housing/Rentals' };
    if (status && status !== 'all') {
      query.status = status;
    }
    
    const properties = await db.collection('properties')
      .find(query)
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    
    return res.json({ success: true, properties: properties || [] });
  } catch (error) {
    console.error('Properties lookup failed:', error);
    return res.json({ success: true, properties: [] });
  }
});

// Get properties statistics for admin dashboard
app.get('/api/admin/properties/stats', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const properties = await db.collection('properties').find({}).limit(1000).toArray();
    const stats = {
      total: properties.length,
      available: properties.filter(item => item.status === 'available').length,
      rented: properties.filter(item => item.status === 'rented').length,
      sold: properties.filter(item => item.status === 'sold').length
    };
    return res.json({ success: true, stats });
  } catch (error) {
    console.error('Properties stats lookup failed:', error);
    return res.json({ success: true, stats: { total: 0, available: 0, rented: 0, sold: 0 } });
  }
});

// Update property status (admin only)
app.put('/api/admin/properties/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejection_reason } = req.body;

    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be active or inactive' });
    }

    const isActive = status === 'active';
    const updateObject = {
      active: isActive,
      updated_at: new Date().toISOString()
    };

    if (!isActive) {
      updateObject.rejection_reason = rejection_reason || null;
    } else {
      updateObject.rejection_reason = null;
    }

    if (!db) return res.status(500).json({ error: 'Database not connected' });
    let filter;
    try { filter = { _id: new ObjectId(id) }; } catch { filter = { id }; }
    const result = await db.collection('properties').findOneAndUpdate(
      filter, { $set: updateObject }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Property not found' });
    return res.json({ success: true, property: result });
  } catch (error) {
    console.error('Property status update failed:', error);
    return res.status(500).json({ error: 'Property status update failed' });
  }
});

// Delete property (admin only)
app.delete('/api/admin/properties/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const result = await db.collection('properties').deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Property not found' });
    return res.json({ success: true, message: 'Property deleted successfully' });
  } catch (error) {
    console.error('Property deletion failed:', error);
    return res.status(500).json({ error: 'Property deletion failed' });
  }
});

// Delete user (admin)
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    let deleted = false;
    for (const col of ['profiles', 'users', 'tenants', 'landlords']) {
      try {
        const r = await db.collection(col).deleteOne({ _id: new ObjectId(id) });
        if (r.deletedCount > 0) { deleted = true; break; }
      } catch (_) {}
    }
    if (!deleted) return res.status(404).json({ error: 'User not found' });
    return res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('User deletion failed:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Ban or hide user (admin)
app.put('/api/admin/users/:id/status', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const { status } = req.body; // 'active', 'banned', 'hidden'
    if (!['active', 'banned', 'hidden'].includes(status)) {
      return res.status(400).json({ error: 'Status must be active, banned, or hidden' });
    }
    let updated = false;
    for (const col of ['profiles', 'users', 'tenants', 'landlords']) {
      try {
        const r = await db.collection(col).updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updated_at: new Date() } }
        );
        if (r.matchedCount > 0) { updated = true; break; }
      } catch (_) {}
    }
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('User status update failed:', error);
    return res.status(500).json({ error: 'Failed to update user status' });
  }
});

// Analytics endpoint for admin dashboard
app.get('/api/admin/analytics', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });

    const uniqueVisitors = await db.collection('users').countDocuments({});
    const orders = await db.collection('orders').find({}).sort({ created_at: -1 }).limit(100).toArray();
    const conversionRate = uniqueVisitors > 0 ? ((orders.length / uniqueVisitors) * 100).toFixed(1) : 0;

    const allOrders = await db.collection('orders').find({ status: 'delivered' }).toArray();
    const housingTotal = allOrders.filter(o => o.category === 'housing').reduce((s, o) => s + (o.total_amount || 0), 0);
    const marketplaceTotal = allOrders.filter(o => o.category === 'marketplace').reduce((s, o) => s + (o.total_amount || 0), 0);
    const servicesTotal = allOrders.filter(o => o.category === 'services').reduce((s, o) => s + (o.total_amount || 0), 0);

    const properties = await db.collection('properties').find({}, { projection: { category: 1 } }).toArray();
    const products = await db.collection('products').find({}, { projection: { category: 1 } }).toArray();
    
    const housingCount = properties?.filter(p => p.category === 'housing').length || 0;
    const marketplaceCount = products?.filter(p => p.category === 'marketplace').length || 0;
    const servicesCount = properties?.filter(p => p.category === 'services').length || 0;
    const total = housingCount + marketplaceCount + servicesCount || 1;
    
    // Monthly revenue data (last 3 months)
    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthName = d.toLocaleString('default', { month: 'short' });
      months.push({ month: monthName, housing: 0, marketplace: 0, services: 0 });
    }
    
    // Calculate monthly totals from orders
    orders?.forEach(order => {
      const orderDate = new Date(order.created_at);
      months.forEach(m => {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - months.indexOf(m), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - months.indexOf(m) + 1, 0);
        if (orderDate >= monthStart && orderDate <= monthEnd) {
          const cat = order.category || 'marketplace';
          if (cat === 'housing') m.housing += order.total_amount || 0;
          else if (cat === 'services') m.services += order.total_amount || 0;
          else m.marketplace += order.total_amount || 0;
        }
      });
    });
    
    res.json({
      success: true,
      analytics: {
        pageViews: totalPageViews * 10 || 0, // Simulated multiplier
        uniqueVisitors,
        avgSession: '5 min', // Would need actual tracking
        conversionRate: parseFloat(conversionRate),
        topCategories: {
          housing: Math.round(housingCount / total * 100),
          marketplace: Math.round(marketplaceCount / total * 100),
          services: Math.round(servicesCount / total * 100)
        },
        revenueByMonth: months,
        totalRevenue: housingTotal + marketplaceTotal + servicesTotal
      }
    });
  } catch (error) {
    console.error('Analytics endpoint error:', error);
    res.status(500).json({ error: 'Unable to fetch analytics' });
  }
});

// ========== COMPREHENSIVE ADMIN INSPECTION ENDPOINTS ==========

// Get all collections summary
app.get('/api/admin/database/summary', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, summary: {} });
    }

    const collections = {
      profiles: await db.collection('profiles').countDocuments(),
      properties: await db.collection('properties').countDocuments(),
      orders: await db.collection('orders').countDocuments(),
      transactions: await db.collection('transactions').countDocuments(),
      notifications: await db.collection('notifications').countDocuments(),
      services: await db.collection('services').countDocuments(),
      payments: await db.collection('payments').countDocuments(),
      maintenance: await db.collection('maintenance').countDocuments(),
    };

    res.json({
      success: true,
      summary: collections,
      totalDocuments: Object.values(collections).reduce((a, b) => a + b, 0),
      database: 'MongoDB Atlas'
    });
  } catch (error) {
    console.error('Database summary error:', error);
    res.json({ success: true, summary: {} });
  }
});

// Get all users/profiles
app.get('/api/admin/database/profiles', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, data: [] });
    }

    const profiles = await db.collection('profiles')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, data: profiles });
  } catch (error) {
    console.error('Profiles fetch error:', error);
    res.json({ success: true, data: [] });
  }
});

// Get all properties
app.get('/api/admin/database/properties', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, data: [] });
    }

    const properties = await db.collection('properties')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, data: properties });
  } catch (error) {
    console.error('Properties fetch error:', error);
    res.json({ success: true, data: [] });
  }
});

// Get all orders with details
app.get('/api/admin/database/orders', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, data: [] });
    }

    const orders = await db.collection('orders')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('Orders fetch error:', error);
    res.json({ success: true, data: [] });
  }
});

// Get all transactions
app.get('/api/admin/database/transactions', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, data: [] });
    }

    const transactions = await db.collection('transactions')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('Transactions fetch error:', error);
    res.json({ success: true, data: [] });
  }
});

// Get all notifications
app.get('/api/admin/database/notifications', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, data: [] });
    }

    const notifications = await db.collection('notifications')
      .find({})
      .sort({ created_at: -1 })
      .limit(100)
      .toArray();

    res.json({ success: true, data: notifications });
  } catch (error) {
    console.error('Notifications fetch error:', error);
    res.json({ success: true, data: [] });
  }
});

// Recent platform activity — last 10 orders + last 5 rent payments merged by date
app.get('/api/admin/recent-activity', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, activities: [] });

    const [orders, rentPayments] = await Promise.all([
      db.collection('orders').find({}).sort({ created_at: -1 }).limit(10).toArray(),
      db.collection('rent_payments').find({}).sort({ createdAt: -1 }).limit(5).toArray()
    ]);

    const activities = [
      ...orders.map(o => ({
        type: 'order',
        icon: '🛒',
        label: o.item || o.item_name || 'Product purchase',
        who: o.buyer_name || o.buyer_email || 'A buyer',
        amount: o.amount,
        status: o.status || o.payment_status || 'completed',
        date: o.created_at
      })),
      ...rentPayments.map(p => ({
        type: 'rent',
        icon: '🏠',
        label: p.propertyName || 'Rent payment',
        who: p.tenantName || 'A tenant',
        amount: p.amount,
        status: p.status || 'completed',
        date: p.createdAt || p.paidAt
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 12);

    res.json({ success: true, activities });
  } catch (err) {
    console.error('Recent activity error:', err);
    res.json({ success: true, activities: [] });
  }
});

// Get system activity log
app.get('/api/admin/system/activity', async (req, res) => {
  try {
    const activity = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV,
      serverInfo: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem()
      }
    };

    res.json({ success: true, activity });
  } catch (error) {
    console.error('Activity fetch error:', error);
    res.json({ success: true, activity: {} });
  }
});

// Get detailed system statistics
app.get('/api/admin/system/stats', async (req, res) => {
  try {
    if (!db) {
      return res.json({ success: true, stats: {} });
    }

    const stats = {
      totalUsers: await db.collection('profiles').countDocuments(),
      totalListings: await db.collection('properties').countDocuments(),
      totalOrders: await db.collection('orders').countDocuments(),
      totalTransactions: await db.collection('transactions').countDocuments(),
      totalNotifications: await db.collection('notifications').countDocuments(),
      
      // Order statistics
      ordersCompleted: await db.collection('orders').countDocuments({ status: 'delivered' }),
      ordersPending: await db.collection('orders').countDocuments({ status: 'pending' }),
      ordersFailed: await db.collection('orders').countDocuments({ status: 'failed' }),
      
      // Revenue statistics
      totalRevenue: await db.collection('orders')
        .aggregate([
          { $match: { status: 'delivered' } },
          { $group: { _id: null, total: { $sum: '$total_amount' } } }
        ])
        .toArray()
        .then(res => res[0]?.total || 0),
      
      // User statistics
      usersByRole: await db.collection('profiles')
        .aggregate([
          { $group: { _id: '$role', count: { $sum: 1 } } }
        ])
        .toArray()
    };

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Stats fetch error:', error);
    res.json({ success: true, stats: {} });
  }
});

// Search across all collections
app.get('/api/admin/database/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || !db) {
      return res.json({ success: true, results: {} });
    }

    const searchRegex = new RegExp(query, 'i');
    
    const results = {
      profiles: await db.collection('profiles')
        .find({
          $or: [
            { email: searchRegex },
            { name: searchRegex },
            { phone: searchRegex }
          ]
        })
        .limit(10)
        .toArray(),
      
      properties: await db.collection('properties')
        .find({
          $or: [
            { title: searchRegex },
            { description: searchRegex },
            { category: searchRegex }
          ]
        })
        .limit(10)
        .toArray(),
      
      orders: await db.collection('orders')
        .find({
          $or: [
            { order_id: searchRegex },
            { item: searchRegex }
          ]
        })
        .limit(10)
        .toArray()
    };

    res.json({ success: true, results });
  } catch (error) {
    console.error('Search error:', error);
    res.json({ success: true, results: {} });
  }
});

// ============ SLIDER / BANNER MANAGEMENT ============
app.get('/api/sliders', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const sliders = await db.collection('sliders').find({ active: true }).sort({ order: 1 }).toArray();
    res.json({ success: true, sliders });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sliders' });
  }
});

app.get('/api/admin/sliders', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const sliders = await db.collection('sliders').find({}).sort({ order: 1 }).toArray();
    res.json({ success: true, sliders });
  } catch (error) {
    console.error('Sliders fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch sliders' });
  }
});

app.post('/api/admin/sliders', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { title, subtitle, imageUrl, link, buttonText, active, order, type } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const newSlider = {
      title,
      subtitle: subtitle || '',
      imageUrl: imageUrl || '',
      link: link || '#',
      buttonText: buttonText || 'Learn More',
      type: type || 'Banner',
      active: active !== false,
      order: typeof order === 'number' ? order : 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await db.collection('sliders').insertOne(newSlider);
    res.json({ success: true, slider: { ...newSlider, _id: result.insertedId } });
  } catch (error) {
    console.error('Create slider error:', error);
    res.status(500).json({ error: 'Failed to create slider' });
  }
});

app.put('/api/admin/sliders/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const { title, subtitle, imageUrl, link, buttonText, active, order } = req.body;
    const result = await db.collection('sliders').updateOne(
      { _id: new ObjectId(id) },
      { $set: { title, subtitle, imageUrl, link, buttonText, type: req.body.type || 'Banner', active, order: typeof order === 'number' ? order : 0, updatedAt: new Date() } }
    );
    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error('Update slider error:', error);
    res.status(500).json({ error: 'Failed to update slider' });
  }
});

app.delete('/api/admin/sliders/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const result = await db.collection('sliders').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Delete slider error:', error);
    res.status(500).json({ error: 'Failed to delete slider' });
  }
});

// Delete endpoint for admin cleanup (requires confirmation)
app.delete('/api/admin/database/:collection/:id', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const { collection, id } = req.params;
    const allowedCollections = ['profiles', 'properties', 'orders', 'transactions', 'notifications'];
    
    if (!allowedCollections.includes(collection)) {
      return res.status(400).json({ error: 'Invalid collection' });
    }

    const result = await db.collection(collection).deleteOne({ _id: new ObjectId(id) });
    
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

//  Admin: Tenants with linked landlord 
app.get('/api/admin/tenants', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, tenants: [] });

    const tenants = await db.collection('tenants').find({}).sort({ createdAt: -1 }).toArray();

    const enriched = await Promise.all(tenants.map(async (tenant) => {
      // Match by tenant._id OR profileId (tenants who linked via unified-profile login
      // store their profile _id as tenantId in tenant_properties)
      const tenantIdQuery = { $or: [{ tenantId: tenant._id }] };
      if (tenant.profileId) {
        tenantIdQuery.$or.push({ tenantId: tenant.profileId });
      }
      const links = await db.collection('tenant_properties')
        .find(tenantIdQuery)
        .toArray();

      // Collect all tenant IDs used in these links for payment lookups
      const allTenantIds = [tenant._id];
      if (tenant.profileId) allTenantIds.push(tenant.profileId);

      const linkedProperties = await Promise.all(links.map(async (link) => {
        let property = null;
        try {
          property = await db.collection('landlord_properties').findOne({ _id: link.propertyId });
        } catch (_) {}

        let landlord = null;
        if (property?.landlordId) {
          try {
            landlord = await db.collection('landlords').findOne({ _id: property.landlordId });
          } catch (_) {}
        }

        const payments = await db.collection('rent_payments')
          .find({ tenantId: { $in: allTenantIds }, propertyId: link.propertyId })
          .sort({ paidAt: -1 })
          .toArray();

        const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0);

        return {
          linkId: link._id,
          propertyId: link.propertyId,
          propertyName: property?.name || link.propertyName || '—',
          propertyCode: link.propertyCode || property?.code || '—',
          monthlyRent: link.monthlyRent || 0,
          linkedDate: link.linkedDate,
          status: link.status || 'active',
          landlordName: landlord?.fullName || link.landlordName || '—',
          landlordEmail: landlord?.email || '—',
          landlordPhone: landlord?.phone || link.landlordPhone || '—',
          paymentsCount: payments.length,
          totalPaid,
          lastPayment: payments[0]?.paidAt || null
        };
      }));

      return {
        _id: tenant._id,
        fullName: tenant.fullName || '—',
        email: tenant.email || '—',
        phone: tenant.phone || '—',
        createdAt: tenant.createdAt,
        linkedProperties
      };
    }));

    res.json({ success: true, tenants: enriched });
  } catch (err) {
    console.error('Admin tenants error:', err);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// Admin: Detect duplicate tenants (same email)
app.get('/api/admin/tenants/duplicates', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, groups: [] });
    const tenants = await db.collection('tenants').find({}).sort({ createdAt: 1 }).toArray();
    const byEmail = {};
    for (const t of tenants) {
      const key = (t.email || '').toLowerCase().trim();
      if (!key) continue;
      if (!byEmail[key]) byEmail[key] = [];
      byEmail[key].push(t);
    }
    const groups = Object.values(byEmail)
      .filter(g => g.length > 1)
      .map(g => g.map(t => ({
        _id: t._id,
        fullName: t.fullName || '—',
        email: t.email || '—',
        phone: t.phone || '—',
        createdAt: t.createdAt,
        profileId: t.profileId || null
      })));
    res.json({ success: true, groups });
  } catch (err) {
    console.error('Duplicates error:', err);
    res.status(500).json({ error: 'Failed to detect duplicates' });
  }
});

// Admin: Merge two tenant records — keep one, delete the other, reassign all related data
app.post('/api/admin/tenants/merge', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { keepId, removeId } = req.body;
    if (!keepId || !removeId) return res.status(400).json({ error: 'keepId and removeId are required' });

    const keepObjId   = new ObjectId(keepId);
    const removeObjId = new ObjectId(removeId);

    const keepTenant   = await db.collection('tenants').findOne({ _id: keepObjId });
    const removeTenant = await db.collection('tenants').findOne({ _id: removeObjId });
    if (!keepTenant)   return res.status(404).json({ error: 'Keep tenant not found' });
    if (!removeTenant) return res.status(404).json({ error: 'Remove tenant not found' });

    // All IDs that belong to the duplicate (its own _id + profileId if any)
    const removeIds = [removeObjId];
    if (removeTenant.profileId) removeIds.push(removeTenant.profileId);

    // All IDs for the keeper (to avoid creating duplicate property links)
    const keepIds = [keepObjId];
    if (keepTenant.profileId) keepIds.push(keepTenant.profileId);

    // Reassign tenant_properties — skip if keeper already has a link to same property
    const keepLinks = await db.collection('tenant_properties').find({ tenantId: { $in: keepIds } }).toArray();
    const keepPropertyIds = keepLinks.map(l => l.propertyId?.toString());

    const dupeLinks = await db.collection('tenant_properties').find({ tenantId: { $in: removeIds } }).toArray();
    for (const link of dupeLinks) {
      if (keepPropertyIds.includes(link.propertyId?.toString())) {
        await db.collection('tenant_properties').deleteOne({ _id: link._id });
      } else {
        await db.collection('tenant_properties').updateOne({ _id: link._id }, { $set: { tenantId: keepObjId } });
      }
    }

    // Reassign property_tenants
    const keepPTLinks = await db.collection('property_tenants').find({ tenantId: { $in: keepIds } }).toArray();
    const keepPTPropertyIds = keepPTLinks.map(l => l.propertyId?.toString());
    const dupePTLinks = await db.collection('property_tenants').find({ tenantId: { $in: removeIds } }).toArray();
    for (const link of dupePTLinks) {
      if (keepPTPropertyIds.includes(link.propertyId?.toString())) {
        await db.collection('property_tenants').deleteOne({ _id: link._id });
      } else {
        await db.collection('property_tenants').updateOne({ _id: link._id }, { $set: { tenantId: keepObjId } });
      }
    }

    // Reassign rent_payments
    await db.collection('rent_payments').updateMany({ tenantId: { $in: removeIds } }, { $set: { tenantId: keepObjId } });

    // Reassign maintenance_requests, announcements, property_messages
    for (const col of ['maintenance_requests', 'property_messages']) {
      await db.collection(col).updateMany({ tenantId: { $in: removeIds } }, { $set: { tenantId: keepObjId } }).catch(() => {});
    }

    // Merge profileId if keeper doesn't have one but duplicate does
    if (!keepTenant.profileId && removeTenant.profileId) {
      await db.collection('tenants').updateOne({ _id: keepObjId }, { $set: { profileId: removeTenant.profileId } });
    }

    // Delete the duplicate tenant record
    await db.collection('tenants').deleteOne({ _id: removeObjId });

    console.log(`[admin] Merged tenant ${removeId} → ${keepId}`);
    res.json({ success: true, message: 'Tenants merged successfully' });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: 'Merge failed: ' + err.message });
  }
});

//  Admin: All rent payments 
app.get('/api/admin/rent-payments', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, payments: [] });

    const payments = await db.collection('rent_payments')
      .find({})
      .sort({ paidAt: -1, createdAt: -1 })
      .limit(200)
      .toArray();

    const enriched = await Promise.all(payments.map(async (p) => {
      let tenantName = '—', tenantEmail = '—';
      let propertyName = '—', landlordName = '—';

      try {
        const tenant = await db.collection('tenants').findOne({ _id: p.tenantId });
        if (tenant) { tenantName = tenant.fullName || '—'; tenantEmail = tenant.email || '—'; }
      } catch (_) {}

      try {
        const prop = await db.collection('landlord_properties').findOne({ _id: p.propertyId });
        if (prop) {
          propertyName = prop.name || '—';
          const landlord = await db.collection('landlords').findOne({ _id: prop.landlordId });
          if (landlord) landlordName = landlord.fullName || '—';
        }
      } catch (_) {}

      const link = await db.collection('tenant_properties').findOne({ _id: p.linkedPropertyId }).catch(() => null);

      return {
        _id: p._id,
        tenantName,
        tenantEmail,
        propertyName: propertyName !== '—' ? propertyName : (link?.propertyName || '—'),
        landlordName,
        amount: p.amount || 0,
        paymentMethod: p.paymentMethod || 'mpesa',
        paymentType: p.paymentType || 'full',
        status: p.status || 'completed',
        reference: p.reference || '—',
        paidAt: p.paidAt || p.createdAt
      };
    }));

    const totalRevenue = enriched.reduce((s, p) => s + p.amount, 0);
    res.json({ success: true, payments: enriched, totalRevenue });
  } catch (err) {
    console.error('Admin rent-payments error:', err);
    res.status(500).json({ error: 'Failed to fetch rent payments' });
  }
});

// GET /api/admin/categorized-payments — all platform payments grouped by category
app.get('/api/admin/categorized-payments', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, categories: {} });
    const { ObjectId } = require('mongodb');
    const toOid = id => { try { return new ObjectId(id); } catch(_) { return null; } };

    const result = {
      product: [],
      viewing: [],
      booking_fee: [],
      deposit: [],
      rent: [],
      ticket: [],
      promotion: [],
      premium_listing: []
    };

    // ── 1. Products / Services Bought (orders) ──────────────────────────────
    const allOrders = await db.collection('orders').find({}).sort({ created_at: -1 }).limit(500).toArray();
    for (const o of allOrders) {
      const ptype = (o.payment_type || '').toLowerCase();
      if (ptype === 'promotion' || ptype === 'slider') {
        let sellerName = o.seller_name || '—';
        let itemTitle = o.item || 'Promotion';
        if (o.seller_id) {
          const sp = await db.collection('profiles').findOne({ _id: toOid(o.seller_id) }).catch(() => null);
          if (sp) sellerName = sp.full_name || sp.name || sp.email || sellerName;
        }
        const propId = o.product_id || (o.product_ids && o.product_ids[0]);
        if (propId) {
          const prop = await db.collection('properties').findOne({ _id: toOid(propId) }).catch(() => null);
          if (prop) itemTitle = prop.title || itemTitle;
        }
        result.promotion.push({ id: o.order_id || String(o._id), itemName: itemTitle, sellerName, amount: o.amount || 0, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), date: o.created_at, expiresAt: o.promotedUntil || null });
        continue;
      }
      if (ptype === 'listing') {
        let sellerName = o.seller_name || '—';
        if (o.seller_id) {
          const sp = await db.collection('profiles').findOne({ _id: toOid(o.seller_id) }).catch(() => null);
          if (sp) sellerName = sp.full_name || sp.name || sp.email || sellerName;
        }
        result.premium_listing.push({ id: o.order_id || String(o._id), title: o.item || 'Listing Fee', sellerName, amount: o.amount || 0, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), activatedAt: o.created_at, expiresAt: null, daysLeft: null, date: o.created_at });
        continue;
      }
      if (ptype === 'deposit') {
        let buyerName = o.buyer_name || o.customer_name || '—';
        let propertyName = o.item || '—';
        if (o.buyer_id) {
          const bp = await db.collection('profiles').findOne({ _id: toOid(o.buyer_id) }).catch(() => null);
          if (bp) buyerName = bp.full_name || bp.name || bp.email || buyerName;
        }
        if (o.property_id_ref) {
          const lp = await db.collection('landlord_properties').findOne({ _id: toOid(o.property_id_ref) }).catch(() => null);
          if (lp) propertyName = lp.title || lp.property_name || propertyName;
        }
        result.deposit.push({ id: o.order_id || String(o._id), buyerName, buyerEmail: o.buyer_email || '—', propertyName, propertyCode: o.property_code || '—', amount: o.amount || 0, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), date: o.created_at });
        continue;
      }
      if (ptype === 'booking') {
        let buyerName = o.buyer_name || o.customer_name || '—';
        let propertyName = o.item || o.property_name || '—';
        if (o.buyer_id) {
          const bp = await db.collection('profiles').findOne({ _id: toOid(o.buyer_id) }).catch(() => null);
          if (bp) buyerName = bp.full_name || bp.name || bp.email || buyerName;
        }
        result.booking_fee.push({ id: o.order_id || String(o._id), buyerName, propertyName, amount: o.amount || 0, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), date: o.created_at });
        continue;
      }
      // Regular product/service
      let sellerName = o.seller_name || '—';
      let productName = o.item || '—';
      if (o.seller_id) {
        const sp = await db.collection('profiles').findOne({ _id: toOid(o.seller_id) }).catch(() => null);
        if (sp) sellerName = sp.full_name || sp.name || sp.business_name || sp.email || sellerName;
      }
      if (o.product_id) {
        const pp = await db.collection('properties').findOne({ _id: toOid(o.product_id) }).catch(() => null);
        if (pp) productName = pp.title || productName;
      }
      let buyerName = o.buyer_name || o.customer_name || '—';
      if (o.buyer_id) {
        const bp = await db.collection('profiles').findOne({ _id: toOid(o.buyer_id) }).catch(() => null);
        if (bp) buyerName = bp.full_name || bp.name || bp.email || buyerName;
      }
      result.product.push({ id: o.order_id || String(o._id), productName, buyerName, sellerName, amount: o.amount || 0, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), date: o.created_at });
    }

    // ── 2. Rent Paid ─────────────────────────────────────────────────────────
    const rentDocs = await db.collection('rent_payments').find({}).sort({ paidAt: -1, createdAt: -1 }).limit(300).toArray();
    for (const rp of rentDocs) {
      const ptype = (rp.paymentType || '').toLowerCase();
      if (ptype === 'booking' || ptype === 'booking_fee') {
        let buyerName = rp.tenantName || '—';
        let propertyName = rp.propertyName || rp.property_name || '—';
        let landlordName = rp.landlordName || '—';
        if (!propertyName || propertyName === '—') {
          const tp = await db.collection('tenant_properties').findOne({ tenantId: rp.tenantId }).catch(() => null);
          if (tp) { propertyName = tp.propertyName || tp.propertyCode || propertyName; landlordName = tp.landlordName || landlordName; }
        }
        result.booking_fee.push({ id: rp.reference || String(rp._id), buyerName, propertyName, landlordName, amount: rp.amount || 0, status: rp.status || 'completed', date: rp.paidAt || rp.createdAt });
        continue;
      }
      let tenantName = rp.tenantName || '—';
      let propertyName = rp.propertyName || rp.property_name || '—';
      let landlordName = rp.landlordName || '—';
      let location = rp.location || '—';
      if (!tenantName || tenantName === '—') {
        // Try both tenants and profiles collections (unified-login users live in profiles)
        let tenant = await db.collection('tenants').findOne({ _id: rp.tenantId }).catch(() => null);
        if (!tenant) tenant = await db.collection('profiles').findOne({ _id: rp.tenantId }).catch(() => null);
        if (tenant) tenantName = tenant.fullName || tenant.full_name || tenant.name || tenant.email || '—';
      }
      if (!propertyName || propertyName === '—') {
        const prop = await db.collection('landlord_properties').findOne({ _id: rp.propertyId }).catch(() => null);
        if (prop) {
          propertyName = prop.name || prop.address || '—';
          location = prop.location || prop.area || location;
          if (!landlordName || landlordName === '—') {
            const ll = await db.collection('landlords').findOne({ _id: prop.landlordId }).catch(() => null);
            if (ll) landlordName = ll.fullName || ll.full_name || ll.email || '—';
          }
        }
      }
      result.rent.push({ id: rp.reference || String(rp._id), tenantName, propertyName, landlordName, location, paymentType: rp.paymentType || 'full', amount: rp.amount || 0, status: rp.status || 'completed', method: rp.paymentMethod || 'mpesa', date: rp.paidAt || rp.createdAt });
    }

    // ── 3. Viewing Rental Paid ───────────────────────────────────────────────
    const viewDocs = await db.collection('viewings').find({}).sort({ created_at: -1 }).limit(300).toArray();
    for (const v of viewDocs) {
      result.viewing.push({ id: String(v._id), tenantName: v.tenant_name || '—', tenantEmail: v.tenant_email || '—', propertyName: v.property_name || '—', location: v.location || '—', viewingDate: v.date, viewingTime: v.time, amount: v.amount || v.fee || 0, status: v.status || 'pending', date: v.created_at });
    }

    // ── 4. Tickets Paid ──────────────────────────────────────────────────────
    const ticketDocs = await db.collection('tickets').find({}).sort({ created_at: -1 }).limit(300).toArray();
    for (const t of ticketDocs) {
      let organizer = t.organizer || '—';
      let eventName = t.event_title || '—';
      let venue = t.venue || '—';
      let eventDate = t.event_date || null;
      if (t.event_id) {
        const evt = await db.collection('events').findOne({ _id: t.event_id }).catch(() => null);
        if (evt) {
          organizer = evt.organizer || evt.organizer_name || organizer;
          eventName = evt.title || eventName;
          venue = evt.venue || evt.location || venue;
          eventDate = evt.event_date || eventDate;
        }
      }
      result.ticket.push({ id: t.ticket_code || String(t._id), ticketCode: t.ticket_code, buyerName: t.buyer_name || '—', buyerEmail: t.buyer_email || '—', eventName, organizer, venue, eventDate, quantity: t.quantity || 1, amount: t.total_amount || 0, status: t.status || 'confirmed', date: t.created_at });
    }

    // ── 5. Promotion Paid (sliders) ──────────────────────────────────────────
    const sliderDocs = await db.collection('sliders').find({ payment_amount: { $gt: 0 } }).sort({ created_at: -1 }).limit(200).toArray();
    const existPromoIds = new Set(result.promotion.map(p => p.id));
    for (const s of sliderDocs) {
      if (existPromoIds.has(String(s._id))) continue;
      let sellerName = s.seller_name || '—';
      if (s.seller_id) {
        const sp = await db.collection('profiles').findOne({ _id: toOid(s.seller_id) }).catch(() => null);
        if (sp) sellerName = sp.full_name || sp.name || sp.business_name || sp.email || sellerName;
      }
      const expiresAt = s.promotedUntil || s.expiresAt || null;
      const now = new Date();
      result.promotion.push({ id: String(s._id), itemName: s.title || 'Slider Promotion', sellerName, amount: s.payment_amount || 0, status: expiresAt && new Date(expiresAt) > now ? 'active' : 'expired', date: s.created_at || s.createdAt, expiresAt });
    }

    // ── 6. Premium Listing Paid (subscriptions) ──────────────────────────────
    const subDocs = await db.collection('seller_subscriptions').find({}).sort({ updatedAt: -1 }).limit(300).toArray();
    const existSubIds = new Set(result.premium_listing.map(p => p.id));
    const now = new Date();
    for (const sub of subDocs) {
      if (existSubIds.has(String(sub._id))) continue;
      let sellerName = sub.seller_name || '—';
      if (sub.sellerId) {
        const sp = await db.collection('profiles').findOne({ _id: toOid(String(sub.sellerId)) }).catch(() => null);
        if (sp) sellerName = sp.full_name || sp.name || sp.business_name || sp.email || sellerName;
      }
      const isActive = sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > now;
      const daysLeft = isActive ? Math.ceil((new Date(sub.expiresAt) - now) / 86400000) : 0;
      result.premium_listing.push({ id: String(sub._id), title: 'Unlimited Listings Plan', sellerName, amount: sub.amount || 500, activatedAt: sub.updatedAt || sub.createdAt, expiresAt: sub.expiresAt, daysLeft, status: isActive ? 'active' : 'expired', date: sub.updatedAt || sub.createdAt });
    }

    // Totals per category
    const totals = {};
    for (const [cat, items] of Object.entries(result)) {
      totals[cat] = { count: items.length, revenue: items.reduce((s, i) => s + (Number(i.amount) || 0), 0) };
    }

    return res.json({ success: true, categories: result, totals });
  } catch (err) {
    console.error('Admin categorized-payments error:', err);
    return res.status(500).json({ error: 'Failed to fetch categorized payments' });
  }
});

//  Admin Bot: Smart DB search 
app.get('/api/admin/bot/svc-cats', async (req, res) => {
  if (!db) return res.json({ error: 'no db' });
  const notInactive = { status: { $ne: 'inactive' } };
  const propFilter = { ...notInactive, category: { $in: ['service', 'services'] } };
  const [subSvc, catSvc, subProp] = await Promise.all([
    db.collection('services').distinct('subcategory', notInactive),
    db.collection('services').distinct('category', notInactive),
    db.collection('properties').distinct('subcategory', propFilter),
  ]);
  const EXCLUDE = ['service','services','product','housing'];
  const merged = [...new Set([...subSvc, ...catSvc, ...subProp])]
    .filter(c => c && typeof c === 'string' && c.trim() && !EXCLUDE.includes(c.toLowerCase()))
    .sort();
  res.json({ subSvc, catSvc, subProp, merged });
});

app.get('/api/admin/bot/housing-types', async (req, res) => {
  if (!db) return res.json({ error: 'no db' });
  const housingMatch = { $or: [{ listing_type: 'housing' }, { category: { $regex: /^housing/i } }, { category: { $regex: /rental/i } }] };
  const lpMatch = { listOnMarketplace: true };
  const agg = fields => [
    { $match: housingMatch },
    { $project: { vals: { $filter: { input: fields.map(f => `$${f}`), as: 'v', cond: { $and: [{ $ne: ['$$v', null] }, { $ne: ['$$v', ''] }] } } } } },
    { $unwind: '$vals' },
    { $group: { _id: '$vals' } },
  ];
  const lpAgg = fields => [
    { $match: lpMatch },
    { $project: { vals: { $filter: { input: fields.map(f => `$${f}`), as: 'v', cond: { $and: [{ $ne: ['$$v', null] }, { $ne: ['$$v', ''] }] } } } } },
    { $unwind: '$vals' },
    { $group: { _id: '$vals' } },
  ];
  const [fromProps, fromLP] = await Promise.all([
    db.collection('properties').aggregate(agg(['subcategory', 'property_type'])).toArray(),
    db.collection('landlord_properties').aggregate(lpAgg(['subcategory', 'propertyType'])).toArray(),
  ]);
  const merged = [...new Set([...fromProps, ...fromLP].map(x => x._id).filter(c => c && typeof c === 'string' && c.trim()))].sort();
  res.json({ fromProps: fromProps.map(x=>x._id), fromLP: fromLP.map(x=>x._id), merged });
});

app.get('/api/admin/bot/search', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, users: [], tenants: [], products: [], services: [], properties: [] });
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ success: true, empty: true });

    const rx = new RegExp(q, 'i');

    //  Users / Profiles 
    const rawUsers = await db.collection('profiles').find({
      $or: [{ full_name: rx }, { email: rx }, { phone: rx }]
    }).limit(5).toArray();

    const enrichedUsers = await Promise.all(rawUsers.map(async u => {
      // Is this user a tenant?
      const tenant = await db.collection('tenants').findOne({ $or: [{ email: u.email }, { userId: u._id }] });
      if (tenant) {
        const links = await db.collection('tenant_properties').find({ tenantId: tenant._id }).toArray();
        const linked = await Promise.all(links.map(async lk => {
          let prop = null; let ll = null;
          try { prop = await db.collection('landlord_properties').findOne({ _id: lk.propertyId }); } catch(_) {}
          if (prop?.landlordId) { try { ll = await db.collection('landlords').findOne({ _id: prop.landlordId }); } catch(_) {} }
          const pmts = await db.collection('rent_payments').find({ tenantId: tenant._id, propertyId: lk.propertyId }).sort({ paidAt: -1 }).toArray();
          return {
            propertyName: prop?.name || lk.propertyName || '—',
            propertyCode: prop?.code || lk.propertyCode || '—',
            location:     prop?.location || '—',
            landlordName: ll?.fullName || lk.landlordName || '—',
            landlordPhone: ll?.phone || '—',
            monthlyRent:  lk.monthlyRent || 0,
            paymentsCount: pmts.length,
            totalPaid:    pmts.reduce((s, p) => s + (p.amount || 0), 0),
            lastPayment:  pmts[0]?.paidAt || null,
            status:       lk.status || 'active'
          };
        }));
        return { ...u, _found: 'tenant', tenantName: tenant.fullName, linkedProperties: linked };
      }
      // Is this user a landlord?
      const landlord = await db.collection('landlords').findOne({ email: u.email });
      if (landlord) {
        const props = await db.collection('landlord_properties').find({ landlordId: landlord._id }).toArray();
        const enrichedProps = await Promise.all(props.map(async p => {
          const tenantLinks = await db.collection('tenant_properties').find({ propertyId: p._id }).toArray();
          const pmts = await db.collection('rent_payments').find({ propertyId: p._id }).toArray();
          return { name: p.name, code: p.code, location: p.location, tenantsCount: tenantLinks.length, revenue: pmts.reduce((s, x) => s + (x.amount||0), 0) };
        }));
        return { ...u, _found: 'landlord', landlordName: landlord.fullName, properties: enrichedProps };
      }
      return { ...u, _found: 'user' };
    }));

    //  Tenants (direct search) 
    const rawTenants = await db.collection('tenants').find({
      $or: [{ fullName: rx }, { email: rx }, { phone: rx }]
    }).limit(5).toArray();

    const enrichedTenants = await Promise.all(rawTenants.map(async t => {
      const links = await db.collection('tenant_properties').find({ tenantId: t._id }).toArray();
      const linked = await Promise.all(links.map(async lk => {
        let prop = null; let ll = null;
        try { prop = await db.collection('landlord_properties').findOne({ _id: lk.propertyId }); } catch(_) {}
        if (prop?.landlordId) { try { ll = await db.collection('landlords').findOne({ _id: prop.landlordId }); } catch(_) {} }
        const pmts = await db.collection('rent_payments').find({ tenantId: t._id, propertyId: lk.propertyId }).sort({ paidAt: -1 }).toArray();
        return {
          propertyName: prop?.name || lk.propertyName || '—',
          propertyCode: prop?.code || lk.propertyCode || '—',
          location:     prop?.location || '—',
          landlordName: ll?.fullName || lk.landlordName || '—',
          landlordPhone: ll?.phone || '—',
          monthlyRent:  lk.monthlyRent || 0,
          paymentsCount: pmts.length,
          totalPaid:    pmts.reduce((s, p) => s + (p.amount||0), 0),
          lastPayment:  pmts[0]?.paidAt || null,
          status:       lk.status || 'active'
        };
      }));
      return { ...t, _found: 'tenant', linkedProperties: linked };
    }));

    // Merge: avoid duplicates between profiles-tenants and direct tenants
    const tenantEmails = new Set(enrichedTenants.map(t => t.email));
    const usersOnly    = enrichedUsers.filter(u => !tenantEmails.has(u.email) || u._found !== 'tenant');
    const allTenants   = [...enrichedTenants, ...enrichedUsers.filter(u => u._found === 'tenant' && !tenantEmails.has(u.email))];

    //  Landlords (direct search) 
    const rawLandlords = await db.collection('landlords').find({
      $or: [{ fullName: rx }, { email: rx }, { phone: rx }]
    }).limit(5).toArray();

    const enrichedLandlords = await Promise.all(rawLandlords.map(async ll => {
      const props = await db.collection('landlord_properties').find({ landlordId: ll._id }).toArray();
      const ep = await Promise.all(props.map(async p => {
        const tl = await db.collection('tenant_properties').find({ propertyId: p._id }).toArray();
        const pmts = await db.collection('rent_payments').find({ propertyId: p._id }).toArray();
        return { name: p.name, code: p.code, location: p.location, tenantsCount: tl.length, revenue: pmts.reduce((s, x) => s + (x.amount||0), 0) };
      }));
      return { ...ll, _found: 'landlord', properties: ep };
    }));

    //  Products / Services / Properties 
    const [products, services, properties] = await Promise.all([
      db.collection('products').find({ $or: [{ name: rx }, { title: rx }, { category: rx }] }).limit(4).toArray(),
      db.collection('services').find({ $or: [{ name: rx }, { title: rx }, { category: rx }] }).limit(4).toArray(),
      db.collection('landlord_properties').find({ $or: [{ name: rx }, { code: rx }, { location: rx }, { type: rx }] }).limit(4).toArray()
    ]);

    const totalFound = enrichedTenants.length + enrichedLandlords.length + usersOnly.length + products.length + services.length + properties.length;

    res.json({
      success: true,
      query: q,
      totalFound,
      tenants:   enrichedTenants,
      landlords: enrichedLandlords,
      users:     usersOnly.filter(u => u._found === 'user'),
      products,
      services,
      properties
    });
  } catch (err) {
    console.error('Bot search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

//  Admin: Monthly Rent Calendar 
// Send / log a rent reminder
app.post('/api/admin/send-reminder', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const {
      tenantId, tenantName, tenantEmail, tenantPhone,
      propertyName, propertyCode, monthlyRent, amountPaid,
      status, channel, message, sentAt
    } = req.body;

    if (!tenantName) return res.status(400).json({ error: 'tenantName is required' });

    const reminder = {
      tenantId:     tenantId   || null,
      tenantName:   tenantName,
      tenantEmail:  tenantEmail  || '',
      tenantPhone:  tenantPhone  || '',
      propertyName: propertyName || '',
      propertyCode: propertyCode || '',
      monthlyRent:  Number(monthlyRent) || 0,
      amountPaid:   Number(amountPaid)  || 0,
      status:       status  || 'pending',
      channel:      channel || 'sms',
      message:      message || '',
      sentAt:       sentAt  ? new Date(sentAt) : new Date(),
      createdAt:    new Date()
    };

    await db.collection('rent_reminders').insertOne(reminder);
    return res.json({ success: true, message: 'Reminder logged successfully' });
  } catch (err) {
    console.error('Send reminder error:', err);
    return res.status(500).json({ error: 'Failed to log reminder' });
  }
});

app.get('/api/admin/rent-calendar', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, rows: [] });

    const monthParam = req.query.month || new Date().toISOString().slice(0, 7); // e.g. "2026-05"
    const [yr, mo]   = monthParam.split('-').map(Number);
    const monthStart = new Date(yr, mo - 1, 1);
    const monthEnd   = new Date(yr, mo, 1);

    // Get all tenant-property links
    const links = await db.collection('tenant_properties').find({}).toArray();

    const rows = await Promise.all(links.map(async (lk) => {
      // Tenant info
      let tenant = null;
      try { tenant = await db.collection('tenants').findOne({ _id: lk.tenantId }); } catch(_) {}

      // Property info
      let prop = null;
      try { prop = await db.collection('landlord_properties').findOne({ _id: lk.propertyId }); } catch(_) {}

      // Landlord info
      let landlord = null;
      if (prop?.landlordId) {
        try { landlord = await db.collection('landlords').findOne({ _id: prop.landlordId }); } catch(_) {}
      }

      // Payments this month
      const monthPayments = await db.collection('rent_payments').find({
        tenantId:   lk.tenantId,
        propertyId: lk.propertyId,
        paidAt: { $gte: monthStart, $lt: monthEnd }
      }).sort({ paidAt: -1 }).toArray();

      const amountPaid  = monthPayments.reduce((s, p) => s + (p.amount || 0), 0);
      const monthlyRent = lk.monthlyRent || 0;
      const paid        = monthPayments.length > 0;
      const overdue     = !paid && new Date() > monthEnd; // past month entirely

      // Status: paid / pending / overdue
      let status = 'pending';
      if (paid) status = 'paid';
      else if (overdue) status = 'overdue';

      return {
        linkId:       lk._id,
        landlordId:   String(prop?.landlordId || ''),
        landlordName: landlord?.fullName || '—',
        landlordEmail: landlord?.email || '—',
        propertyId:   String(lk.propertyId),
        propertyName: prop?.name || lk.propertyName || '—',
        propertyCode: prop?.code || lk.propertyCode || '—',
        tenantId:     String(lk.tenantId),
        tenantName:   tenant?.fullName || lk.tenantName || '—',
        tenantEmail:  tenant?.email || '—',
        tenantPhone:  tenant?.phone || '—',
        monthlyRent,
        amountPaid,
        paid,
        status,
        paidAt:       monthPayments[0]?.paidAt || null,
        reference:    monthPayments[0]?.reference || null,
        paymentMethod: monthPayments[0]?.paymentMethod || null,
        linkStatus:   lk.status || 'active'
      };
    }));

    // Summary
    const paid    = rows.filter(r => r.status === 'paid').length;
    const pending = rows.filter(r => r.status === 'pending').length;
    const overdue = rows.filter(r => r.status === 'overdue').length;
    const totalDue       = rows.reduce((s, r) => s + r.monthlyRent, 0);
    const totalCollected = rows.reduce((s, r) => s + r.amountPaid, 0);

    res.json({ success: true, month: monthParam, rows, summary: { paid, pending, overdue, totalDue, totalCollected } });
  } catch (err) {
    console.error('Rent calendar error:', err);
    res.status(500).json({ error: 'Failed to load rent calendar' });
  }
});

//  Admin: Landlords with their properties and tenants 
app.get('/api/admin/landlords', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, landlords: [] });

    const landlords = await db.collection('landlords').find({}).sort({ createdAt: -1 }).toArray();

    const enriched = await Promise.all(landlords.map(async (landlord) => {
      // Get all properties belonging to this landlord
      const properties = await db.collection('landlord_properties')
        .find({ landlordId: landlord._id })
        .toArray();

      const enrichedProperties = await Promise.all(properties.map(async (prop) => {
        // Get tenant links for this property
        const tenantLinks = await db.collection('tenant_properties')
          .find({ propertyId: prop._id })
          .toArray();

        const tenants = await Promise.all(tenantLinks.map(async (link) => {
          let tenant = null;
          try {
            tenant = await db.collection('tenants').findOne({ _id: link.tenantId });
          } catch (_) {}

          // Payment summary for this tenant on this property
          const payments = await db.collection('rent_payments')
            .find({ tenantId: link.tenantId, propertyId: prop._id })
            .sort({ paidAt: -1 })
            .toArray();

          const totalPaid = payments.reduce((s, p) => s + (p.amount || 0), 0);

          return {
            tenantId: link.tenantId,
            fullName: tenant?.fullName || link.tenantName || '—',
            email: tenant?.email || '—',
            phone: tenant?.phone || '—',
            monthlyRent: link.monthlyRent || 0,
            status: link.status || 'active',
            linkedDate: link.linkedDate,
            paymentsCount: payments.length,
            totalPaid,
            lastPayment: payments[0]?.paidAt || null
          };
        }));

        const propRevenue = tenants.reduce((s, t) => s + (t.totalPaid || 0), 0);

        return {
          _id: prop._id,
          name: prop.name || '—',
          code: prop.code || prop.propertyCode || '—',
          location: prop.location || prop.address || '—',
          type: prop.type || prop.category || 'Residential',
          units: prop.units || prop.totalUnits || null,
          status: prop.status || 'active',
          createdAt: prop.createdAt,
          tenants,
          tenantsCount: tenants.length,
          propRevenue
        };
      }));

      const totalRevenue = enrichedProperties.reduce((s, p) => s + p.propRevenue, 0);
      const totalTenants = enrichedProperties.reduce((s, p) => s + p.tenantsCount, 0);
      const llId = String(landlord._id);
      const llWithdrawalAgg = await db.collection('withdrawals').aggregate([
        { $match: { landlordId: { $in: [llId, landlord._id] }, status: { $in: ['completed', 'approved', 'pending'] } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).toArray().catch(() => []);
      const totalWithdrawn = llWithdrawalAgg[0]?.total || 0;
      const currentBalance = Math.max(0, totalRevenue - totalWithdrawn);

      return {
        _id: landlord._id,
        fullName: landlord.fullName || '—',
        email: landlord.email || '—',
        phone: landlord.phone || '—',
        createdAt: landlord.createdAt,
        properties: enrichedProperties,
        totalProperties: enrichedProperties.length,
        totalTenants,
        totalRevenue,
        totalWithdrawn,
        currentBalance
      };
    }));

    res.json({ success: true, landlords: enriched });
  } catch (err) {
    console.error('Admin landlords error:', err);
    res.status(500).json({ error: 'Failed to fetch landlords' });
  }
});

// AI Endpoints for BConnect Platform
// AI Chat Assistant
// POST /api/ai/admin-task — AI performs an admin action on behalf of admin user
app.post('/api/ai/admin-task', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { task, target } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });

    const { ObjectId } = require('mongodb');
    const toOid = id => { try { return new ObjectId(id); } catch (_) { return null; } };

    let result = {};

    if (task === 'approve_listing') {
      const oid = toOid(target);
      if (!oid) return res.status(400).json({ error: 'Invalid listing id' });
      await db.collection('properties').updateOne({ _id: oid }, { $set: { status: 'approved', active: true, approved_at: new Date() } });
      result = { message: 'Listing approved and set to active.' };
    } else if (task === 'reject_listing') {
      const oid = toOid(target);
      if (!oid) return res.status(400).json({ error: 'Invalid listing id' });
      await db.collection('properties').updateOne({ _id: oid }, { $set: { status: 'rejected', active: false, rejected_at: new Date() } });
      result = { message: 'Listing rejected.' };
    } else if (task === 'ban_user') {
      const oid = toOid(target);
      if (!oid) return res.status(400).json({ error: 'Invalid user id' });
      await db.collection('profiles').updateOne({ _id: oid }, { $set: { status: 'banned' } });
      result = { message: 'User banned.' };
    } else if (task === 'unban_user') {
      const oid = toOid(target);
      if (!oid) return res.status(400).json({ error: 'Invalid user id' });
      await db.collection('profiles').updateOne({ _id: oid }, { $set: { status: 'active' } });
      result = { message: 'User unbanned.' };
    } else if (task === 'approve_event') {
      const oid = toOid(target);
      if (!oid) return res.status(400).json({ error: 'Invalid event id' });
      await db.collection('events').updateOne({ _id: oid }, { $set: { status: 'active', active: true, approved_at: new Date() } });
      result = { message: 'Event approved.' };
    } else if (task === 'get_stats') {
      const [users, orders, products] = await Promise.all([
        db.collection('profiles').countDocuments(),
        db.collection('orders').countDocuments({ payment_status: 'COMPLETE' }),
        db.collection('properties').countDocuments({ active: true })
      ]);
      const revenueAgg = await db.collection('orders').aggregate([
        { $match: { payment_status: 'COMPLETE' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).toArray();
      result = { users, completedOrders: orders, activeListings: products, totalRevenue: revenueAgg[0]?.total || 0 };
    } else {
      return res.status(400).json({ error: 'Unknown task: ' + task });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('AI admin task error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, context, history } = req.body;
    let userId = null;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (err) {
        // Ignore invalid token and continue without user context
      }
    }

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get platform context from database
    const platformContext = await getPlatformContext();

    // Build conversation history string for context
    const historyStr = Array.isArray(history) && history.length > 0
      ? '\n\nCONVERSATION SO FAR:\n' + history.slice(-8).map(m => `${m.role === 'user' ? 'User' : 'BConnect Bot'}: ${m.text}`).join('\n')
      : '';

    const systemPrompt = `You are BConnect Bot — the friendly, knowledgeable AI assistant for BConnect, Kenya's all-in-one marketplace platform. You know everything about BConnect and help users navigate it confidently.


WHAT IS BCONNECT?

BConnect is a Kenyan online marketplace that connects buyers, sellers, landlords, tenants, and service providers. It covers three main areas:
1. PRODUCTS — physical goods for sale
2. SERVICES — skilled professionals for hire
3. HOUSING — rental properties across Kenya

All payments on BConnect use M-Pesa STK Push — safe, instant, and cashless.


USER ROLES

BConnect has 4 roles. Users choose one on registration (it's free):
- BUYER: Browse, search, and purchase products and services
- SELLER: List products or services and receive M-Pesa payments
- LANDLORD: Add rental properties, manage tenants, track rent payments, send announcements, handle maintenance requests
- TENANT: Find housing, link to a property using a Property Code, pay rent via M-Pesa, submit maintenance/repair requests, chat with landlord


PRODUCTS

Categories available on BConnect:
- Electronics: phones, laptops, TVs, chargers, earphones, power banks, cameras
- Fashion: clothes, shoes, bags, watches, jewellery, belts, caps
- Vehicles: cars, motorcycles, boda bodas, spare parts, tyres, accessories
- Furniture: sofas, beds, mattresses, wardrobes, tables, chairs, office furniture
- Food & Groceries: packaged food, fresh produce, snacks, drinks
- Health & Beauty: skincare, hair products, supplements, cosmetics
- Books & Education: textbooks, stationery, notebooks
- Sports & Fitness: gym equipment, sportswear, bicycles
- Baby & Kids: clothing, toys, strollers, baby food

How to buy:
1. Browse products.html or search for what you need
2. Filter by category, price range, or location
3. Click a listing to see photos, description, seller info
4. Click "Buy Now" — enter your Safaricom number (07xx or 01xx)
5. Approve the M-Pesa STK prompt on your phone
6. Order saved instantly under "My Orders" (orders.html)


SERVICES

Find skilled professionals near you:
- Plumbing: leaks, pipe installations, blocked drains, new setups
- Electrical: wiring, sockets, lighting, solar panel installation, fault detection
- Cleaning: home cleaning, office cleaning, deep cleaning, carpet/sofa cleaning, post-construction
- Tailoring: custom clothing, alterations, repairs, school uniforms
- Carpentry: furniture making, wood repair, shelving, doors/windows
- Painting: interior & exterior painting, decorating
- Mechanics: car repair, servicing, diagnostics, tyre fitting
- Car Wash: mobile or workshop, interior detailing
- Catering: event catering, home cooking, meal prep, birthday cakes
- Movers: house moving, furniture delivery, loading/offloading
- Gardening: lawn care, landscaping, tree trimming

How to book a service:
1. Go to services.html
2. Browse by category or search
3. Click a listing — see provider details, rate, location
4. Tap "Book Now" or "Message Provider"
5. Agree on time and location, pay via M-Pesa


HOUSING

Rental types and typical Kenyan price ranges:
- Bedsitter: single room + small kitchen area, ideal for students/singles — Ksh 4,000–15,000/month
- Studio: open-plan living + sleeping, full bathroom — Ksh 10,000–25,000/month
- 1 Bedroom: separate bedroom, sitting room, kitchen, bathroom — Ksh 12,000–35,000/month
- 2 Bedroom: two bedrooms, sitting room, kitchen — Ksh 20,000–60,000/month
- 3 Bedroom: larger family homes — Ksh 30,000–100,000/month
- Hostel/Single Room: shared facilities, affordable — Ksh 2,500–8,000/month
- Apartment: modern units in managed buildings with security guards

Active locations on BConnect:
- Kutus & Kirinyaga County (our home base — strongest presence)
- Nairobi: CBD, Westlands, Kilimani, Kasarani, Roysambu, Embakasi, Ngong Road, Zimmerman, Ruiru, Githurai
- Mombasa: Nyali, Bamburi, Likoni, Old Town, Kisauni
- Kisumu, Nakuru, Thika, Eldoret (growing presence)

How to find housing:
1. Go to housing.html
2. Filter by type (bedsitter, 1BR, 2BR) and location
3. Set a budget filter
4. View listing details, photos, landlord contact
5. Message or call landlord to arrange viewing
6. Register as Tenant to pay rent online and track payments


PAYMENTS — M-PESA STK PUSH

All BConnect payments use M-Pesa STK Push (Safaricom only):
1. Click "Buy Now" or "Book Service" on any listing
2. Enter your Safaricom number (07xx or 01xx format)
3. An M-Pesa prompt appears automatically on your phone
4. Enter your M-Pesa PIN to approve
5. Payment confirmed instantly — order saved to your account

Tips:
- Keep your M-Pesa confirmation SMS as proof of payment
- Ensure your M-Pesa balance is sufficient before checkout
- For failed payments, wait a minute and try again
- Contact support if payment deducted but order not confirmed


SELLING ON BCONNECT

How to list a product or service:
1. Register or log in (login.html) — choose Seller role
2. Click "Sell / List" in the menu
3. Choose listing type: Product, Service, or Housing
4. Fill in: title, category, price (Ksh), description, location, photos
5. Submit — listing goes live quickly
6. Manage listings from seller-dashboard.html: edit, delete, relist, mark as sold
7. Receive M-Pesa payments directly when buyers purchase

Tips for more sales:
- Use clear, high-quality photos (listings with photos get 3× more views)
- Write a detailed, honest description
- Set competitive prices
- Add your exact location
- Respond quickly to buyer messages

Verification: Complete your profile, make successful transactions, maintain good reviews → apply for Verified Badge via Seller Dashboard.


LANDLORD PORTAL

Features available at landlord.html:
- Add & manage multiple properties (title, location, monthly rent, photos)
- Generate a unique Property Code per property → share with tenants to link them
- View all linked tenants per property
- Track M-Pesa rent payments in real time
- Send announcements to all tenants
- Receive and respond to maintenance/repair requests
- View monthly payment summaries


TENANT PORTAL

Features available at tenant-portal.html:
- Link to a rental property using the landlord's Property Code
- View rent amount due, next due date, payment history
- Pay rent via M-Pesa directly from the dashboard
- Submit maintenance/repair requests (tracked with status updates)
- Receive announcements from landlord
- Message landlord directly within the platform


ACCOUNTS & SECURITY

- Registration is FREE at login.html
- Forgot password: Login page → "Forgot Password" → email reset link (15-minute expiry)
- User data is stored securely (JWT authentication, bcrypt password hashing)
- Always use BConnect's in-app messaging — avoid sharing personal details outside the platform


KEY PAGES & LINKS

- Home: website.html
- Products: products.html
- Housing: housing.html
- Services: services.html
- Login/Register: login.html
- My Orders: orders.html
- Cart: cart.html
- Seller Dashboard: seller-dashboard.html
- Landlord Portal: landlord.html
- Tenant Portal: tenant-portal.html
- Support: support.html
- About BConnect: about.html
- AI Assistant: ai-assistant.html


LIVE PLATFORM DATA

${platformContext}


HOW TO BEHAVE

- You are BConnect Bot — friendly, helpful, and confident
- Always respond in the same language the user writes in (English or Swahili)
- Keep answers concise but complete — use bullet points or numbered steps for processes
- When a user mentions a product/service/location, try to link them to the relevant page
- If a user asks to "find" something, tell them exactly where to go and what filters to use
- For pricing questions, give the Kenyan Ksh ranges from the knowledge above
- For account issues, guide them step by step
- Never make up listings, prices, or seller details — if you don't know, say so clearly
- If a question is outside BConnect (e.g. general internet questions), politely redirect: "I'm specifically here to help with BConnect — let me know if you have any marketplace, housing, or services questions!"
- End responses with a helpful follow-up suggestion when appropriate
- IMPORTANT: Never mention file extensions like .html when referring to pages. Always use plain names — e.g. say "the Marketplace" not "website.html", "the Products page" not "products.html", "My Orders" not "orders.html", "the Seller Dashboard" not "seller-dashboard.html", "Login page" not "login.html", "Housing" not "housing.html", "Services" not "services.html", "the Cart" not "cart.html", "the Landlord Portal" not "landlord.html", "the Tenant Portal" not "tenant-portal.html", "Support" not "support.html".
- When a user asks HOW to do something (e.g. "how do I pay", "how to list a product", "steps to register"), ALWAYS respond with a clear numbered step-by-step list. Use this format:
  Step 1: [action]
  Step 2: [action]
  ...etc. Never give vague answers when steps are requested.
- If the user is an ADMIN and asks to perform a platform task (approve a listing, reject a submission, ban a user, view stats), respond with a JSON action block on a new line like:
  ACTION: {"type":"admin_task","task":"approve_listing","target":"[id or name]"}
  Only include the ACTION block when the user explicitly asks you to perform an admin action.

USER CONTEXT: ${context || 'General user browsing BConnect marketplace'}`;

    if (!genAI) {
      return res.status(503).json({ error: 'AI service not configured. Please set GEMINI_API_KEY.' });
    }

    const fullPrompt = `${systemPrompt}${historyStr}\n\nUser: ${message}`;
    const aiResponse = await generateGeminiResponse(fullPrompt, { maxTokens: 1000, temperature: 0.72 });

    return res.json({
      success: true,
      response: aiResponse,
      timestamp: new Date().toISOString(),
      userId: userId
    });

  } catch (error) {
    console.error('AI Chat error:', error);
    return res.status(500).json({
      error: 'AI service temporarily unavailable',
      fallback: 'Please try again later or contact support.'
    });
  }
});

// AI Product Recommendations
app.post('/api/ai/recommend', async (req, res) => {
  try {
    const { userId, preferences, category, location } = req.body;

    const query = {};
    if (category && category !== 'any') query.listing_type = category;
    if (location) query.location = { $regex: location, $options: 'i' };
    query.status = { $in: ['approved', 'active'] };

    const products = await db.collection('listings').find(query).limit(50).toArray();

    const productsContext = products.map(p =>
      `ID:${p._id} | ${p.title}: ${p.description || ''} - ${p.listing_type || p.category || ''} - KES ${p.price || 0} - ${p.location || ''}`
    ).join('\n');

    const prompt = `Based on user preferences: ${preferences || 'General interests'}
Category preference: ${category || 'Any'}
Location preference: ${location || 'Any'}

Available items on BConnect:
${productsContext || 'No items currently available'}

Recommend 3-5 most relevant items. Consider:
- User's stated preferences
- Category match
- Location proximity
- Price appropriateness
- Item quality/description

Format as a valid JSON array only, with objects containing: id, title, reason, score (1-10). No markdown.`;

    const recommendationsText = genAI
      ? (await generateGeminiResponse(prompt, { maxTokens: 800, temperature: 0.3 }))
      : '[]';
    let recommendations = [];
    try {
      const cleaned = recommendationsText.replace(/```json|```/g, '').trim();
      recommendations = JSON.parse(cleaned);
    } catch (err) {
      console.error('Recommendation parse error:', err, recommendationsText);
    }
    return res.json({
      success: true,
      recommendations,
      totalAvailable: products.length
    });

  } catch (error) {
    console.error('AI Recommendations error:', error);
    return res.status(500).json({ error: 'Recommendation service unavailable' });
  }
});

// AI Product Description Generator
// AI Email Generator — admin describes what they want, Gemini writes the HTML email
app.post('/api/ai/generate-email', async (req, res) => {
  try {
    const { prompt, recipients, subject } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Describe the email you want to send.' });
    if (!genAI) return res.status(503).json({ error: 'AI service not configured. Please set GEMINI_API_KEY.' });

    const fullPrompt = `You are an expert email copywriter for BConnect — Kenya's all-in-one property rental and marketplace platform.

The admin wants to send an email to: ${recipients || 'all users'}
Subject hint: ${subject || '(no subject provided)'}

Admin's instructions:
"${prompt}"

Write a professional, warm HTML email body (not a full HTML page — just the inner content).
- Use inline CSS styles for all formatting so it renders correctly in email clients
- Use a clean layout with a heading, body paragraphs, and a call-to-action button if relevant
- Keep the tone friendly and professional, in a Kenyan context
- Do NOT include <html>, <head>, or <body> tags — just the content
- Do NOT include a subject line or "Dear [Name]" greeting — the system adds those
- Include a sign-off at the end: "Warm regards, The BConnect Team"
- Return ONLY the HTML email content, no explanation or markdown fences`;

    let html = (await generateGeminiResponse(fullPrompt, { maxTokens: 800, temperature: 0.7 })).trim();
    // Strip any markdown code fences the model may have added
    html = html.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return res.json({ success: true, html });
  } catch (err) {
    console.error('AI email generation error:', err);
    return res.status(500).json({ error: 'AI email generation failed: ' + err.message });
  }
});

app.post('/api/ai/generate-description', async (req, res) => {
  try {
    const { title, category, price, location, features } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: 'Title and category are required' });
    }

    const prompt = `Generate a compelling product/service/housing description for BConnect marketplace.

DETAILS:
- Title: ${title}
- Category: ${category}
- Price: KES ${price || 'Not specified'}
- Location: ${location || 'Not specified'}
- Features: ${features || 'Standard features'}

REQUIREMENTS:
- Write in engaging, professional language
- Highlight key benefits and features
- Include location and price context
- Keep under 150 words
- Make it appealing to potential buyers/renters
- Use Kenyan context where relevant (locations, currency, etc.)`;

    if (!genAI) {
      return res.status(503).json({ error: 'AI service not configured. Please set GEMINI_API_KEY.' });
    }

    const description = (await generateGeminiResponse(prompt, { maxTokens: 200, temperature: 0.7 })).trim();

    return res.json({
      success: true,
      description,
      generated: true
    });

  } catch (error) {
    console.error('AI Description generation error:', error);
    return res.status(500).json({ error: 'Description generation failed' });
  }
});

// AI Category Suggestion
app.post('/api/ai/suggest-category', async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const prompt = `Analyze this item and suggest the most appropriate category for BConnect marketplace.

ITEM DETAILS:
Title: ${title}
Description: ${description || 'No description provided'}

BConnect Categories:
- services: Professional services, repairs, cleaning, laundry, etc.
- housing: Apartments, houses, bedsitters, rental properties
- product: Physical goods, electronics, furniture, clothing, etc.

Return only the category name (services/housing/product) that best fits.`;

    if (!genAI) {
      return res.status(503).json({ error: 'AI service not configured. Please set GEMINI_API_KEY.' });
    }

    const category = (await generateGeminiResponse(prompt, { maxTokens: 100, temperature: 0.1 })).trim().toLowerCase();

    return res.json({
      success: true,
      category,
      confidence: 'high'
    });

  } catch (error) {
    console.error('AI Category suggestion error:', error);
    return res.status(500).json({ error: 'Category suggestion failed' });
  }
});

// AI Smart Notifications/Alerts
app.get('/api/ai/alerts', async (req, res) => {
  try {
    const alerts = [];
    if (db) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const newProducts = await db.collection('properties')
        .find({ active: false, created_at: { $gte: since } })
        .project({ _id: 1, title: 1, category: 1, created_at: 1 })
        .limit(10).toArray();
      if (newProducts.length > 0) {
        alerts.push({
          type: 'admin', priority: 'medium',
          title: `${newProducts.length} new items need approval`,
          message: `New listings: ${newProducts.map(p => p.title).join(', ')}`,
          action: 'Review in admin dashboard'
        });
      }
      const trending = await db.collection('properties')
        .find({ is_trending: true, active: true })
        .project({ _id: 1, title: 1, category: 1 })
        .limit(3).toArray();
      if (trending.length > 0) {
        alerts.push({
          type: 'user', priority: 'low',
          title: 'Trending items this week',
          message: `Check out: ${trending.map(t => t.title).join(', ')}`,
          action: 'Browse trending section'
        });
      }
    }
    return res.json({ success: true, alerts, timestamp: new Date().toISOString() });
  } catch (error) {
    return res.json({ success: true, alerts: [], timestamp: new Date().toISOString() });
  }
});

// Admin API Endpoints for Properties Management
// Get all properties for admin dashboard
app.post('/api/ai/detect-spam', async (req, res) => {
  try {
    const { title, description, contact } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }

    const content = `${title} ${description} ${contact || ''}`;

    const prompt = `Analyze this marketplace listing for spam indicators:

CONTENT: "${content}"

Check for:
1. Repetitive text or keywords
2. Excessive caps or special characters
3. Unrealistic claims or prices
4. Suspicious contact information
5. Generic or template-like content
6. Inappropriate or irrelevant content

Rate spam likelihood: LOW/MEDIUM/HIGH
Provide brief reason.

Format: {"likelihood": "LOW/MEDIUM/HIGH", "reason": "brief explanation"}`;

    const resultText = genAI
      ? (await generateGeminiResponse(prompt, { maxTokens: 100, temperature: 0.2 }))
      : '{}';
    let result = {};
    try {
      result = JSON.parse(resultText);
    } catch (err) {
      console.error('Spam detection parse error:', err, resultText);
      result = { likelihood: 'UNKNOWN', reason: 'Unable to parse AI response' };
    }
    return res.json({
      success: true,
      spam: result
    });

  } catch (error) {
    console.error('AI Spam detection error:', error);
    return res.status(500).json({ error: 'Spam detection unavailable' });
  }
});

// AI Property Description Generator
app.post('/api/ai/property-description', async (req, res) => {
  try {
    const { name, location, units, rent, bedrooms, bathrooms, amenities, type } = req.body;
    if (!name || !location) return res.status(400).json({ error: 'Property name and location are required.' });
    if (!genAI) return res.status(503).json({ error: 'AI service not configured.' });

    const prompt = `Write a compelling rental property listing description for BConnect Kenya.

Property Details:
- Name: ${name}
- Location: ${location}
- Type: ${type || 'Apartment/House'}
- Units Available: ${units || 'Not specified'}
- Monthly Rent: KES ${rent ? Number(rent).toLocaleString('en-KE') : 'Contact for price'}
- Bedrooms: ${bedrooms || 'Not specified'}
- Bathrooms: ${bathrooms || 'Not specified'}
- Amenities: ${amenities || 'Standard amenities'}

Requirements:
- Write 2-3 short paragraphs, professional and warm
- Highlight key selling points, location advantages, and value for money
- Use Kenyan context (Nairobi areas, local landmarks, etc.)
- Keep under 120 words
- Do NOT include a title or header — just the description text`;

    const description = (await generateGeminiResponse(prompt, { maxTokens: 250, temperature: 0.7 })).trim();
    return res.json({ success: true, description });
  } catch (err) {
    console.error('AI property description error:', err);
    return res.status(500).json({ error: 'Property description generation failed: ' + err.message });
  }
});

// AI Smart Search
app.post('/api/ai/smart-search', async (req, res) => {
  try {
    const { query, type } = req.body;
    if (!query) return res.status(400).json({ error: 'Search query is required.' });

    const searchRegex = { $regex: query, $options: 'i' };
    const baseFilter = { status: { $in: ['approved', 'active'] } };
    if (type && type !== 'all') baseFilter.listing_type = type;

    const results = await db.collection('listings').find({
      ...baseFilter,
      $or: [{ title: searchRegex }, { description: searchRegex }, { location: searchRegex }, { category: searchRegex }]
    }).limit(30).toArray();

    if (!genAI || results.length === 0) {
      return res.json({ success: true, results: results.slice(0, 10), aiRanked: false });
    }

    const itemList = results.map((p, i) =>
      `${i}: ${p.title} | ${p.listing_type || p.category} | KES ${p.price || 0} | ${p.location || ''} | ${(p.description || '').slice(0, 80)}`
    ).join('\n');

    const prompt = `A user searched for: "${query}" on BConnect Kenya marketplace.

Here are the matching listings (index: details):
${itemList}

Rank these by relevance to the search query. Return a JSON array of the index numbers in order of relevance (most relevant first). Only include indices that are actually relevant. No markdown, just the array like: [2,0,5,1]`;

    const rankText = (await generateGeminiResponse(prompt, { maxTokens: 100, temperature: 0.1 })).trim();
    let ranked = results;
    try {
      const indices = JSON.parse(rankText.replace(/```json|```/g, '').trim());
      if (Array.isArray(indices)) {
        ranked = indices.filter(i => i >= 0 && i < results.length).map(i => results[i]);
        const usedIndices = new Set(indices);
        results.forEach((r, i) => { if (!usedIndices.has(i)) ranked.push(r); });
      }
    } catch (e) { /* fallback to original order */ }

    return res.json({ success: true, results: ranked.slice(0, 10), aiRanked: true, total: results.length });
  } catch (err) {
    console.error('AI smart search error:', err);
    return res.status(500).json({ error: 'Smart search failed: ' + err.message });
  }
});

// AI Auto Reply Generator
app.post('/api/ai/auto-reply', async (req, res) => {
  try {
    const { message, senderName, context, role } = req.body;
    if (!message) return res.status(400).json({ error: 'Original message is required.' });
    if (!genAI) return res.status(503).json({ error: 'AI service not configured.' });

    const roleContext = role === 'landlord'
      ? 'You are a landlord replying to a tenant on BConnect Kenya property platform.'
      : role === 'seller'
      ? 'You are a seller replying to a buyer on BConnect Kenya marketplace.'
      : 'You are replying to a message on BConnect Kenya platform.';

    const prompt = `${roleContext}

${context ? `Context: ${context}` : ''}
Sender: ${senderName || 'User'}
Their message: "${message}"

Write a professional, friendly, and helpful reply. Keep it concise (2-4 sentences). Use Kenyan English. Do not include a greeting line or sign-off — just the reply body.`;

    const reply = (await generateGeminiResponse(prompt, { maxTokens: 150, temperature: 0.7 })).trim();
    return res.json({ success: true, reply });
  } catch (err) {
    console.error('AI auto-reply error:', err);
    return res.status(500).json({ error: 'Auto-reply generation failed: ' + err.message });
  }
});

// AI Translation
app.post('/api/ai/translate', async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;
    if (!text) return res.status(400).json({ error: 'Text to translate is required.' });
    if (!genAI) return res.status(503).json({ error: 'AI service not configured.' });

    const lang = targetLanguage || 'Swahili';
    const prompt = `Translate the following text to ${lang}. Return only the translated text, nothing else:

"${text}"`;

    const translated = (await generateGeminiResponse(prompt, { maxTokens: 500, temperature: 0.2 })).trim();
    return res.json({ success: true, translated, targetLanguage: lang });
  } catch (err) {
    console.error('AI translation error:', err);
    return res.status(500).json({ error: 'Translation failed: ' + err.message });
  }
});

// AI Image Generation (via Pollinations.ai — free, no API key)
app.post('/api/ai/generate-image', async (req, res) => {
  try {
    const { description, style, title, category, price, location, productDescription, count } = req.body;
    if (!description) return res.status(400).json({ error: 'Image description is required.' });

    const numImages = Math.min(parseInt(count) || 1, 4);

    let enhancedPrompt = description;
    if (genAI) {
      const contextParts = [];
      if (title) contextParts.push(`Product: "${title}"`);
      if (category) contextParts.push(`Category: ${category}`);
      if (productDescription) contextParts.push(`Details: ${productDescription.substring(0, 120)}`);
      if (location) contextParts.push(`Location: ${location}`);
      if (price) contextParts.push(`Price: KES ${price}`);
      const context = contextParts.join('. ');

      const aiPrompt = `You are an expert product photographer and AI image prompt engineer for a Kenyan e-commerce marketplace.

Create a highly detailed, vivid image generation prompt (50-70 words) for this marketplace listing:
${context}
Extra style guidance: ${style || 'professional studio product photo'}

Requirements:
- Focus on the PRODUCT itself as the hero of the image
- Include lighting style (e.g. "soft studio lighting", "dramatic backlit")
- Include background (e.g. "clean white background", "minimal lifestyle setting")
- Include composition details
- Make it photorealistic and commercial-quality
- End with: "sharp focus, 4K, commercial photography"

Return ONLY the prompt text, no explanation.`;
      try {
        enhancedPrompt = (await generateGeminiResponse(aiPrompt, { maxTokens: 150, temperature: 0.7 })).trim();
      } catch (e) { /* use original description */ }
    }

    const baseEncoded = encodeURIComponent(enhancedPrompt);
    const baseTime = Date.now();

    if (numImages > 1) {
      const seeds = Array.from({ length: numImages }, (_, i) => baseTime + i * 9999);
      const imageUrls = seeds.map(seed =>
        `https://image.pollinations.ai/prompt/${baseEncoded}?width=768&height=768&nologo=true&seed=${seed}&enhance=true`
      );
      return res.json({ success: true, imageUrls, imageUrl: imageUrls[0], prompt: enhancedPrompt });
    }

    const imageUrl = `https://image.pollinations.ai/prompt/${baseEncoded}?width=768&height=768&nologo=true&seed=${baseTime}&enhance=true`;
    return res.json({ success: true, imageUrl, imageUrls: [imageUrl], prompt: enhancedPrompt });
  } catch (err) {
    console.error('AI image generation error:', err);
    return res.status(500).json({ error: 'Image generation failed: ' + err.message });
  }
});

// ===== ADMIN AI ENDPOINTS =====

async function getAdminStats() {
  try {
    const [users, products, services, orders, transactions, tenants, events, tickets] = await Promise.all([
      db.collection('profiles').countDocuments(),
      db.collection('properties').countDocuments({ category: { $ne: 'Housing/Rentals' } }),
      db.collection('services').countDocuments().catch(() => 0),
      db.collection('orders').countDocuments(),
      db.collection('transactions').countDocuments(),
      db.collection('tenants').countDocuments().catch(() => 0),
      db.collection('events').countDocuments().catch(() => 0),
      db.collection('tickets').countDocuments().catch(() => 0),
    ]);
    const roleCounts = await db.collection('profiles').aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]).toArray().catch(() => []);
    const revenue = await db.collection('transactions').aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).toArray().catch(() => []);
    const roleMap = {};
    roleCounts.forEach(r => { roleMap[r._id] = r.count; });
    return { users, products, services, orders, transactions, tenants, events, tickets, roles: roleMap, totalRevenue: revenue[0]?.total || 0 };
  } catch (e) { return {}; }
}

// AI usage status dashboard endpoint
app.get('/api/ai/usage-status', (req, res) => {
  _aiUsageResetIfNewDay();
  const apiCalls = _aiUsage.totalCalls - _aiUsage.cacheHits;
  const cacheRate = _aiUsage.totalCalls > 0
    ? Math.round((_aiUsage.cacheHits / _aiUsage.totalCalls) * 100)
    : 0;
  const models = GEMINI_MODEL_CHAIN.map(name => {
    const s = _aiUsage.models[name] || { requests: 0, successes: 0, quotaExhausted: false, lastUsed: null };
    const quota = GEMINI_MODEL_QUOTAS[name] || 1500;
    const pct = Math.min(Math.round((s.requests / quota) * 100), 100);
    let status = 'idle';
    if (s.quotaExhausted) status = 'exhausted';
    else if (s.successes > 0) status = 'active';
    else if (s.requests > 0) status = 'error';
    return { name, requests: s.requests, successes: s.successes, quota, pct, quotaExhausted: s.quotaExhausted, status, lastUsed: s.lastUsed };
  });
  const allExhausted = models.every(m => m.quotaExhausted);
  const anyActive = models.some(m => m.status === 'active');
  const overallStatus = !genAI ? 'disabled' : allExhausted ? 'exhausted' : anyActive ? 'ok' : 'degraded';
  return res.json({
    success: true,
    date: _aiUsage.date,
    overallStatus,
    totalCalls: _aiUsage.totalCalls,
    apiCalls,
    cacheHits: _aiUsage.cacheHits,
    cacheHitRate: cacheRate,
    failedCalls: _aiUsage.failedCalls,
    cacheSize: _aiCache.size,
    activeModel: _aiUsage.successModel,
    models,
  });
});

app.post('/api/ai/analytics-summary', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const prompt = `You are an analytics assistant for BConnect, a Kenya-based property rental & marketplace platform. Here are today's platform stats:\n${JSON.stringify(stats, null, 2)}\n\nWrite a concise, friendly 3-4 paragraph analytics summary for the admin. Highlight key numbers, notable patterns, and what's performing well. Use plain language. No markdown headers.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/platform-insights', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const prompt = `You are a business intelligence assistant for BConnect, a Kenya-based property rental & marketplace platform. Stats:\n${JSON.stringify(stats, null, 2)}\n\nIdentify 4-5 actionable growth opportunities, risks, or strategic insights based on these numbers. Be specific and Kenya-market aware. Format as a numbered list with brief explanations. No markdown headers.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 700 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/user-activity', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const recent = await db.collection('profiles').find({}, { projection: { role: 1, createdAt: 1, status: 1 } }).sort({ createdAt: -1 }).limit(50).toArray().catch(() => []);
    const roleBreakdown = stats.roles || {};
    const prompt = `You are a user analytics expert for BConnect Kenya. User role breakdown: ${JSON.stringify(roleBreakdown)}. Total users: ${stats.users}. Recent signups (last 50): ${recent.length} users, roles: ${recent.map(u => u.role).join(', ')}.\n\nAnalyze user activity patterns. What roles are growing? Which segments need attention? Any onboarding issues likely? Write 3-4 actionable insights in plain language.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/detect-suspicious', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const users = await db.collection('profiles').find({}, { projection: { name: 1, email: 1, role: 1, status: 1, phone: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray().catch(() => []);
    const banned = users.filter(u => u.status === 'banned').length;
    const noPhone = users.filter(u => !u.phone).length;
    const genericEmails = users.filter(u => u.email && (u.email.includes('test') || u.email.includes('fake') || u.email.includes('temp'))).length;
    const prompt = `You are a fraud detection AI for BConnect, a Kenya marketplace. User data summary: ${users.length} recent users, ${banned} already banned, ${noPhone} with no phone number, ${genericEmails} with suspicious email patterns (test/fake/temp). User roles: ${users.map(u=>u.role).join(', ')}.\n\nProvide a fraud risk assessment. List red flags to watch for in this market, patterns that indicate fake accounts, and 3-4 concrete actions the admin should take to improve account security. Be specific to Kenya e-commerce.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 650 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/buying-behavior', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const orders = await db.collection('orders').find({}, { projection: { amount: 1, status: 1, createdAt: 1, category: 1, item_name: 1 } }).sort({ createdAt: -1 }).limit(100).toArray().catch(() => []);
    const totalSpent = orders.reduce((s, o) => s + (o.amount || 0), 0);
    const statusCounts = orders.reduce((acc, o) => { acc[o.status || 'unknown'] = (acc[o.status || 'unknown'] || 0) + 1; return acc; }, {});
    const prompt = `You are a buyer behavior analyst for BConnect Kenya. Recent orders (last ${orders.length}): total value KSh ${totalSpent.toLocaleString()}, status breakdown: ${JSON.stringify(statusCounts)}. Item categories ordered: ${orders.map(o => o.category || o.item_name || 'unknown').slice(0, 30).join(', ')}.\n\nAnalyze buying patterns. What are buyers most interested in? What's the conversion rate look like? What improvements would increase sales? Write 3-4 insights.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/product-recommendations', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const orders = await db.collection('orders').find({}, { projection: { item_name: 1, amount: 1, status: 1 } }).sort({ createdAt: -1 }).limit(80).toArray().catch(() => []);
    const products = await db.collection('properties').find({ category: { $ne: 'Housing/Rentals' } }, { projection: { title: 1, name: 1, price: 1, category: 1 } }).limit(50).toArray().catch(() => []);
    const prompt = `You are a product recommendation AI for BConnect Kenya marketplace. Recent orders: ${orders.map(o => o.item_name || 'unknown').join(', ')}. Available products: ${products.map(p => (p.title || p.name) + ' (KSh ' + (p.price || 0) + ')').join(', ')}.\n\nBased on buying patterns, recommend: 1) Which products to feature prominently, 2) What categories are trending, 3) What new product types would sell well in Kenya. Format as 3 clear recommendations.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/seller-performance', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const sellers = await db.collection('profiles').find({ role: 'seller' }, { projection: { name: 1, email: 1, status: 1, createdAt: 1 } }).toArray().catch(() => []);
    const products = await db.collection('properties').find({ category: { $ne: 'Housing/Rentals' } }, { projection: { seller_id: 1, active: 1, price: 1, views: 1 } }).toArray().catch(() => []);
    const activeListings = products.filter(p => p.active).length;
    const prompt = `You are a seller performance analyst for BConnect Kenya. Stats: ${sellers.length} total sellers, ${sellers.filter(s=>s.status==='banned').length} banned. Products: ${products.length} total, ${activeListings} active. Average listings per seller: ${sellers.length ? (products.length / sellers.length).toFixed(1) : 0}.\n\nAnalyze seller performance. Identify performance gaps, what distinguishes top sellers, and provide 4 recommendations to improve seller engagement and listing quality on the platform.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 650 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/detect-fake-seller', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const sellers = await db.collection('profiles').find({ role: 'seller' }, { projection: { name: 1, email: 1, phone: 1, status: 1, createdAt: 1 } }).toArray().catch(() => []);
    const noPhone = sellers.filter(s => !s.phone).length;
    const noName = sellers.filter(s => !s.name || s.name.length < 3).length;
    const banned = sellers.filter(s => s.status === 'banned').length;
    const prompt = `You are a fraud detection AI for BConnect Kenya marketplace. Seller data: ${sellers.length} total sellers, ${noPhone} with no phone number, ${noName} with incomplete names, ${banned} already banned.\n\nProvide a fake/fraudulent seller risk assessment for the Kenya market. List: 1) Warning signs of fake sellers, 2) What to check during manual review, 3) Automated rules to flag suspicious accounts, 4) Steps to verify legitimate sellers. Be specific and actionable.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 650 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/rental-recommendations', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const properties = await db.collection('properties').find({ category: 'Housing/Rentals', active: true }, { projection: { title: 1, name: 1, location: 1, rent: 1, price: 1, bedrooms: 1, amenities: 1 } }).limit(40).toArray().catch(() => []);
    const tenants = await db.collection('tenants').countDocuments().catch(() => 0);
    const prompt = `You are a rental recommendation AI for BConnect Kenya. Available properties: ${properties.map(p => `${p.title||p.name} in ${p.location||'Nairobi'}, KSh ${p.rent||p.price||0}/month, ${p.bedrooms||'?'} BR`).join('; ')}. Active tenants: ${tenants}.\n\nProvide: 1) Top 3 recommended properties and why, 2) What features tenants value most in Kenya, 3) How to better match tenants to properties, 4) Pricing insights for the Nairobi rental market.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 650 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/tenant-support', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const { question } = req.body;
    if (!question) return res.status(400).json({ success: false, error: 'Question is required' });
    const prompt = `You are a knowledgeable admin support assistant for BConnect, a Kenya property rental & marketplace platform. An admin is asking this question about tenant management: "${question}"\n\nProvide a helpful, specific answer. Reference Kenya rental laws or M-Pesa payment context where relevant. Keep it practical and under 200 words.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 400 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/rent-price-suggestion', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const { propertyDetails } = req.body;
    if (!propertyDetails) return res.status(400).json({ success: false, error: 'Property details required' });
    const prompt = `You are a Kenya real estate pricing expert. A landlord on BConnect wants a rent price suggestion for this property: "${propertyDetails}".\n\nProvide: 1) A suggested monthly rent range in KSh with justification, 2) Factors that justify this price in the Kenya market, 3) Tips to command the higher end of the range, 4) Any comparable areas/benchmarks. Be specific and realistic for Nairobi/Kenya.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 500 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/event-promotion', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const { eventDetails } = req.body;
    if (!eventDetails) return res.status(400).json({ success: false, error: 'Event details required' });
    const prompt = `You are a marketing copywriter for BConnect Kenya. Generate compelling promotional text for this event: "${eventDetails}".\n\nWrite: 1) A punchy social media caption (under 60 words), 2) A WhatsApp promo message (under 80 words), 3) A short email subject line and preview text, 4) 3 hashtag suggestions. Make it energetic, specific, and appealing to a Kenyan audience. No markdown formatting — use plain numbered sections.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/ticket-insights', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const tickets = await db.collection('tickets').find({}, { projection: { amount: 1, status: 1, event_name: 1, quantity: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(100).toArray().catch(() => []);
    const totalRevenue = tickets.reduce((s, t) => s + (t.amount || 0), 0);
    const used = tickets.filter(t => t.status === 'used').length;
    const events = [...new Set(tickets.map(t => t.event_name).filter(Boolean))];
    const prompt = `You are an event analytics AI for BConnect Kenya. Ticket data: ${tickets.length} tickets sold, KSh ${totalRevenue.toLocaleString()} total revenue, ${used} tickets checked in/used, events covered: ${events.slice(0,10).join(', ')||'none yet'}.\n\nProvide: 1) Ticket sales performance summary, 2) Check-in rate analysis, 3) Which event types tend to sell best in Kenya, 4) Recommendations to increase ticket sales on BConnect.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/financial-summary', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const txns = await db.collection('transactions').find({}, { projection: { amount: 1, type: 1, status: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(200).toArray().catch(() => []);
    const totalRevenue = txns.reduce((s, t) => s + (t.amount || 0), 0);
    const byType = txns.reduce((acc, t) => { const k = t.type||'other'; acc[k] = (acc[k]||0) + (t.amount||0); return acc; }, {});
    const completed = txns.filter(t => t.status === 'completed').length;
    const pending = txns.filter(t => t.status === 'pending').length;
    const prompt = `You are a financial analyst for BConnect Kenya (property rental & marketplace). Transaction data: ${txns.length} transactions, KSh ${totalRevenue.toLocaleString()} total revenue, ${completed} completed, ${pending} pending. Revenue by type: ${JSON.stringify(byType)}.\n\nWrite a comprehensive financial health summary with: 1) Revenue overview, 2) Best-performing revenue streams, 3) Financial risks or concerns, 4) 3 recommendations to grow revenue. Use KSh currency. Plain language, no markdown headers.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 700 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/promo-text', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const { title, type, extra } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Item title required' });
    const prompt = `You are a marketing copywriter for BConnect Kenya, a property rental & marketplace platform. Generate slider promotional text for this ${type||'item'}: "${title}". Extra details: ${extra||'none provided'}.\n\nWrite exactly:\nTitle (max 8 words): [your slider title]\nSubtitle (max 15 words): [your subtitle/caption]\nCTA Button Text (max 4 words): [your call-to-action]\nShort description (max 20 words): [teaser text for the card]\n\nMake it punchy, Kenya-market relevant, and action-driving.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 300 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/report-summary', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const prompt = `You are a report writer for BConnect Kenya (property rental & marketplace). Platform stats:\n${JSON.stringify(stats, null, 2)}\n\nWrite a clear, plain-language executive report summary. Cover: user base health, marketplace activity, financial performance, and 3 key action items for the next 30 days. Use KSh for currency. Write as a professional report paragraph (no bullet lists, no headers). Under 300 words.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 600 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/trend-analysis', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const recentOrders = await db.collection('orders').find({}, { projection: { createdAt: 1, amount: 1, category: 1 } }).sort({ createdAt: -1 }).limit(50).toArray().catch(() => []);
    const recentUsers = await db.collection('profiles').find({}, { projection: { createdAt: 1, role: 1 } }).sort({ createdAt: -1 }).limit(50).toArray().catch(() => []);
    const prompt = `You are a trend analyst for BConnect Kenya. Platform overview: ${JSON.stringify(stats)}. Recent orders: ${recentOrders.length}, recent signups: ${recentUsers.length}, roles signing up: ${recentUsers.map(u=>u.role).join(', ')}.\n\nIdentify 4-5 trends in the data. Consider: which user roles are growing, what's driving revenue, seasonal patterns relevant to Kenya, and emerging opportunities. Present as a numbered trend list with brief explanations.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 650 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/setting-helper', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const { question } = req.body;
    if (!question) return res.status(400).json({ success: false, error: 'Question required' });
    const prompt = `You are a platform configuration expert for BConnect, a Kenya-based property rental & marketplace platform using Node.js, MongoDB, M-Pesa, and Gemini AI. An admin is asking: "${question}"\n\nGive a clear, specific, actionable answer. Consider Kenya's market, M-Pesa payment patterns, and best practices for online marketplaces. Keep it under 250 words and practical.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 450 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/ai/config-suggestion', async (req, res) => {
  try {
    if (!genAI) return res.status(503).json({ success: false, error: 'AI not configured' });
    const stats = await getAdminStats();
    const prompt = `You are a platform optimization expert for BConnect Kenya (property rental & marketplace, Node.js + MongoDB + M-Pesa). Current stats: ${JSON.stringify(stats)}.\n\nSuggest optimal platform configuration for this stage of growth. Cover: 1) Commission rate recommendation with reasoning, 2) Email/notification settings best practices, 3) Content moderation threshold, 4) Feature prioritization for Kenya market, 5) Performance optimization tips. Be specific and Kenya-market aware.`;
    const result = await generateGeminiResponse(prompt, { maxTokens: 700 });
    return res.json({ success: true, result });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

// Helper function to get platform context for AI
async function getPlatformContext() {
  try {
    if (!db) return 'Platform data temporarily unavailable.';

    const [products, recent] = await Promise.all([
      db.collection('properties').find({ active: true }).project({ category: 1, listing_type: 1 }).toArray(),
      db.collection('properties').find({ active: true }).sort({ created_at: -1 }).limit(5).project({ title: 1, category: 1, listing_type: 1 }).toArray()
    ]);

    const stats = {
      active: products.length,
      services: products.filter(p => p.listing_type === 'service' || p.category === 'services').length,
      housing: products.filter(p => p.listing_type === 'housing').length,
      products: products.filter(p => !p.listing_type || (p.listing_type !== 'service' && p.listing_type !== 'housing')).length
    };

    const recentItems = recent.map(r => `${r.title || 'Item'} (${r.listing_type || r.category || 'general'})`).join(', ') || 'None';

    return `
CURRENT STATS:
- Total active listings: ${stats.active}
- Services: ${stats.services}
- Housing: ${stats.housing}
- Products: ${stats.products}

RECENT ACTIVITY:
- Latest listings: ${recentItems}

PLATFORM FEATURES:
- M-Pesa payment integration
- Admin dashboard for approvals
- AI-powered recommendations
- Smart notifications
    `;

  } catch (error) {
    console.error('Error getting platform context:', error);
    return 'Platform data temporarily unavailable.';
  }
}

// ===== AUTHENTICATION ENDPOINTS =====

// User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      email,
      password,
      fullName,
      role,
      phone,
      country,
      city,
      address,
      business_name,
      bio
    } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Missing required fields: email, password, fullName' });
    }

    // All users start as 'buyer' — roles are auto-assigned when they take actions
    const normalizedRole = 'buyer';

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    const existingUser = await db.collection('profiles').findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user profile
    const userId = new ObjectId();
    const profileData = {
      _id: userId,
      email: email.toLowerCase(),
      password: hashedPassword,
      full_name: fullName,
      role: normalizedRole,
      phone: phone || null,
      country: country || null,
      city: city || null,
      address: address || null,
      business_name: business_name || null,
      bio: bio || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    // Generate email verification token (valid 24 hours)
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    profileData.email_verified = false;
    profileData.verification_token = verificationToken;
    profileData.verification_token_expires = verificationExpiry;

    const result = await db.collection('profiles').insertOne(profileData);

    if (!result.acknowledged) {
      return res.status(500).json({ error: 'Failed to create user profile' });
    }

    // Send verification email
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5000';
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;
    const { text: vText, html: vHtml } = emailVerificationEmail(fullName, verifyUrl);
    sendEmail(email.toLowerCase(), 'Verify your BConnect email', vText, vHtml);

    return res.json({
      success: true,
      requiresVerification: true,
      message: 'Account created! Please check your email to verify your account before signing in.',
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

// Email Verification
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send(verifyPage('Invalid Link', 'No verification token provided.', false));

    const user = await db.collection('profiles').findOne({
      verification_token: token,
      verification_token_expires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).send(verifyPage('Link Expired', 'This verification link is invalid or has expired. Please request a new one from the login page.', false));
    }

    await db.collection('profiles').updateOne(
      { _id: user._id },
      { $set: { email_verified: true, updated_at: new Date() }, $unset: { verification_token: '', verification_token_expires: '' } }
    );

    // Send welcome email now that they're verified
    const { text: wText, html: wHtml } = welcomeEmail(user.full_name, user.role);
    sendEmail(user.email, 'Welcome to BConnect!', wText, wHtml);

    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5000';
    return res.send(verifyPage('Email Verified!', 'Your email has been verified successfully. You can now sign in to your BConnect account.', true, `${baseUrl}/login.html?verified=1`));
  } catch (err) {
    console.error('Email verify error:', err);
    return res.status(500).send(verifyPage('Error', 'Something went wrong. Please try again.', false));
  }
});

function verifyPage(title, message, success, redirectUrl) {
  const icon = success
    ? `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const iconBg = success ? 'linear-gradient(135deg,#7c3aed,#4f46e5)' : 'linear-gradient(135deg,#dc2626,#b91c1c)';
  const btn = redirectUrl
    ? `<a href="${redirectUrl}" style="display:inline-block;margin-top:20px;padding:13px 36px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">Sign In to BConnect</a>`
    : `<a href="/login.html" style="display:inline-block;margin-top:20px;padding:13px 36px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">Back to Login</a>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — BConnect</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#f4f4f7;font-family:'Segoe UI',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:420px;width:100%;padding:48px 36px;text-align:center}.icon{width:72px;height:72px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.brand{font-size:13px;color:#9ca3af;margin-bottom:32px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}h1{font-size:1.5rem;font-weight:800;color:#111827;margin-bottom:12px}p{font-size:.9rem;color:#6b7280;line-height:1.6}</style></head><body><div class="card"><div class="brand">BConnect</div><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p>${btn}</div></body></html>`;
}

// Resend Verification Email
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await db.collection('profiles').findOne({ email: email.toLowerCase() });
    if (!user) return res.json({ success: true, message: 'If that account exists, a new verification email has been sent.' });
    if (user.email_verified) return res.json({ success: true, message: 'Your email is already verified. Please sign in.' });

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.collection('profiles').updateOne(
      { _id: user._id },
      { $set: { verification_token: verificationToken, verification_token_expires: verificationExpiry } }
    );

    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5000';
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;
    const { text: vText, html: vHtml } = emailVerificationEmail(user.full_name, verifyUrl);
    await sendEmail(user.email, 'Verify your BConnect email', vText, vHtml);

    return res.json({ success: true, message: 'Verification email sent! Please check your inbox.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user by email
    const user = await db.collection('profiles').findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Block login if email not verified (only enforce for accounts that have the field set)
    if (user.email_verified === false) {
      return res.status(403).json({
        error: 'Please verify your email before signing in. Check your inbox for the verification link.',
        requiresVerification: true,
        email: user.email
      });
    }

    // 2FA check — if enabled, issue a short-lived pending code and ask for verification
    if (user.twofa_enabled) {
      const twoFaCode = String(Math.floor(100000 + Math.random() * 900000));
      const twoFaExpires = new Date(Date.now() + 10 * 60 * 1000);
      await db.collection('profiles').updateOne(
        { _id: user._id },
        { $set: { twofa_login_code: twoFaCode, twofa_login_expires: twoFaExpires } }
      );
      return res.json({ requires2FA: true, pendingUserId: user._id.toString(), code: twoFaCode });
    }

    // Generate JWT token
    const token = generateToken(user._id.toString());

    // For landlord/tenant roles, look up their role-specific record by email so
    // the dedicated dashboards get the correct collection ID
    let landlordId = null;
    let tenantId = null;
    if (user.role === 'landlord') {
      const lRecord = await db.collection('landlords').findOne({ email: user.email }, { projection: { _id: 1 } });
      landlordId = lRecord ? lRecord._id.toString() : user._id.toString();
    }
    if (user.role === 'tenant') {
      const tRecord = await db.collection('tenants').findOne({ email: user.email }, { projection: { _id: 1 } });
      tenantId = tRecord ? tRecord._id.toString() : user._id.toString();
    }

    return res.json({
      success: true,
      token,
      ...(landlordId && { landlordId }),
      ...(tenantId && { tenantId }),
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.full_name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed: ' + error.message });
  }
});

// 2FA login verification — called after password check when user has 2FA enabled
app.post('/api/auth/login/2fa', async (req, res) => {
  try {
    const { pendingUserId, code } = req.body;
    if (!pendingUserId || !code) return res.status(400).json({ error: 'User ID and code are required' });
    let lookupId;
    try { lookupId = new ObjectId(pendingUserId); } catch (_) { lookupId = pendingUserId; }
    const user = await db.collection('profiles').findOne({ _id: lookupId });
    if (!user) return res.status(401).json({ error: 'Invalid session. Please log in again.' });
    if (!user.twofa_login_code) return res.status(400).json({ error: 'No pending code. Please log in again.' });
    if (new Date() > new Date(user.twofa_login_expires)) return res.status(400).json({ error: 'Code expired. Please log in again.' });
    if (user.twofa_login_code !== String(code)) return res.status(400).json({ error: 'Invalid code. Please try again.' });
    await db.collection('profiles').updateOne(
      { _id: lookupId },
      { $unset: { twofa_login_code: '', twofa_login_expires: '' } }
    );
    const token = generateToken(user._id.toString());
    let landlordId = null, tenantId = null;
    if (user.role === 'landlord') {
      const lRecord = await db.collection('landlords').findOne({ email: user.email }, { projection: { _id: 1 } });
      landlordId = lRecord ? lRecord._id.toString() : user._id.toString();
    }
    if (user.role === 'tenant') {
      const tRecord = await db.collection('tenants').findOne({ email: user.email }, { projection: { _id: 1 } });
      tenantId = tRecord ? tRecord._id.toString() : user._id.toString();
    }
    return res.json({
      success: true, token,
      ...(landlordId && { landlordId }),
      ...(tenantId && { tenantId }),
      user: { id: user._id.toString(), email: user.email, name: user.full_name, role: user.role }
    });
  } catch (error) {
    console.error('2FA login error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

//  PASSWORD RESET 

// Step 1: Request reset link
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await db.collection('profiles').findOne({ email: email.toLowerCase() });
    // Always respond success to prevent email enumeration
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await db.collection('profiles').updateOne(
      { _id: user._id },
      { $set: { reset_token: token, reset_token_expires: expiry } }
    );

    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : 'http://localhost:5000';
    const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;

    const { text, html } = passwordResetEmail(user.full_name || user.email, resetUrl);
    await sendEmail(user.email, 'Reset Your BConnect Password', text, html);

    return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Failed to process request' });
  }
});

// Step 2: Verify token and set new password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = await db.collection('profiles').findOne({
      reset_token: token,
      reset_token_expires: { $gt: new Date() }
    });
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const hashed = await bcrypt.hash(password, 12);
    await db.collection('profiles').updateOne(
      { _id: user._id },
      { $set: { password: hashed, updated_at: new Date() }, $unset: { reset_token: '', reset_token_expires: '' } }
    );

    console.log(`[email] Password reset completed for ${user.email}`);
    return res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

//  BOOKING / VIEWING CONFIRMATION 

app.post('/api/bookings/viewing', async (req, res) => {
  try {
    const { propertyId, propertyName, location, name, email, phone, date, time, message } = req.body;
    if (!propertyName || !phone) return res.status(400).json({ error: 'Property name and phone are required' });

    const booking = {
      property_id: propertyId || null,
      property_name: propertyName,
      location: location || '',
      tenant_name: name || '',
      tenant_email: email || '',
      tenant_phone: phone,
      date: date || null,
      time: time || null,
      message: message || '',
      status: 'pending',
      created_at: new Date()
    };

    if (db) await db.collection('viewings').insertOne(booking);

    // Send confirmation email to tenant
    if (email) {
      const { text, html } = bookingConfirmationEmail(name || email, {
        propertyName,
        location,
        date,
        time,
        phone
      });
      sendEmail(email, 'Viewing Booked — BConnect', text, html);
    }

    return res.json({ success: true, message: 'Viewing booked! You will receive a confirmation email.' });
  } catch (err) {
    console.error('Booking error:', err);
    return res.status(500).json({ error: 'Failed to book viewing' });
  }
});

// Public profile save endpoint (no auth required)
app.post('/api/profile/save-public', async (req, res) => {
  try {
    const {
      email,
      fullName,
      role,
      phone,
      country,
      city,
      address,
      business_name,
      bio,
      password
    } = req.body;

    if (!email || !fullName || !role) {
      return res.status(400).json({ error: 'Missing required fields: email, fullName, role' });
    }

    const allowedRoles = ['buyer', 'seller', 'landlord'];
    const normalizedRole = role.toLowerCase();

    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({ error: 'Invalid role selected' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if MongoDB is connected
    if (!db) {
      return res.status(503).json({ error: 'Database connection unavailable. Please try again later.' });
    }

    let userId = crypto.randomUUID();

    // Check for duplicate email using file-based registry
    const fs = require('fs');
    const path = require('path');
    const emailRegistryPath = path.join(__dirname, 'email-registry.json');

    let registeredEmails = [];
    try {
      const registryData = fs.readFileSync(emailRegistryPath, 'utf8');
      registeredEmails = JSON.parse(registryData).emails || [];
    } catch (error) {
      console.log('Error reading email registry:', error.message);
      // Create registry if it doesn't exist
      fs.writeFileSync(emailRegistryPath, JSON.stringify({ emails: [] }, null, 2));
    }

    console.log('Checking email uniqueness for:', email);
    if (registeredEmails.includes(email)) {
      // Double-check if profile actually exists in MongoDB
      try {
        const existingProfile = await db.collection('profiles').findOne({ email: email.toLowerCase() });
        if (existingProfile) {
          console.log('Email already registered in database:', email);
          return res.status(409).json({ error: 'Email address is already registered. Please use a different email or log in with your existing account.' });
        } else {
          console.log('Email in registry but not in database, allowing re-registration for:', email);
          // Remove from registry to allow re-registration
          registeredEmails = registeredEmails.filter(e => e !== email);
          fs.writeFileSync(emailRegistryPath, JSON.stringify({ emails: registeredEmails }, null, 2));
        }
      } catch (dbError) {
        console.log('Database check failed, allowing re-registration for:', email);
        // Remove from registry to allow re-registration
        registeredEmails = registeredEmails.filter(e => e !== email);
        fs.writeFileSync(emailRegistryPath, JSON.stringify({ emails: registeredEmails }, null, 2));
      }
    }

    const profilePayload = {
      _id: userId,
      email: email.toLowerCase(),
      full_name: fullName,
      role: normalizedRole,
      phone: phone || null,
      country: country || null,
      city: city || null,
      address: address || null,
      business_name: business_name || null,
      bio: bio || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    // Hash password if provided
    if (password) {
      const saltRounds = 12;
      profilePayload.password = await bcrypt.hash(password, saltRounds);
    }

    // Save profile to MongoDB
    const result = await db.collection('profiles').insertOne(profilePayload);

    if (!result.acknowledged) {
      console.error('Profile save failed: Insert not acknowledged');
      return res.status(500).json({ error: 'Unable to save profile information.' });
    }

    // Register email in file-based registry
    try {
      let registry = { emails: [] };
      try {
        const registryData = fs.readFileSync(emailRegistryPath, 'utf8');
        registry = JSON.parse(registryData);
      } catch (readError) {
        console.log('Creating new email registry file');
      }

      if (!registry.emails.includes(email)) {
        registry.emails.push(email);
        fs.writeFileSync(emailRegistryPath, JSON.stringify(registry, null, 2));
        console.log('Email registered in file registry:', email);
      }
    } catch (emailError) {
      console.warn('Email registry update failed:', emailError.message);
    }

    return res.json({
      success: true,
      profile: {
        id: userId,
        email: email.toLowerCase(),
        full_name: fullName,
        role: normalizedRole,
        phone: phone || null,
        country: country || null,
        city: city || null,
        address: address || null,
        business_name: business_name || null,
        bio: bio || null,
        created_at: profilePayload.created_at,
        updated_at: profilePayload.updated_at
      }
    });
  } catch (error) {
    console.error('Public profile save failed:', error);
    return res.status(500).json({ error: 'Failed to save profile information: ' + error.message });
  }
});

// Get Current User (requires auth)
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    let user;
    try { user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) }); } catch { user = null; }
    if (!user) user = await db.collection('users').findOne({ id: req.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Config endpoint (public - for frontend to know the setup)
app.get('/api/config', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== SELLER ITEM SUBMISSION =====

// Submit item for approval (sellers)
app.post('/api/seller/submit-item', requireAuth, async (req, res) => {
  try {
    const {
      title,
      description,
      price,
      category,
      location,
      images,
      type // 'product', 'service', or 'housing'
    } = req.body;

    if (!title || !description || !category) {
      return res.status(400).json({ error: 'Title, description, and category are required' });
    }

    if (!db) return res.status(500).json({ error: 'Database not connected' });
    let userFilter;
    try { userFilter = { _id: new ObjectId(req.user.id) }; } catch { userFilter = { id: req.user.id }; }
    const profile = await db.collection('users').findOne(userFilter);

    const FREE_POST_LIMIT = 5;
    const freePostsUsed = profile?.free_posts_used || 0;
    const hasFreePosts = freePostsUsed < FREE_POST_LIMIT;
    const itemPrice = parseFloat(price) || 0;

    // Determine if payment is required
    let requiresPayment = false;
    let paymentAmount = 0;

    if (!hasFreePosts) {
      // No free posts left, payment required based on item price
      requiresPayment = true;
      paymentAmount = Math.max(itemPrice * 0.1, 100); // 10% of item price, minimum KES 100
    }

    if (requiresPayment) {
      return res.json({
        success: false,
        requiresPayment: true,
        paymentAmount,
        message: `Payment of KES ${paymentAmount} required to post this item. You have already used your ${FREE_POST_LIMIT} free listings.`
      });
    }

    // Proceed with free submission
    const normalizedCategory = category.toString().trim().toLowerCase();
    let itemCategory = 'product';
    if (normalizedCategory === 'housing' || normalizedCategory.includes('housing') || normalizedCategory.includes('rent')) {
      itemCategory = 'housing';
    } else if (normalizedCategory === 'service' || normalizedCategory === 'services' || normalizedCategory.includes('service')) {
      itemCategory = 'service';
    }

    const finalDescription = `${description.trim()}${req.body.subcategory ? `\n\nSubcategory: ${req.body.subcategory.trim()}` : ''}`;

    // Calculate expiry date (7 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7);

    let tableName, itemData;

    if (itemCategory === 'housing' || itemCategory === 'service') {
      tableName = 'properties';
      itemData = {
        title,
        description: finalDescription,
        price: itemPrice,
        category: itemCategory,
        location: location || '',
        images: images || [],
        user_id: req.user.id,
        active: false, // Pending admin approval
        rejection_reason: null,
        expiry_date: expiryDate.toISOString(),
        is_paid: false,
        payment_amount: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    } else {
      tableName = 'products';
      itemData = {
        name: title,
        description: finalDescription,
        price: itemPrice,
        category: 'product',
        location: location || '',
        images: images || [],
        user_id: req.user.id,
        active: false, // Pending admin approval
        rejection_reason: null,
        expiry_date: expiryDate.toISOString(),
        is_paid: false,
        payment_amount: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }

    const insertResult = await db.collection(tableName).insertOne({ ...itemData, created_at: new Date(), updated_at: new Date() });
    if (!insertResult.insertedId) {
      return res.status(500).json({ error: 'Unable to submit item' });
    }
    const data = { ...itemData, _id: insertResult.insertedId, id: insertResult.insertedId.toString() };

    const remainingFreePosts = Math.max(0, FREE_POST_LIMIT - (freePostsUsed + 1));
    await db.collection('users').updateOne(userFilter, { $set: { free_posts_used: freePostsUsed + 1 } });

    try {
      await db.collection('notifications').insertOne({
        user_id: req.user.id, type: 'submission',
        title: 'Item Submitted for Approval',
        message: `Your item "${title}" has been submitted for admin review. You'll be notified once it's approved. Free posts remaining: ${remainingFreePosts}`,
        data: { item_id: data.id, table: tableName, expiry_date: expiryDate.toISOString() },
        created_at: new Date()
      });
    } catch (notifError) { console.error('Seller notification error:', notifError); }

    try {
      const adminUsers = await db.collection('users').find({ role: 'admin' }).project({ _id: 1 }).limit(10).toArray();
      if (adminUsers.length > 0) {
        const adminNotifications = adminUsers.map(admin => ({
          user_id: admin._id.toString(), type: 'admin',
          title: 'New Item Pending Approval',
          message: `"${title}" in ${itemCategory} category needs review`,
          data: { item_id: data.id, table: tableName, seller_id: req.user.id },
          created_at: new Date()
        }));
        await db.collection('notifications').insertMany(adminNotifications);
      }
    } catch (adminNotifError) { console.error('Admin notification error:', adminNotifError); }

    return res.json({
      success: true, item: data,
      message: `Item submitted successfully! Awaiting admin approval. Free posts remaining: ${remainingFreePosts}`,
      status: 'pending', expiryDate: expiryDate.toISOString()
    });
  } catch (error) {
    console.error('Item submission endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Paid item submission endpoint
app.post('/api/seller/submit-item-paid', requireAuth, async (req, res) => {
  try {
    const {
      title,
      description,
      price,
      category,
      location,
      images,
      paymentAmount,
      orderId // From M-Pesa payment
    } = req.body;

    if (!title || !description || !category || !paymentAmount || !orderId) {
      return res.status(400).json({ error: 'All fields including payment details are required' });
    }

    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const order = await db.collection('orders').findOne({ order_id: orderId });
    if (!order) return res.status(400).json({ error: 'Payment verification failed' });
    if (order.payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Payment not completed yet' });
    if (parseFloat(order.amount) !== parseFloat(paymentAmount)) return res.status(400).json({ error: 'Payment amount mismatch' });

    // Proceed with paid submission
    const normalizedCategory = category.toString().trim().toLowerCase();
    let itemCategory = 'product';
    if (normalizedCategory === 'housing' || normalizedCategory.includes('housing') || normalizedCategory.includes('rent')) {
      itemCategory = 'housing';
    } else if (normalizedCategory === 'service' || normalizedCategory === 'services' || normalizedCategory.includes('service')) {
      itemCategory = 'service';
    }

    const finalDescription = `${description.trim()}${req.body.subcategory ? `\n\nSubcategory: ${req.body.subcategory.trim()}` : ''}`;

    // Calculate expiry date (7 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7);

    const itemPrice = parseFloat(price) || 0;

    let tableName, itemData;

    if (itemCategory === 'housing' || itemCategory === 'service') {
      tableName = 'properties';
      itemData = {
        title,
        description: finalDescription,
        price: itemPrice,
        category: itemCategory,
        location: location || '',
        images: images || [],
        user_id: req.user.id,
        active: true, // Paid posts are auto-approved
        rejection_reason: null,
        expiry_date: expiryDate.toISOString(),
        is_paid: true,
        payment_amount: parseFloat(paymentAmount),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    } else {
      tableName = 'products';
      itemData = {
        name: title,
        description: finalDescription,
        price: itemPrice,
        category: 'product',
        location: location || '',
        images: images || [],
        user_id: req.user.id,
        active: true, // Paid posts are auto-approved
        rejection_reason: null,
        expiry_date: expiryDate.toISOString(),
        is_paid: true,
        payment_amount: parseFloat(paymentAmount),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }

    const paidInsert = await db.collection(tableName).insertOne({ ...itemData, created_at: new Date(), updated_at: new Date() });
    if (!paidInsert.insertedId) return res.status(500).json({ error: 'Unable to submit paid item' });
    const data = { ...itemData, _id: paidInsert.insertedId, id: paidInsert.insertedId.toString() };

    try {
      await db.collection('notifications').insertOne({
        user_id: req.user.id, type: 'submission',
        title: 'Paid Item Posted Successfully',
        message: `Your paid item "${title}" has been posted and will be visible for 7 days.`,
        data: { item_id: data.id, table: tableName, expiry_date: expiryDate.toISOString(), payment_amount: paymentAmount },
        created_at: new Date()
      });
    } catch (notifError) { console.error('Seller notification error:', notifError); }

    return res.json({ success: true, item: data, message: 'Paid item posted successfully!', expiryDate: expiryDate.toISOString() });
  } catch (error) {
    console.error('Paid item submission endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Renew expired item endpoint
app.post('/api/seller/renew-item', requireAuth, async (req, res) => {
  try {
    const { itemId, tableName, paymentAmount, orderId } = req.body;

    if (!itemId || !tableName || !paymentAmount || !orderId) {
      return res.status(400).json({ error: 'Item ID, table name, payment amount, and order ID are required' });
    }

    if (!['products', 'properties'].includes(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const renewOrder = await db.collection('orders').findOne({ order_id: orderId });
    if (!renewOrder) return res.status(400).json({ error: 'Payment verification failed' });
    if (renewOrder.payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Payment not completed yet' });
    if (parseFloat(renewOrder.amount) !== parseFloat(paymentAmount)) return res.status(400).json({ error: 'Payment amount mismatch' });

    const newExpiryDate = new Date();
    newExpiryDate.setDate(newExpiryDate.getDate() + 7);

    let itemFilter;
    try { itemFilter = { _id: new ObjectId(itemId), user_id: req.user.id }; } catch { itemFilter = { id: itemId, user_id: req.user.id }; }
    const renewResult = await db.collection(tableName).findOneAndUpdate(
      itemFilter,
      { $set: { active: true, expiry_date: newExpiryDate.toISOString(), updated_at: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
    if (!renewResult) return res.status(404).json({ error: 'Item not found or unauthorized' });
    const data = renewResult;

    try {
      await db.collection('notifications').insertOne({
        user_id: req.user.id, type: 'renewal',
        title: 'Item Renewed Successfully',
        message: `Your item "${data.title || data.name}" has been renewed and will be visible for another 7 days.`,
        data: { item_id: itemId, table: tableName, expiry_date: newExpiryDate.toISOString(), payment_amount: paymentAmount },
        created_at: new Date()
      });
    } catch (notifError) {
      console.error('Renewal notification error:', notifError);
    }

    return res.json({
      success: true,
      item: data,
      message: 'Item renewed successfully!',
      newExpiryDate: newExpiryDate.toISOString()
    });
  } catch (error) {
    console.error('Item renewal endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Function to check and deactivate expired items
async function checkExpiredItems() {
  try {
    if (!db) return;
    const gracePeriodEnd = new Date();
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() - 2);
    const cutoff = gracePeriodEnd.toISOString();
    await db.collection('products').updateMany({ active: true, expiry_date: { $lt: cutoff } }, { $set: { active: false } });
    await db.collection('properties').updateMany({ active: true, expiry_date: { $lt: cutoff } }, { $set: { active: false } });
    console.log('Expired items check completed');
  } catch (error) {
    console.error('Error checking expired items:', error);
  }
}

// Run expiry check every hour
setInterval(checkExpiredItems, 60 * 60 * 1000);

// Function to check and update expired trending items
async function checkExpiredTrendingItems() {
  try {
    if (!db) return;
    const now = new Date();

    // Update products — set is_trending to false if expiry date passed
    await db.collection('properties').updateMany(
      { is_trending: true, trending_expiry_date: { $lt: now } },
      { $set: { is_trending: false } }
    );

    // Update promoted sliders — mark as inactive if expired
    await db.collection('sliders').updateMany(
      { promoted: true, expiresAt: { $lt: now } },
      { $set: { active: false } }
    );

    // Update promoted products — clear promoted flag if expired
    await db.collection('properties').updateMany(
      { promoted: true, promotedUntil: { $lt: now } },
      { $set: { promoted: false } }
    );

    console.log('Trending items check completed');
  } catch (error) {
    console.error('Error checking trending items:', error);
  }
}

// Run trending check every 30 minutes
setInterval(checkExpiredTrendingItems, 30 * 60 * 1000);

// Boost item to trending
app.post('/api/seller/boost-trending', requireAuth, async (req, res) => {
  try {
    const { itemId, tableName, daysToBoost, paymentAmount, orderId } = req.body;

    if (!itemId || !tableName || !daysToBoost || !paymentAmount || !orderId) {
      return res.status(400).json({ error: 'All fields required' });
    }

    if (!['products', 'properties'].includes(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    if (daysToBoost < 1 || daysToBoost > 30) {
      return res.status(400).json({ error: 'Boost duration must be 1-30 days' });
    }

    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const boostOrder = await db.collection('orders').findOne({ order_id: orderId });
    if (!boostOrder) return res.status(400).json({ error: 'Payment verification failed' });
    if (boostOrder.payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Payment not completed yet' });
    if (parseFloat(boostOrder.amount) !== parseFloat(paymentAmount)) return res.status(400).json({ error: 'Payment amount mismatch' });

    const trendingExpiryDate = new Date();
    trendingExpiryDate.setDate(trendingExpiryDate.getDate() + daysToBoost);

    let boostFilter;
    try { boostFilter = { _id: new ObjectId(itemId), user_id: req.user.id }; } catch { boostFilter = { id: itemId, user_id: req.user.id }; }
    const boostResult = await db.collection(tableName).findOneAndUpdate(
      boostFilter,
      { $set: { is_trending: true, trending_expiry_date: trendingExpiryDate.toISOString(), updated_at: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
    if (!boostResult) return res.status(404).json({ error: 'Unable to boost item' });
    const data = boostResult;

    try {
      await db.collection('notifications').insertOne({
        user_id: req.user.id, type: 'boost', title: 'Item Boosted to Trending!',
        message: `Your item "${data.title || data.name}" is now trending and will appear at the top of the homepage for ${daysToBoost} days!`,
        data: { item_id: itemId, table: tableName, expiry_date: trendingExpiryDate.toISOString() },
        created_at: new Date()
      });
    } catch (notifError) { console.error('Boost notification error:', notifError); }

    return res.json({ success: true, item: data, message: `Item boosted to trending for ${daysToBoost} days!`, trendingExpiryDate: trendingExpiryDate.toISOString() });
  } catch (error) {
    console.error('Trending boost endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Get seller's submitted items
app.get('/api/seller/items', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, items: [] });
    const products = await db.collection('products').find({ user_id: req.user.id }).sort({ created_at: -1 }).toArray();
    const properties = await db.collection('properties').find({ user_id: req.user.id }).sort({ created_at: -1 }).toArray();

    const allItems = [
      ...(products || []).map(item => {
        let status = 'pending';
        const now = new Date();
        const expiryDate = new Date(item.expiry_date);
        const gracePeriodEnd = new Date(expiryDate);
        gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 2); // 2-day grace period

        if (item.rejection_reason) {
          status = 'rejected';
        } else if (!item.active) {
          status = 'expired';
        } else if (expiryDate < now && gracePeriodEnd >= now) {
          status = 'expiring_soon';
        } else if (expiryDate < now) {
          status = 'expired';
        } else {
          status = 'active';
        }

        return {
          ...item,
          table: 'products',
          status,
          is_paid: item.is_paid || false,
          payment_amount: item.payment_amount || 0,
          expiry_date: item.expiry_date,
          days_remaining: Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)))
        };
      }),
      ...(properties || []).map(item => {
        let status = 'pending';
        const now = new Date();
        const expiryDate = new Date(item.expiry_date);
        const gracePeriodEnd = new Date(expiryDate);
        gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 2); // 2-day grace period

        if (item.rejection_reason) {
          status = 'rejected';
        } else if (!item.active) {
          status = 'expired';
        } else if (expiryDate < now && gracePeriodEnd >= now) {
          status = 'expiring_soon';
        } else if (expiryDate < now) {
          status = 'expired';
        } else {
          status = 'active';
        }

        return {
          ...item,
          table: 'properties',
          status,
          is_paid: item.is_paid || false,
          payment_amount: item.payment_amount || 0,
          expiry_date: item.expiry_date,
          days_remaining: Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)))
        };
      })
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.json({ success: true, items: allItems });
  } catch (error) {
    console.error('Seller items endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== ENHANCED ADMIN APPROVAL WITH NOTIFICATIONS =====

// Categories API - Using MongoDB
app.get('/api/categories', async (req, res) => {
  try {
    const dns = require('dns');
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    const db = mongoClient.db('bconnect');
    const categories = await db.collection('categories').find({}).toArray();
    
    // If no categories in DB, return the standard 3 categories
    if (!categories || categories.length === 0) {
      const defaultCategories = [
        { _id: 'product', name: 'product', icon: 'shopping-bag', description: 'Products for sale' },
        { _id: 'service', name: 'service', icon: 'wrench', description: 'Services offered' },
        { _id: 'housing', name: 'Housing/Rentals', icon: 'home', description: 'Housing and rentals' }
      ];
      return res.json({ success: true, categories: defaultCategories });
    }
    
    return res.json({ success: true, categories: categories || [] });
  } catch (error) {
    console.error('Categories endpoint error:', error);
    // Return default categories on error
    const defaultCategories = [
      { _id: 'product', name: 'product', icon: 'shopping-bag', description: 'Products for sale' },
      { _id: 'service', name: 'service', icon: 'wrench', description: 'Services offered' },
      { _id: 'housing', name: 'Housing/Rentals', icon: 'home', description: 'Housing and rentals' }
    ];
    return res.json({ success: true, categories: defaultCategories });
  }
});

// Create category - Using MongoDB
app.post('/api/categories', requireAuth, async (req, res) => {
  try {
    const dns = require('dns');
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    const { name, description, icon, parent_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    const db = mongoClient.db('bconnect');
    const result = await db.collection('categories').insertOne({
      name,
      description,
      icon,
      parent_id,
      active: true,
      created_at: new Date()
    });

    return res.json({ success: true, category: { id: result.insertedId, name, description, icon } });
  } catch (error) {
    console.error('Category creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Reviews API
app.get('/api/reviews/:listingId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, reviews: [] });
    const { listingId } = req.params;
    const reviews = await db.collection('reviews').find({ listing_id: listingId }).sort({ created_at: -1 }).toArray();
    return res.json({ success: true, reviews });
  } catch (error) {
    console.error('Reviews endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reviews', requireAuth, async (req, res) => {
  try {
    const { listing_id, rating, comment } = req.body;
    if (!listing_id || !rating) return res.status(400).json({ error: 'Listing ID and rating are required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const doc = { listing_id, reviewer_id: req.user.id, rating, comment, created_at: new Date() };
    const result = await db.collection('reviews').insertOne(doc);
    return res.json({ success: true, review: { ...doc, _id: result.insertedId } });
  } catch (error) {
    console.error('Review creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Messages API
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, messages: [] });
    const uid = req.user.id;
    const messages = await db.collection('messages')
      .find({ $or: [{ sender_id: uid }, { receiver_id: uid }] })
      .sort({ created_at: -1 }).toArray();
    return res.json({ success: true, messages });
  } catch (error) {
    console.error('Messages endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/messages', requireAuth, async (req, res) => {
  try {
    const { receiver_id, listing_id, subject, content } = req.body;
    if (!receiver_id || !content) return res.status(400).json({ error: 'Receiver ID and content are required' });
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const doc = { sender_id: req.user.id, receiver_id, listing_id, subject, content, created_at: new Date() };
    const result = await db.collection('messages').insertOne(doc);
    const msgData = { ...doc, _id: result.insertedId };
    try {
      const sender = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) }).catch(() => null);
      const senderName = sender?.name || 'Someone';
      await db.collection('notifications').insertOne({
        user_id: receiver_id, type: 'message', title: 'New Message',
        message: `${senderName} sent you a message${subject ? ` about "${subject}"` : ''}`,
        data: { message_id: result.insertedId.toString(), sender_id: req.user.id, listing_id },
        created_at: new Date()
      });
    } catch (notifError) { console.error('Message notification error:', notifError); }
    return res.json({ success: true, message: msgData });
  } catch (error) {
    console.error('Message creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Favorites API
app.get('/api/favorites', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, favorites: [] });
    const favorites = await db.collection('favorites').find({ user_id: req.user.id }).sort({ created_at: -1 }).toArray();
    return res.json({ success: true, favorites });
  } catch (error) {
    console.error('Favorites endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/favorites', requireAuth, async (req, res) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'Listing ID is required' });
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const existing = await db.collection('favorites').findOne({ user_id: req.user.id, listing_id });
    if (existing) return res.status(400).json({ error: 'Item already in favorites' });
    const doc = { user_id: req.user.id, listing_id, created_at: new Date() };
    const result = await db.collection('favorites').insertOne(doc);
    return res.json({ success: true, favorite: { ...doc, _id: result.insertedId } });
  } catch (error) {
    console.error('Favorite creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/favorites/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    await db.collection('favorites').deleteOne({ user_id: req.user.id, listing_id: listingId });
    return res.json({ success: true, message: 'Removed from favorites' });
  } catch (error) {
    console.error('Favorite deletion endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Notifications API (MongoDB-backed)
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const notifications = await db.collection('notifications')
      .find({ user_id: userId })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    const unreadCount = await db.collection('notifications').countDocuments({
      user_id: userId,
      is_read: { $ne: true }
    });

    return res.json({
      success: true,
      notifications: notifications.map(n => ({
        ...n,
        id: n._id.toString(),
        is_read: n.is_read || false
      })),
      unread_count: unreadCount
    });
  } catch (error) {
    console.error('Notifications endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
  try {
    await db.collection('notifications').updateMany(
      { user_id: req.user._id, is_read: { $ne: true } },
      { $set: { is_read: true, read_at: new Date() } }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Mark-all-read error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    let notifId;
    try { notifId = new ObjectId(id); } catch(e) { return res.status(400).json({ error: 'Invalid notification id' }); }

    await db.collection('notifications').updateOne(
      { _id: notifId, user_id: req.user._id },
      { $set: { is_read: true, read_at: new Date() } }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Notification update endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/notifications/test', requireAuth, async (req, res) => {
  try {
    const types = [
      { type: 'order', title: 'Payment Successful', message: 'Your payment of KES 1,500 for "Nike Air Max" was successful.' },
      { type: 'sale', title: 'New Sale!', message: 'You made a sale of KES 2,200 for "Handmade Bag". Earnings updated.' },
      { type: 'housing', title: 'Rent Reminder', message: 'Your rent of KES 15,000 is due in 3 days. Pay early to avoid late fees.' },
      { type: 'message', title: 'New Message', message: 'You have a new message from a potential buyer.' }
    ];
    const pick = types[Math.floor(Math.random() * types.length)];
    const notif = {
      user_id: req.user._id,
      type: pick.type,
      title: pick.title,
      message: pick.message,
      is_read: false,
      data: {},
      created_at: new Date()
    };
    const result = await db.collection('notifications').insertOne(notif);
    return res.json({ success: true, notification: { ...notif, id: result.insertedId.toString() } });
  } catch (error) {
    console.error('Test notification error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Images API
app.get('/api/images/:listingId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, images: [] });
    const { listingId } = req.params;
    const images = await db.collection('images').find({ listing_id: listingId }).sort({ sort_order: 1 }).toArray();
    return res.json({ success: true, images });
  } catch (error) {
    console.error('Images endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/images', requireAuth, async (req, res) => {
  try {
    const { listing_id, filename, url, alt_text, is_primary, sort_order } = req.body;
    if (!listing_id || !filename || !url) return res.status(400).json({ error: 'Listing ID, filename, and URL are required' });
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const doc = { listing_id, filename, url, alt_text, is_primary: is_primary || false, sort_order: sort_order || 0, created_at: new Date() };
    const result = await db.collection('images').insertOne(doc);
    return res.json({ success: true, image: { ...doc, _id: result.insertedId } });
  } catch (error) {
    console.error('Image creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Transactions API
app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, transactions: [] });
    const transactions = await db.collection('transactions').find({ user_id: req.user.id }).sort({ created_at: -1 }).limit(100).toArray();
    return res.json({ success: true, transactions });
  } catch (error) {
    console.error('Transactions endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  try {
    const { order_id, amount, type, status, payment_method, transaction_ref, metadata } = req.body;
    if (!order_id || !amount || !type || !status) return res.status(400).json({ error: 'Order ID, amount, type, and status are required' });
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const doc = { order_id, user_id: req.user.id, amount, type, status, payment_method, transaction_ref, metadata, created_at: new Date() };
    const result = await db.collection('transactions').insertOne(doc);
    return res.json({ success: true, transaction: { ...doc, _id: result.insertedId } });
  } catch (error) {
    console.error('Transaction creation endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== RENT PAYMENT SYSTEM ENDPOINTS =====

// TENANT ENDPOINTS: Get tenant's rent schedule (upcoming and past payments)
app.get('/api/tenant/rent-schedule', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, schedules: [] });
    const tenantId = req.user.id;
    const schedules = await db.collection('rent_schedule').find({ tenant_id: tenantId }).sort({ due_date: -1 }).toArray();
    return res.json({ success: true, schedules });
  } catch (error) {
    console.error('Rent schedule endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// TENANT ENDPOINTS: Get tenant's payment history
app.get('/api/tenant/payment-history', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, payments: [] });
    const tenantId = req.user.id;
    const payments = await db.collection('payment_receipts').find({ tenant_id: tenantId }).sort({ created_at: -1 }).toArray();
    return res.json({ success: true, payments });
  } catch (error) {
    console.error('Payment history endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// TENANT ENDPOINTS: Get tenant's rental agreement details
app.get('/api/tenant/rental-agreement', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(404).json({ error: 'No active rental agreement found' });
    const tenantId = req.user.id;
    const agreement = await db.collection('rental_agreements').findOne({ tenant_id: tenantId, status: 'active' });
    if (!agreement) return res.status(404).json({ error: 'No active rental agreement found' });
    return res.json({ success: true, agreement });
  } catch (error) {
    console.error('Rental agreement endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// (removed duplicate Supabase-based POST /api/tenant/pay-rent — MongoDB version is below at line ~5070)

// ===== LANDLORD ENDPOINTS FOR RENT MANAGEMENT =====

// (removed duplicate Supabase-based GET /api/landlord/properties — MongoDB version below at line ~4736)

// LANDLORD ENDPOINTS: Get tenant payment status
app.get('/api/landlord/tenant-payments/:tenantId', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const landlordId = req.user.id;
    const { tenantId } = req.params;

    const agreement = await db.collection('rental_agreements').findOne({ landlord_id: landlordId, tenant_id: tenantId });
    if (!agreement) return res.status(403).json({ error: 'Unauthorized access' });

    const payments = await db.collection('rent_schedule')
      .find({ tenant_id: tenantId, landlord_id: landlordId })
      .sort({ due_date: -1 }).toArray();

    // Calculate overview stats
    const stats = {
      totalDue: 0,
      totalPaid: 0,
      totalOverdue: 0,
      paidCount: 0,
      pendingCount: 0,
      overdueCount: 0
    };

    (payments || []).forEach(payment => {
      stats.totalDue += payment.amount;
      if (payment.status === 'paid') {
        stats.totalPaid += payment.amount;
        stats.paidCount++;
      } else if (payment.status === 'pending') {
        stats.pendingCount++;
      } else if (payment.status === 'overdue') {
        stats.totalOverdue += payment.amount;
        stats.overdueCount++;
      }
    });

    return res.json({
      success: true,
      payments: payments || [],
      stats
    });
  } catch (error) {
    console.error('Tenant payments endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// LANDLORD ENDPOINTS: Get all tenant payments summary
app.get('/api/landlord/payment-summary', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const landlordId = req.user.id;
    const schedules = await db.collection('rent_schedule').find({ landlord_id: landlordId }).sort({ due_date: -1 }).toArray();

    // Calculate statistics
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stats = {
      totalExpected: 0,
      totalReceived: 0,
      totalOverdue: 0,
      paidToday: 0,
      paidThisMonth: 0,
      paymentsByStatus: { paid: 0, pending: 0, overdue: 0, partial: 0 },
      tenantCount: new Set()
    };

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    (schedules || []).forEach(payment => {
      stats.totalExpected += payment.amount;
      stats.tenantCount.add(payment.tenant_id);
      stats.paymentsByStatus[payment.status]++;

      if (payment.status === 'paid') {
        stats.totalReceived += payment.amount;
        if (payment.paid_date) {
          const paidDate = new Date(payment.paid_date);
          if (paidDate >= today) stats.paidToday++;
          if (paidDate >= monthStart) stats.paidThisMonth++;
        }
      } else if (payment.status === 'overdue') {
        stats.totalOverdue += payment.amount;
      }
    });

    stats.tenantCount = stats.tenantCount.size;

    return res.json({
      success: true,
      summary: schedules || [],
      stats
    });
  } catch (error) {
    console.error('Payment summary endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// LANDLORD ENDPOINTS: Mark payment as received (manual entry)
app.put('/api/landlord/payment/:scheduleId/mark-paid', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const landlordId = req.user.id;
    const { scheduleId } = req.params;
    const { paymentMethod = 'manual', mpesaCode = null } = req.body;

    let schedFilter;
    try { schedFilter = { _id: new ObjectId(scheduleId), landlord_id: landlordId }; } catch { schedFilter = { id: scheduleId, landlord_id: landlordId }; }
    const schedule = await db.collection('rent_schedule').findOne(schedFilter);
    if (!schedule) return res.status(403).json({ error: 'Unauthorized access to this payment' });

    const updated = await db.collection('rent_schedule').findOneAndUpdate(
      schedFilter,
      { $set: { status: 'paid', paid_date: new Date().toISOString(), updated_at: new Date().toISOString() } },
      { returnDocument: 'after' }
    );

    if (paymentMethod && paymentMethod !== 'manual') {
      await db.collection('payment_receipts').insertOne({
        rent_schedule_id: scheduleId, transaction_id: `MAN${Date.now()}`,
        amount: schedule.amount, payment_method: paymentMethod,
        mpesa_code: mpesaCode, status: 'completed', created_at: new Date()
      });
    }

    return res.json({ success: true, message: 'Payment marked as received', payment: updated });
  } catch (error) {
    console.error('Mark paid endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ===== UTILITY FUNCTIONS FOR AUTOMATIC DATA =====

// Auto-create category if it doesn't exist
async function ensureCategoryExists(categoryName, description = '', icon = '') {
  try {
    if (!db) {
      return;
    }

    // Check if category exists
    const existing = await db.collection('categories').findOne({ name: categoryName });

    if (!existing) {
      // Create new category
      await db.collection('categories').insertOne({
        name: categoryName,
        description: description || `${categoryName} products and services`,
        icon: icon || 'package',
        created_at: new Date()
      });
      console.log(`Auto-created category: ${categoryName}`);
    }
  } catch (error) {
    console.error('Category auto-creation error:', error);
  }
}

// Initialize default categories on server start
async function initializeDefaultCategories() {
  // Ensure email registry file exists
  const fs = require('fs');
  const path = require('path');
  
  const emailRegistryPath = path.join(__dirname, 'email-registry.json');
  if (!fs.existsSync(emailRegistryPath)) {
    fs.writeFileSync(emailRegistryPath, JSON.stringify({ emails: [] }, null, 2));
    console.log('Email registry file created');
  }

  const defaultCategories = [
    { name: 'Products', description: 'Physical goods and items', icon: 'package' },
    { name: 'Services', description: 'Professional and manual services', icon: 'wrench' },
    { name: 'Housing/Rentals', description: 'Apartments, houses, rooms for rent', icon: 'home' },
    { name: 'Landlord', description: 'Property management and listings', icon: 'building' },
    { name: 'Tenants', description: 'Tenant listings and requests', icon: 'key' },
    { name: 'Orders', description: 'Order management and tracking', icon: 'clipboard-list' },
    { name: 'Payments', description: 'Payment transactions and records', icon: 'credit-card' },
    { name: 'Sellers', description: 'Seller profiles and listings', icon: 'store' },
    { name: 'Buyers', description: 'Buyer profiles and requests', icon: 'shopping-cart' },
    { name: 'Others', description: 'Miscellaneous items and services', icon: 'pin' }
  ];

  for (const category of defaultCategories) {
    await ensureCategoryExists(category.name, category.description, category.icon);
  }
}

// ===== ORDERS ENDPOINTS =====

// Get user orders
app.get('/api/orders', async (req, res) => {
  try {
    // If not authenticated, return empty orders list
    if (!req.user) {
      return res.json({ success: true, orders: [] });
    }

    const userId = req.user.id;

    if (!db) return res.json({ success: true, orders: [] });
    const orders = await db.collection('orders').find({ buyer_id: userId }).sort({ created_at: -1 }).toArray();

    // Transform the data to match the frontend format
    const transformedOrders = orders.map(order => {
      const firstItem = order.order_items?.[0];
      const productTitle = firstItem?.products?.title || 'Unknown Product';
      const totalItems = order.order_items?.reduce((sum, item) => sum + item.quantity, 0) || 1;

      return {
        id: order.order_id,
        title: totalItems > 1 ? `${productTitle} + more` : productTitle,
        status: order.status,
        date: new Date(order.created_at).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        }),
        amount: `KSh ${order.total_amount || 0}`,
        // Add fields expected by admin.html dashboard
        _id: order.id,
        customer: order.buyer_id,
        total: order.total_amount,
        actions: getOrderActions(order.status)
      };
    });

    return res.json({
      success: true,
      orders: transformedOrders
    });
  } catch (error) {
    console.error('Get orders endpoint error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to determine order actions based on status
function getOrderActions(status) {
  switch (status) {
    case 'pending':
      return ['View Details', 'Cancel Order'];
    case 'confirmed':
      return ['View Details', 'Track Order'];
    case 'shipped':
      return ['View Details', 'Track Order'];
    case 'delivered':
      return ['View Details', 'Buy Again', 'Leave Review'];
    case 'cancelled':
      return ['View Details', 'Reorder'];
    default:
      return ['View Details'];
  }
}

// GET /api/my-payments — aggregated payment history for logged-in user (all categories)
app.get('/api/my-payments', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const userId  = String(req.user._id);
    const userEmail = (req.user.email || '').toLowerCase();
    const userPhone = req.user.phone || req.user.phone_number || '';
    const payments = [];

    // Helper: safe ObjectId
    const toOid = id => { try { return new ObjectId(id); } catch(_) { return null; } };

    // ── 1. Marketplace orders (products / services / cart) ──────────────────
    const phoneQuery = userPhone ? [{ phone: userPhone }, { phone: userPhone.replace(/^254/, '0') }, { phone: '254' + userPhone.replace(/^0/, '') }] : [];
    const orderDocs = await db.collection('orders').find({
      $or: [{ buyer_id: userId }, ...phoneQuery]
    }).sort({ created_at: -1 }).limit(200).toArray();

    for (const o of orderDocs) {
      const ptype = (o.payment_type || '').toLowerCase();
      // Skip internal seller payments here — they go into promotion/listing buckets
      if (ptype === 'promotion' || ptype === 'slider') {
        let sellerName = req.user.full_name || req.user.name || 'You';
        const propId = o.product_id || (o.product_ids && o.product_ids[0]);
        let itemTitle = o.item || 'Slider Promotion';
        if (propId) { const prop = await db.collection('properties').findOne({ _id: toOid(propId) }); if (prop) itemTitle = prop.title || itemTitle; }
        const expiresAt = o.promotedUntil || null;
        payments.push({ category:'promotion', id: o.order_id || String(o._id), title: itemTitle, sellerName, amount: o.amount, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status||'pending'), date: o.created_at, expiresAt });
        continue;
      }
      if (ptype === 'listing') {
        payments.push({ category:'premium_listing', id: o.order_id || String(o._id), title: o.item || 'Listing Fee', sellerName: req.user.full_name || req.user.name || 'You', amount: o.amount, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status||'pending'), date: o.created_at, activatedAt: o.created_at });
        continue;
      }
      // Regular product/service/cart order
      let sellerName = null;
      if (o.seller_id) {
        const sp = toOid(o.seller_id);
        const seller = sp ? await db.collection('profiles').findOne({ _id: sp }) : null;
        sellerName = seller ? (seller.full_name || seller.name || seller.email) : null;
      }
      const cat = (o.category || o.listing_type || 'product').toLowerCase().includes('service') ? 'service' : 'product';
      payments.push({ category: cat, id: o.order_id || String(o._id), title: o.item || 'Product Purchase', sellerName, amount: o.amount, status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'), date: o.created_at });
    }

    // ── 2. Rent payments ────────────────────────────────────────────────────
    const rentDocs = await db.collection('rent_payments').find({
      $or: [{ tenantId: req.user._id }, { tenantId: userId }]
    }).sort({ paidAt: -1 }).limit(100).toArray();

    for (const rp of rentDocs) {
      let propertyName = rp.propertyName || rp.property_name || null;
      let landlordName = rp.landlordName || null;
      let landlordEmail = rp.landlordEmail || null;
      let location = rp.location || null;

      // Enrich from tenant_properties / landlord_properties if fields missing
      if (!propertyName || !landlordName) {
        const tp = await db.collection('tenant_properties').findOne({
          tenantId: req.user._id,
          $or: [{ propertyId: rp.propertyId }, { _id: rp.linkedPropertyId }]
        });
        if (tp) {
          propertyName = propertyName || tp.propertyName || tp.propertyCode;
          if (!landlordName && tp.landlordId) {
            const ll = await db.collection('profiles').findOne({ _id: toOid(String(tp.landlordId)) });
            if (ll) { landlordName = ll.full_name || ll.name; landlordEmail = ll.email; }
          }
          if (!location) location = tp.location || tp.address;
        }
        if (!propertyName && rp.propertyId) {
          const lp = await db.collection('landlord_properties').findOne({ _id: rp.propertyId }).catch(() => null);
          if (lp) { propertyName = lp.name || lp.address; location = location || lp.location || lp.area; }
        }
      }
      payments.push({ category:'rent', id: rp.reference || String(rp._id), title: propertyName || 'Rent Payment', landlordName, landlordEmail, location, paymentType: rp.paymentType || 'full', amount: rp.amount, status: rp.status || 'completed', date: rp.paidAt || rp.createdAt });
    }

    // ── 3. Event tickets ────────────────────────────────────────────────────
    const emailQ = userEmail ? { buyer_email: { $regex: new RegExp('^' + userEmail.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '$', 'i') } } : null;
    const ticketQuery = { $or: [...(emailQ ? [emailQ] : []), ...(userPhone ? [{ buyer_phone: userPhone }] : [])] };
    const ticketDocs = Object.keys(ticketQuery.$or).length || ticketQuery.$or.length
      ? await db.collection('tickets').find(ticketQuery).sort({ created_at: -1 }).limit(100).toArray()
      : [];

    for (const t of ticketDocs) {
      let organizer = null; let venue = null; let eventDate = null;
      if (t.event_id) {
        const evt = await db.collection('events').findOne({ _id: t.event_id });
        if (evt) { organizer = evt.organizer; venue = evt.venue || evt.location; eventDate = evt.event_date; }
      }
      payments.push({ category:'ticket', id: t.ticket_code || String(t._id), title: t.event_title || 'Event Ticket', organizer, venue, eventDate, quantity: t.quantity || 1, ticketCode: t.ticket_code, amount: t.total_amount, status: t.status || 'confirmed', date: t.created_at });
    }

    // ── 4. Property viewings ─────────────────────────────────────────────────
    const viewingQuery = { $or: [...(userEmail ? [{ tenant_email: { $regex: new RegExp('^' + userEmail.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '$', 'i') } }] : []), ...(userPhone ? [{ tenant_phone: userPhone }] : [])] };
    const viewingDocs = viewingQuery.$or.length
      ? await db.collection('viewings').find(viewingQuery).sort({ created_at: -1 }).limit(100).toArray()
      : [];
    for (const v of viewingDocs) {
      payments.push({ category:'viewing', id: String(v._id), title: v.property_name || 'Property Viewing', location: v.location, viewingDate: v.date, viewingTime: v.time, amount: 0, status: v.status || 'pending', date: v.created_at });
    }

    // ── 5. Slider promotions (seller-side) ────────────────────────────────────
    const sliderDocs = await db.collection('sliders').find({ seller_id: userId }).sort({ created_at: -1 }).limit(50).toArray();
    const promoIds = new Set(payments.filter(p => p.category === 'promotion').map(p => p.id));
    for (const s of sliderDocs) {
      if (promoIds.has(String(s._id))) continue; // already added via orders
      const now = new Date();
      const expiresAt = s.promotedUntil || s.expiresAt || null;
      payments.push({ category:'promotion', id: String(s._id), title: s.title || 'Slider Promotion', sellerName: req.user.full_name || req.user.name || 'You', amount: s.payment_amount || 0, expiresAt, status: expiresAt && new Date(expiresAt) > now ? 'active' : 'expired', date: s.created_at || s.createdAt });
    }

    // ── 6. Premium listing subscriptions (seller-side) ────────────────────────
    const subDocs = await db.collection('seller_subscriptions').find({ sellerId: req.user._id }).sort({ updatedAt: -1 }).limit(10).toArray();
    for (const sub of subDocs) {
      const now = new Date();
      const isActive = sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > now;
      const daysLeft = isActive ? Math.ceil((new Date(sub.expiresAt) - now) / 86400000) : 0;
      payments.push({ category:'premium_listing', id: String(sub._id), title: 'Unlimited Listings Plan', sellerName: req.user.full_name || req.user.name || 'You', amount: 500, expiresAt: sub.expiresAt, activatedAt: sub.updatedAt || sub.createdAt, daysLeft, status: isActive ? 'active' : 'expired', date: sub.updatedAt || sub.createdAt });
    }

    // Sort by date descending, deduplicate by id
    const seen = new Set();
    const unique = payments.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    unique.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    return res.json({ success: true, payments: unique });
  } catch (err) {
    console.error('My payments error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  const mongoStatus = db ? 'connected' : 'disconnected';
  
  // Try to ping MongoDB if connected
  let pingResult = null;
  if (db) {
    try {
      await db.command({ ping: 1 });
      pingResult = 'ok';
    } catch (e) {
      pingResult = 'failed';
    }
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mongodb: {
      status: mongoStatus,
      ping: pingResult,
      database: db ? db.databaseName : 'none'
    }
  });
});

// ============ TENANT PORTAL ROUTES ============

// Serve tenant portal
app.get('/tenant-portal', (req, res) => {
  res.sendFile(__dirname + '/tenant-portal.html');
});

// Serve admin dashboard
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// Serve admin.html directly
app.get('/admin.html', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

// Serve settings page
app.get('/settings', (req, res) => {
  res.sendFile(__dirname + '/settings.html');
});

// Change password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = await db.collection('profiles').findOne({ _id: req.user._id });
    if (!user || !user.password) {
      return res.status(400).json({ error: 'Password change not available for this account' });
    }
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hashed = await bcrypt.hash(newPassword, 12);
    await db.collection('profiles').updateOne(
      { _id: req.user._id },
      { $set: { password: hashed, updated_at: new Date() } }
    );
    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

// 2FA: generate setup code
app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
  try {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await db.collection('profiles').updateOne(
      { _id: req.user._id },
      { $set: { twofa_pending_code: code, twofa_pending_expires: expires } }
    );
    return res.json({ success: true, code });
  } catch (error) {
    console.error('2FA setup error:', error);
    return res.status(500).json({ error: 'Failed to generate 2FA code' });
  }
});

// 2FA: verify code and enable/disable
app.post('/api/auth/2fa/verify', requireAuth, async (req, res) => {
  try {
    const { code, action } = req.body;
    if (!code || !action) return res.status(400).json({ error: 'Code and action are required' });
    const user = await db.collection('profiles').findOne({ _id: req.user._id });
    if (!user.twofa_pending_code) return res.status(400).json({ error: 'No pending code. Please request a new code.' });
    if (new Date() > new Date(user.twofa_pending_expires)) return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    if (user.twofa_pending_code !== String(code)) return res.status(400).json({ error: 'Invalid code. Please try again.' });
    const enabling = action === 'enable';
    await db.collection('profiles').updateOne(
      { _id: req.user._id },
      { $set: { twofa_enabled: enabling, updated_at: new Date() }, $unset: { twofa_pending_code: '', twofa_pending_expires: '' } }
    );
    return res.json({ success: true, twofa_enabled: enabling });
  } catch (error) {
    console.error('2FA verify error:', error);
    return res.status(500).json({ error: 'Failed to verify 2FA code' });
  }
});

// Save notification preferences
app.put('/api/settings/notifications', requireAuth, async (req, res) => {
  try {
    const { notification_prefs } = req.body;
    if (!notification_prefs || typeof notification_prefs !== 'object') {
      return res.status(400).json({ error: 'notification_prefs object is required' });
    }
    await db.collection('profiles').updateOne(
      { _id: req.user._id },
      { $set: { notification_prefs, updated_at: new Date() } }
    );
    return res.json({ success: true });
  } catch (error) {
    console.error('Notification prefs error:', error);
    return res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// Get tenant dashboard data
app.get('/api/tenant/dashboard', requireTenantAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const toObjId = id => { try { return id instanceof ObjectId ? id : new ObjectId(String(id)); } catch(_) { return null; } };
    const tenantObjId = toObjId(userId);
    const profileObjId = req.user.profileId ? toObjId(req.user.profileId) : null;
    const allTenantIds = [tenantObjId, profileObjId].filter(Boolean);
    const tenant = req.user;

    // Get the tenant's active linked property — try all possible IDs to handle unified-login ID mismatch
    const activeLink = await db.collection('tenant_properties').findOne({
      tenantId: { $in: allTenantIds }, status: 'active'
    });

    const monthlyRent = activeLink?.monthlyRent || tenant.rentAmount || 0;
    const propertyId = activeLink?.propertyId || null;

    // Get payments from new rent_payments collection (property-scoped) + legacy — use all IDs
    const legacyTenantIds = [...new Set([String(userId), req.userId].filter(Boolean))];
    const [rentPayments, legacyPayments] = await Promise.all([
      propertyId
        ? db.collection('rent_payments').find({ tenantId: { $in: allTenantIds }, propertyId }).sort({ paidAt: -1 }).limit(20).toArray()
        : Promise.resolve([]),
      db.collection('payments').find({ tenantId: { $in: legacyTenantIds } }).sort({ createdAt: -1 }).limit(10).toArray()
    ]);

    const allPayments = [...rentPayments, ...legacyPayments]
      .sort((a, b) => new Date(b.paidAt || b.createdAt) - new Date(a.paidAt || a.createdAt));

    // Get maintenance requests — use new collection if property linked, else legacy
    let maintenanceRequests = [];
    if (propertyId) {
      maintenanceRequests = await db.collection('maintenance_requests')
        .find({ tenantId: tenantObjId, propertyId })
        .sort({ createdAt: -1 }).limit(10).toArray();
    } else {
      maintenanceRequests = await db.collection('maintenance')
        .find({ unitId: tenant.unitId || tenant.unit })
        .sort({ createdAt: -1 }).limit(5).toArray();
    }

    // Calculate real stats
    const now = new Date();
    const currentYear = now.getFullYear();
    const yearStart = new Date(currentYear, 0, 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Days until rent is due (1st of next month)
    const nextDue = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const daysUntilDue = Math.max(0, Math.ceil((nextDue - now) / (1000 * 60 * 60 * 24)));

    const totalPaidThisYear = allPayments
      .filter(p => new Date(p.paidAt || p.createdAt) >= yearStart)
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const paidThisMonth = allPayments
      .filter(p => new Date(p.paidAt || p.createdAt) >= monthStart)
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    // Payment score: % of months that had a payment (capped at 100)
    const paymentScore = allPayments.length > 0
      ? Math.min(100, Math.round(80 + (allPayments.length / Math.max(1, allPayments.length + 2)) * 20))
      : 0;

    const activeRequests = maintenanceRequests.filter(r => r.status !== 'completed' && r.status !== 'closed').length;

    res.json({
      tenant: {
        name: tenant.name || tenant.fullName,
        email: tenant.email,
        phone: tenant.phone,
        unit: tenant.unit || tenant.unitId,
        leaseStart: tenant.leaseStart,
        leaseEnd: tenant.leaseEnd
      },
      stats: {
        totalPaidThisYear,
        paymentScore,
        activeRequests,
        overdueRequests: maintenanceRequests.filter(r => r.status === 'overdue').length,
        daysUntilDue,
        rentDue: monthlyRent,
        monthlyRent,
        baseRent: paidThisMonth,
        balanceDue: Math.max(0, monthlyRent - paidThisMonth),
        serviceFee: 0,
        paymentStatus: paidThisMonth >= monthlyRent && monthlyRent > 0 ? 'Paid' : 'Pending'
      },
      recentPayments: allPayments.slice(0, 5),
      maintenanceRequests
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get payment history
app.get('/api/tenant/payments', requireTenantAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const toObjId = (id) => { try { return id instanceof ObjectId ? id : new ObjectId(id); } catch(_) { return id; } };
    const tenantObjId = toObjId(userId);

    // Collect all IDs this tenant may appear under (own _id + profileId)
    const allIds = [tenantObjId];
    if (req.user.profileId) allIds.push(toObjId(req.user.profileId));

    // Fetch from both legacy payments and new rent_payments collections
    const [legacyPayments, rentPayments] = await Promise.all([
      db.collection('payments').find({ tenantId: { $in: allIds } }).sort({ createdAt: -1 }).limit(50).toArray(),
      db.collection('rent_payments').find({ tenantId: { $in: allIds } }).sort({ paidAt: -1 }).limit(50).toArray()
    ]);

    // Normalize rent_payments to match legacy payment shape
    const normalizedRent = rentPayments.map(p => ({
      ...p,
      method: p.paymentMethod || 'mpesa',
      status: p.status || 'completed',
      createdAt: p.paidAt || p.createdAt
    }));

    const all = [...legacyPayments, ...normalizedRent]
      .sort((a, b) => new Date(b.createdAt || b.paidAt) - new Date(a.createdAt || a.paidAt));

    res.json({ success: true, payments: all });
  } catch (error) {
    console.error('Payments error:', error);
    res.json({ success: true, payments: [] });
  }
});

// Get maintenance requests
app.get('/api/tenant/maintenance', requireTenantAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const tenant = req.user;
    
    const requests = await db.collection('maintenance')
      .find({ unitId: tenant.unitId || tenant.unit })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ requests });
  } catch (error) {
    console.error('Maintenance requests error:', error);
    res.status(500).json({ error: 'Failed to fetch maintenance requests' });
  }
});

// Submit maintenance request
app.post('/api/tenant/maintenance', requireTenantAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const { category, priority, description } = req.body;

    if (!category || !priority || !description) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const tenant = req.user;

    const maintenanceRequest = {
      unitId: tenant.unitId || tenant.unit,
      tenantId: userId,
      tenantName: tenant.name || tenant.fullName,
      category,
      priority,
      description,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('maintenance').insertOne(maintenanceRequest);
    
    res.json({ 
      success: true, 
      requestId: result.insertedId,
      message: 'Maintenance request submitted successfully'
    });
  } catch (error) {
    console.error('Submit maintenance error:', error);
    res.status(500).json({ error: 'Failed to submit maintenance request' });
  }
});

// Get tenant profile
app.get('/api/tenant/profile', requireTenantAuth, async (req, res) => {
  try {
    const tenant = req.user;
    res.json({
      name: tenant.name || tenant.fullName,
      email: tenant.email,
      phone: tenant.phone,
      unit: tenant.unit || tenant.unitId,
      leaseStart: tenant.leaseStart,
      leaseEnd: tenant.leaseEnd,
      identificationNumber: tenant.idNumber || 'Not provided'
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Submit payment
app.post('/api/tenant/payment', requireTenantAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.userId;
    const { amount, method, phoneNumber } = req.body;

    if (!amount || !method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const tenant = req.user;

    const payment = {
      tenantId: userId,
      tenantName: tenant.name || tenant.fullName,
      unit: tenant.unit || tenant.unitId,
      amount,
      method,
      phoneNumber,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('payments').insertOne(payment);

    // Send payment receipt email with PDF attachment
    if (tenant.email) {
      try {
        const receiptData = {
          orderId: result.insertedId.toString(),
          item: tenant.unit ? `Unit ${tenant.unit}` : 'Rent Payment',
          amount,
          phone: phoneNumber || tenant.phone,
          paymentType: 'rent',
          date: new Date()
        };
        const recipientName = tenant.full_name || tenant.name || tenant.email;
        const { text, html } = paymentReceiptEmail(recipientName, receiptData);
        sendEmail(tenant.email, 'Payment Confirmed — BConnect Receipt', text, html);
      } catch (emailErr) {
        console.error('Receipt email error:', emailErr.message);
      }
    }

    res.json({ 
      success: true, 
      paymentId: result.insertedId,
      message: 'Payment submitted successfully'
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

// ============ LANDLORD AUTHENTICATION ENDPOINTS ============

// Helper function to generate property code
function generatePropertyCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Landlord Registration
app.post('/api/landlord/register', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { fullName, email, phone, password } = req.body;

    // Validation
    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email already exists
    const existingLandlord = await db.collection('landlords').findOne({ email: email.toLowerCase() });
    if (existingLandlord) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create landlord document
    const landlordData = {
      fullName: fullName.trim(),
      email: email.toLowerCase(),
      phone: phone.trim(),
      password: hashedPassword,
      properties: [],
      totalTenants: 0,
      totalRevenue: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('landlords').insertOne(landlordData);
    const landlordId = result.insertedId.toString();

    // Generate JWT token
    const token = generateToken(landlordId);

    return res.status(201).json({
      success: true,
      message: 'Landlord account created successfully',
      token,
      landlordId,
      landlord: {
        id: landlordId,
        fullName: landlordData.fullName,
        email: landlordData.email
      }
    });
  } catch (error) {
    console.error('Landlord registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// Landlord Login — checks unified profiles first, falls back to landlords collection
app.post('/api/landlord/login', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 1. Try unified profiles collection first
    const profile = await db.collection('profiles').findOne({ email: email.toLowerCase() });
    if (profile) {
      const isValid = await bcrypt.compare(password, profile.password);
      if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

      // Ensure a landlord record exists for this profile
      let landlord = await db.collection('landlords').findOne({ email: email.toLowerCase() });
      if (!landlord) {
        const lr = await db.collection('landlords').insertOne({
          fullName: profile.full_name,
          email: profile.email,
          phone: profile.phone || '',
          password: profile.password,
          profileId: profile._id,
          properties: [],
          totalTenants: 0,
          totalRevenue: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });
        landlord = { _id: lr.insertedId, fullName: profile.full_name, email: profile.email };
      }

      const token = generateToken(profile._id.toString());
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        landlordId: landlord._id.toString(),
        landlord: { id: landlord._id.toString(), fullName: landlord.fullName || profile.full_name, email: profile.email }
      });
    }

    // 2. Fall back to landlords collection (existing users before unification)
    const landlord = await db.collection('landlords').findOne({ email: email.toLowerCase() });
    if (!landlord) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, landlord.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(landlord._id.toString());

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      landlordId: landlord._id.toString(),
      landlord: {
        id: landlord._id.toString(),
        fullName: landlord.fullName,
        email: landlord.email
      }
    });
  } catch (error) {
    console.error('Landlord login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// Get Landlord Profile
app.get('/api/landlord/me', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const landlord = await db.collection('landlords').findOne({ _id: req.user._id });
    if (!landlord) return res.status(404).json({ error: 'Landlord not found' });
    return res.json({
      success: true,
      name: landlord.fullName,
      email: landlord.email,
      phone: landlord.phone || '',
      location: landlord.location || '',
      avatar_url: landlord.avatar_url || '',
      created_at: landlord.createdAt || landlord.created_at
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update Landlord Profile
app.put('/api/landlord/profile', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { name, phone, location, avatar_url } = req.body;
    const updates = { updatedAt: new Date() };
    if (name) updates.fullName = name.trim();
    if (phone !== undefined) updates.phone = phone.trim();
    if (location !== undefined) updates.location = location.trim();
    if (avatar_url !== undefined) updates.avatar_url = avatar_url.trim();
    await db.collection('landlords').updateOne({ _id: req.user._id }, { $set: updates });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get Landlord Properties
app.get('/api/landlord/properties', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const properties = await db.collection('landlord_properties')
      .find({ landlordId: new ObjectId(req.userId) })
      .sort({ createdAt: -1 })
      .toArray();

    return res.json({
      success: true,
      properties: properties || []
    });
  } catch (error) {
    console.error('Get properties error:', error);
    return res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// Create New Property
app.post('/api/landlord/properties', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { name, location, units, monthlyRent, bedrooms, amenities, description, listOnMarketplace, deposit, propertyType } = req.body;

    if (!name || !location || !units) {
      return res.status(400).json({ error: 'Name, location, and units are required' });
    }
    if (!monthlyRent || parseFloat(monthlyRent) <= 0) {
      return res.status(400).json({ error: 'Monthly rent is required and must be a positive number' });
    }

    // Generate unique property code
    let propertyCode;
    let isUnique = false;
    while (!isUnique) {
      propertyCode = generatePropertyCode();
      const existing = await db.collection('landlord_properties').findOne({ code: propertyCode });
      isUnique = !existing;
    }

    const propertyData = {
      landlordId: new ObjectId(req.userId),
      name: name.trim(),
      location: location.trim(),
      units: parseInt(units),
      monthlyRent: parseFloat(monthlyRent),
      code: propertyCode,
      bedrooms: bedrooms ? parseInt(bedrooms) : null,
      amenities: amenities ? amenities.trim() : null,
      description: description ? description.trim() : null,
      propertyType: propertyType ? propertyType.trim() : null,
      deposit: deposit ? parseFloat(deposit) : null,
      listOnMarketplace: listOnMarketplace === true || listOnMarketplace === 'true',
      tenants: [],
      totalTenants: 0,
      totalRevenue: 0,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('landlord_properties').insertOne(propertyData);

    // Auto-assign landlord role and ensure a landlords record exists
    try {
      const landlordProfileId = new ObjectId(req.userId);
      await db.collection('profiles').updateOne(
        { _id: landlordProfileId, role: { $ne: 'admin' } },
        { $set: { role: 'landlord', updated_at: new Date() } }
      );
      const profile = await db.collection('profiles').findOne({ _id: landlordProfileId });
      const existingLandlord = await db.collection('landlords').findOne({ profileId: landlordProfileId });
      if (!existingLandlord && profile) {
        await db.collection('landlords').insertOne({
          fullName: profile.full_name || profile.name || '',
          email: profile.email || '',
          phone: profile.phone || '',
          password: profile.password || '',
          profileId: landlordProfileId,
          properties: [],
          totalTenants: 0,
          totalRevenue: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    } catch (_) {}

    return res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property: {
        id: result.insertedId.toString(),
        ...propertyData
      }
    });
  } catch (error) {
    console.error('Create property error:', error);
    return res.status(500).json({ error: 'Failed to create property' });
  }
});

// Toggle marketplace listing for a landlord property
app.patch('/api/landlord/properties/:id/marketplace', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { id } = req.params;
    const { listOnMarketplace, name, location, rent, bedrooms, amenities, description, deposit, imageUrl, images, subcategory, roomsRemaining } = req.body;

    // If submitting for listing (listOnMarketplace:true), put into pending state for admin review
    // If delisting (listOnMarketplace:false), clear marketplace fields
    const submitting = !!listOnMarketplace;
    const updateFields = {
      listOnMarketplace: submitting ? false : false,
      marketplaceStatus: submitting ? 'pending' : null,
      updatedAt: new Date()
    };
    if (name !== undefined) updateFields.name = name;
    if (location !== undefined) updateFields.location = location;
    if (rent !== undefined) updateFields.rent = rent;
    if (bedrooms !== undefined) updateFields.bedrooms = bedrooms;
    if (amenities !== undefined) updateFields.amenities = amenities;
    if (description !== undefined) updateFields.description = description;
    if (deposit !== undefined) updateFields.deposit = deposit;
    if (imageUrl !== undefined) { updateFields.imageUrl = imageUrl; updateFields.image_url = imageUrl; }
    if (images !== undefined) updateFields.images = images;
    if (subcategory !== undefined) updateFields.subcategory = subcategory;
    if (roomsRemaining !== undefined) updateFields.roomsRemaining = roomsRemaining;

    const result = await db.collection('landlord_properties').updateOne(
      { _id: new ObjectId(id), landlordId: new ObjectId(req.userId) },
      { $set: updateFields }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Property not found' });
    return res.json({ success: true, marketplaceStatus: submitting ? 'pending' : null });
  } catch (error) {
    console.error('Marketplace toggle error:', error);
    return res.status(500).json({ error: 'Failed to update marketplace status' });
  }
});

// Get Property Details
app.get('/api/landlord/properties/:id', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const property = await db.collection('landlord_properties').findOne({
      _id: new ObjectId(req.params.id),
      landlordId: new ObjectId(req.userId)
    });

    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }

    return res.json({
      success: true,
      property
    });
  } catch (error) {
    console.error('Get property details error:', error);
    return res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// Get Property Tenants
app.get('/api/landlord/properties/:id/tenants', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const propertyId = new ObjectId(req.params.id);

    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId,
      landlordId: new ObjectId(req.userId)
    });
    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }

    const links = await db.collection('property_tenants')
      .find({ propertyId, status: 'active' })
      .sort({ linkedDate: -1 })
      .toArray();

    const tenantIds = links.map(l => l.tenantId).filter(Boolean);

    // Step 1: look up by _id in tenants collection (old dedicated tenant accounts)
    const tenantDocs = tenantIds.length
      ? await db.collection('tenants').find({ _id: { $in: tenantIds } }).toArray()
      : [];
    const tenantsById = new Map(tenantDocs.map(t => [t._id.toString(), t]));

    // Step 2: look up by profileId in tenants collection (accounts linked via unified login)
    const profileIdTenantDocs = tenantIds.length
      ? await db.collection('tenants').find({ profileId: { $in: tenantIds } }).toArray()
      : [];
    profileIdTenantDocs.forEach(t => {
      if (t.profileId) {
        const key = t.profileId.toString();
        if (!tenantsById.has(key)) tenantsById.set(key, t);
      }
    });

    // Step 3: always fetch profiles for ALL tenantIds — use as authoritative name source
    // (tenants docs can have fullName:'' if profile lacked name at link time)
    const profileDocs = tenantIds.length
      ? await db.collection('profiles').find({ _id: { $in: tenantIds } }).toArray()
      : [];
    const profilesById = new Map(profileDocs.map(p => [p._id.toString(), {
      fullName: p.name || p.full_name || p.fullName || p.email || '',
      email: p.email || null,
      phone: p.phone || null
    }]));

    const tenants = links.map(l => {
      const key = l.tenantId.toString();
      const t = tenantsById.get(key) || {};
      const p = profilesById.get(key) || {};
      // Profile is authoritative for name — fills in blanks left by empty tenants docs
      const name = p.fullName || t.fullName || t.name || t.full_name || '';
      return {
        id: l._id.toString(),
        tenantId: key,
        fullName: name,
        email: t.email || null,
        phone: t.phone || null,
        monthlyRent: l.monthlyRent || 0,
        linkedDate: l.linkedDate,
        status: l.status || 'active'
      };
    });

    return res.json({ success: true, tenants });
  } catch (error) {
    console.error('Get tenants error:', error);
    return res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// Remove Tenant from Property
app.delete('/api/landlord/properties/:id/tenants/:tenantId', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });

    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId,
      landlordId: new ObjectId(req.userId)
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    let tenantObjId;
    try { tenantObjId = new ObjectId(req.params.tenantId); } catch (_) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    // Remove from property_tenants (landlord-side link)
    await db.collection('property_tenants').deleteOne({ propertyId, tenantId: tenantObjId });

    // Remove from tenant_properties (tenant-side link)
    await db.collection('tenant_properties').deleteOne({ propertyId, tenantId: tenantObjId });

    // Update landlord_properties: pull tenantId from tenants array, decrement totalTenants
    await db.collection('landlord_properties').updateOne(
      { _id: propertyId },
      {
        $pull: { tenants: req.params.tenantId },
        $inc: { totalTenants: -1 }
      }
    );

    return res.json({ success: true, message: 'Tenant removed from property' });
  } catch (error) {
    console.error('Remove tenant error:', error);
    return res.status(500).json({ error: 'Failed to remove tenant' });
  }
});

// Get Pending Join Requests for a Property
app.get('/api/landlord/properties/:id/pending-requests', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId, landlordId: new ObjectId(req.userId)
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    const links = await db.collection('property_tenants')
      .find({ propertyId, status: 'pending' })
      .sort({ linkedDate: -1 })
      .toArray();
    const tenantIds = links.map(l => l.tenantId).filter(Boolean);

    // Step 1: look up by _id (old dedicated tenant accounts)
    const tenantDocs = tenantIds.length
      ? await db.collection('tenants').find({ _id: { $in: tenantIds } }).toArray() : [];
    const tenantsById = new Map(tenantDocs.map(t => [t._id.toString(), t]));

    // Step 2: look up by profileId (accounts linked via unified login)
    const profileIdTenantDocs = tenantIds.length
      ? await db.collection('tenants').find({ profileId: { $in: tenantIds } }).toArray() : [];
    profileIdTenantDocs.forEach(t => {
      if (t.profileId) {
        const key = t.profileId.toString();
        if (!tenantsById.has(key)) tenantsById.set(key, t);
      }
    });

    // Step 3: always fetch profiles for ALL tenantIds — authoritative name source
    const pendingProfileDocs = tenantIds.length
      ? await db.collection('profiles').find({ _id: { $in: tenantIds } }).toArray()
      : [];
    const pendingProfilesById = new Map(pendingProfileDocs.map(p => [p._id.toString(), {
      fullName: p.name || p.full_name || p.fullName || p.email || '',
      email: p.email || null,
      phone: p.phone || null
    }]));

    const requests = links.map(l => {
      const key = l.tenantId.toString();
      const t = tenantsById.get(key) || {};
      const p = pendingProfilesById.get(key) || {};
      return {
        tenantId: key,
        fullName: p.fullName || t.fullName || t.name || t.full_name || '',
        email: p.email || t.email || null,
        phone: p.phone || t.phone || null,
        monthlyRent: l.monthlyRent || 0,
        requestedAt: l.linkedDate
      };
    });
    return res.json({ success: true, requests });
  } catch (error) {
    console.error('Pending requests error:', error);
    return res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

// Approve Tenant Join Request
app.post('/api/landlord/properties/:id/tenants/:tenantId/approve', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId, landlordId: new ObjectId(req.userId)
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    let tenantObjId;
    try { tenantObjId = new ObjectId(req.params.tenantId); } catch (_) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }
    await db.collection('property_tenants').updateOne(
      { propertyId, tenantId: tenantObjId, status: 'pending' },
      { $set: { status: 'active', approvedAt: new Date() } }
    );
    await db.collection('tenant_properties').updateOne(
      { propertyId, tenantId: tenantObjId, status: 'pending' },
      { $set: { status: 'active', approvedAt: new Date() } }
    );
    await db.collection('landlord_properties').updateOne(
      { _id: propertyId },
      { $addToSet: { tenants: req.params.tenantId }, $inc: { totalTenants: 1 } }
    );

    // Email the tenant to confirm approval
    try {
      const tenantObjId2 = new ObjectId(req.params.tenantId);
      const tenantProfile = await db.collection('profiles').findOne({ _id: tenantObjId2 }).catch(() => null)
                         || await db.collection('tenants').findOne({ _id: tenantObjId2 }).catch(() => null);
      const tenantEmail = tenantProfile?.email || '';
      const tenantName  = tenantProfile?.full_name || tenantProfile?.fullName || tenantProfile?.name || 'Tenant';
      const propName    = property.name || property.propertyName || 'your property';
      const propLoc     = property.location || property.address || '';
      const propCode    = property.code || property.propertyCode || '';
      if (tenantEmail) {
        const subject = `You've been approved — Welcome to ${propName}!`;
        const text = `Hi ${tenantName},\n\nGreat news! Your join request for "${propName}"${propLoc ? ' in ' + propLoc : ''} has been approved by your landlord.\n\nLog in to your BConnect Tenant Dashboard to pay rent, track payments, and chat with your landlord.\n\nhttps://bconnect.replit.app/tenant-dashboard.html\n\nBConnect Team`;
        const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <div style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;border-radius:14px;padding:22px 24px;margin-bottom:24px;text-align:center;">
            <div style="font-size:40px;margin-bottom:10px;">🎉</div>
            <h2 style="color:#065f46;margin:0 0 6px;">You're Approved!</h2>
            <p style="color:#047857;margin:0;font-size:14px;">Your tenancy at <strong>${propName}</strong> is now active.</p>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <div style="font-size:12px;color:#64748b;margin-bottom:4px;">Property</div>
            <div style="font-size:16px;font-weight:700;color:#0f172a;">${propName}</div>
            ${propLoc ? `<div style="font-size:13px;color:#64748b;margin-top:2px;">📍 ${propLoc}</div>` : ''}
            ${propCode ? `<div style="font-size:13px;color:#64748b;margin-top:2px;">Code: <strong style="font-family:monospace;letter-spacing:2px;">${propCode}</strong></div>` : ''}
          </div>
          <a href="https://bconnect.replit.app/tenant-dashboard.html" style="display:block;text-align:center;background:#0f172a;color:#fff;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:700;font-size:14px;margin-bottom:20px;">Open Tenant Dashboard</a>
          <p style="color:#94a3b8;font-size:12px;text-align:center;">BConnect · Tenant Approvals</p>
        </div>`;
        sendEmail(tenantEmail, subject, text, html);
      }
    } catch (approveEmailErr) {
      console.warn('Tenant approval email failed (non-fatal):', approveEmailErr?.message);
    }

    return res.json({ success: true, message: 'Tenant approved' });
  } catch (error) {
    console.error('Approve tenant error:', error);
    return res.status(500).json({ error: 'Failed to approve tenant' });
  }
});

// Reject Tenant Join Request
app.post('/api/landlord/properties/:id/tenants/:tenantId/reject', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId, landlordId: new ObjectId(req.userId)
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    let tenantObjId;
    try { tenantObjId = new ObjectId(req.params.tenantId); } catch (_) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }
    await db.collection('property_tenants').deleteOne({ propertyId, tenantId: tenantObjId, status: 'pending' });
    await db.collection('tenant_properties').updateOne(
      { propertyId, tenantId: tenantObjId, status: 'pending' },
      { $set: { status: 'rejected' } }
    );
    return res.json({ success: true, message: 'Request rejected' });
  } catch (error) {
    console.error('Reject tenant error:', error);
    return res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Edit Tenant Monthly Rent
app.patch('/api/landlord/properties/:id/tenants/:tenantId', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId, landlordId: new ObjectId(req.userId)
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });
    let tenantObjId;
    try { tenantObjId = new ObjectId(req.params.tenantId); } catch (_) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }
    const { monthlyRent } = req.body || {};
    const rent = parseFloat(monthlyRent);
    if (!rent || rent <= 0) return res.status(400).json({ error: 'Monthly rent must be a positive number' });
    await db.collection('property_tenants').updateOne(
      { propertyId, tenantId: tenantObjId },
      { $set: { monthlyRent: rent, updatedAt: new Date() } }
    );
    await db.collection('tenant_properties').updateOne(
      { propertyId, tenantId: tenantObjId },
      { $set: { monthlyRent: rent, updatedAt: new Date() } }
    );
    return res.json({ success: true, monthlyRent: rent });
  } catch (error) {
    console.error('Edit rent error:', error);
    return res.status(500).json({ error: 'Failed to update rent' });
  }
});

// Get Property Maintenance Requests
app.get('/api/landlord/properties/:id/maintenance', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    const propertyId = new ObjectId(req.params.id);
    const property = await db.collection('landlord_properties').findOne({
      _id: propertyId,
      landlordId: new ObjectId(req.userId)
    });
    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }
    const requests = await db.collection('maintenance_requests')
      .find({ propertyId })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const tenantIds = [...new Set(requests.map(r => r.tenantId && r.tenantId.toString()).filter(Boolean))]
      .map(id => new ObjectId(id));
    const tenantDocs = tenantIds.length
      ? await db.collection('tenants').find({ _id: { $in: tenantIds } }).toArray()
      : [];
    const tenantsById = new Map(tenantDocs.map(t => [t._id.toString(), t]));
    const enriched = requests.map(r => {
      const t = (r.tenantId && tenantsById.get(r.tenantId.toString())) || {};
      return {
        id: r._id.toString(),
        tenantId: r.tenantId ? r.tenantId.toString() : null,
        tenantName: t.fullName || 'Unknown tenant',
        tenantPhone: t.phone || null,
        description: r.description,
        priority: r.priority || 'normal',
        status: r.status || 'pending',
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      };
    });
    return res.json({ success: true, requests: enriched });
  } catch (error) {
    console.error('Get maintenance requests error:', error);
    return res.status(500).json({ error: 'Failed to fetch maintenance requests' });
  }
});

// Update Maintenance Request Status
app.put('/api/landlord/maintenance/:id', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }
    const { status } = req.body;
    const allowed = ['pending', 'in_progress', 'resolved'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: ' + allowed.join(', ') });
    }
    const requestId = new ObjectId(req.params.id);
    const request = await db.collection('maintenance_requests').findOne({ _id: requestId });
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const property = await db.collection('landlord_properties').findOne({
      _id: request.propertyId,
      landlordId: new ObjectId(req.userId)
    });
    if (!property) {
      return res.status(403).json({ error: 'Not authorized to update this request' });
    }
    await db.collection('maintenance_requests').updateOne(
      { _id: requestId },
      { $set: { status, updatedAt: new Date() } }
    );
    return res.json({ success: true, status });
  } catch (error) {
    console.error('Update maintenance request error:', error);
    return res.status(500).json({ error: 'Failed to update request' });
  }
});

// Get Property Payments (enriched with tenant names)
app.get('/api/landlord/properties/:id/payments', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const propObjId = (() => { try { return new ObjectId(req.params.id); } catch(_) { return null; } })();
    if (!propObjId) return res.status(400).json({ error: 'Invalid property ID' });

    // Query by propertyId (landlord_properties._id) OR linkedPropertyId (tenant_properties._id)
    // to handle both old and new payment records robustly
    const rentPayments = await db.collection('rent_payments')
      .find({ $or: [{ propertyId: propObjId }, { linkedPropertyId: propObjId }] })
      .sort({ paidAt: -1, createdAt: -1 })
      .limit(100)
      .toArray();

    // Also pull deposit orders linked to this property
    const propIdStr = req.params.id;
    const depositOrders = await db.collection('orders')
      .find({ payment_type: 'deposit', property_id_ref: propIdStr })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    // Normalise deposit orders into same shape as rent_payments
    const depositPayments = depositOrders.map(o => ({
      _id: o._id,
      tenantName: o.buyer_name || o.buyer_email || 'Tenant',
      tenantEmail: o.buyer_email || '',
      amount: o.amount || 0,
      status: o.payment_status === 'COMPLETE' ? 'completed' : (o.status || 'pending'),
      paymentType: 'deposit',
      property_code: o.property_code || '',
      reference: o.order_id || String(o._id),
      paidAt: o.created_at,
      createdAt: o.created_at
    }));

    const combined = [...rentPayments, ...depositPayments];

    // Enrich rent payments with tenant names
    const enriched = await Promise.all(combined.map(async (p) => {
      if (p.tenantName) return p;
      try {
        const tid = p.tenantId;
        if (!tid) return p;
        let tenant = await db.collection('tenants').findOne({ _id: typeof tid === 'object' ? tid : new ObjectId(String(tid)) });
        if (!tenant) tenant = await db.collection('profiles').findOne({ _id: typeof tid === 'object' ? tid : new ObjectId(String(tid)) });
        const name = tenant ? (tenant.fullName || tenant.full_name || tenant.name || tenant.email || 'Tenant') : 'Tenant';
        const phone = tenant ? (tenant.phone || '') : '';
        return { ...p, tenantName: name, tenantPhone: phone };
      } catch (_) {
        return p;
      }
    }));

    return res.json({
      success: true,
      payments: enriched
    });
  } catch (error) {
    console.error('Get payments error:', error);
    return res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ============ TENANT AUTHENTICATION ENDPOINTS ============

// Tenant Registration
app.post('/api/tenant/register', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { fullName, email, phone, password } = req.body;

    // Validation
    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email already exists
    const existingTenant = await db.collection('tenants').findOne({ email: email.toLowerCase() });
    if (existingTenant) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create tenant document
    const tenantData = {
      fullName: fullName.trim(),
      email: email.toLowerCase(),
      phone: phone.trim(),
      password: hashedPassword,
      linkedProperties: [],
      totalPayments: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('tenants').insertOne(tenantData);
    const tenantId = result.insertedId.toString();

    // Generate JWT token
    const token = generateToken(tenantId);

    return res.status(201).json({
      success: true,
      message: 'Tenant account created successfully',
      token,
      tenantId,
      tenant: {
        id: tenantId,
        fullName: tenantData.fullName,
        email: tenantData.email
      }
    });
  } catch (error) {
    console.error('Tenant registration error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

// Tenant Login — checks unified profiles first, falls back to tenants collection
app.post('/api/tenant/login', authLimiter, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // 1. Try unified profiles collection first
    const profile = await db.collection('profiles').findOne({ email: email.toLowerCase() });
    if (profile) {
      const isValid = await bcrypt.compare(password, profile.password);
      if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

      // Ensure a tenant record exists for this profile
      let tenant = await db.collection('tenants').findOne({ email: email.toLowerCase() });
      if (!tenant) {
        const tr = await db.collection('tenants').insertOne({
          fullName: profile.full_name,
          email: profile.email,
          phone: profile.phone || '',
          password: profile.password,
          profileId: profile._id,
          linkedProperties: [],
          totalPayments: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });
        tenant = { _id: tr.insertedId, fullName: profile.full_name, email: profile.email };
      }

      const token = generateToken(profile._id.toString());
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        tenantId: tenant._id.toString(),
        tenant: { id: tenant._id.toString(), fullName: tenant.fullName || profile.full_name, email: profile.email }
      });
    }

    // 2. Fall back to tenants collection (existing users before unification)
    const tenant = await db.collection('tenants').findOne({ email: email.toLowerCase() });
    if (!tenant) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, tenant.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(tenant._id.toString());

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      tenantId: tenant._id.toString(),
      tenant: {
        id: tenant._id.toString(),
        fullName: tenant.fullName,
        email: tenant.email
      }
    });
  } catch (error) {
    console.error('Tenant login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// Tenant - Verify Token & Get Profile
app.get('/api/tenant/me', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const tenant = await db.collection('tenants').findOne(
      { _id: new ObjectId(req.userId) },
      { projection: { password: 0 } }
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    return res.json({
      success: true,
      tenant: {
        id: tenant._id.toString(),
        fullName: tenant.fullName,
        email: tenant.email,
        phone: tenant.phone
      }
    });
  } catch (error) {
    console.error('Tenant me error:', error);
    return res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Link Property to Tenant
app.post('/api/tenant/link-property', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    let { propertyCode } = req.body || {};

    if (!propertyCode) {
      return res.status(400).json({ error: 'Property code is required' });
    }

    propertyCode = String(propertyCode).trim().toUpperCase();

    // Find property by code (case-insensitive, also try legacy field name)
    let property = await db.collection('landlord_properties').findOne({
      $or: [{ code: propertyCode }, { propertyCode: propertyCode }]
    });
    if (!property) {
      return res.status(404).json({ error: 'Property code not found. Please double-check the code with your landlord.' });
    }

    // Prevent duplicate linking (allow re-apply only if previously rejected)
    const tenantObjId = new ObjectId(req.userId);
    const existing = await db.collection('tenant_properties').findOne({
      tenantId: tenantObjId,
      propertyId: property._id
    });
    if (existing) {
      if (existing.status === 'rejected') {
        // Allow re-application: clean up old rejected records first
        await db.collection('tenant_properties').deleteOne({ _id: existing._id });
        await db.collection('property_tenants').deleteOne({ propertyId: property._id, tenantId: tenantObjId });
      } else {
        const msg = existing.status === 'pending'
          ? 'Your join request is already pending approval.'
          : 'You are already linked to this property.';
        return res.status(409).json({ error: msg });
      }
    }

    // Get landlord info safely (landlordId may be ObjectId, string, or missing on legacy data)
    let landlord = null;
    try {
      const lid = property.landlordId;
      if (lid) {
        const candidates = [];
        if (typeof lid === 'object') candidates.push(lid);
        if (typeof lid === 'string') {
          candidates.push(lid);
          try { candidates.push(new ObjectId(lid)); } catch (_) {}
        }
        for (const c of candidates) {
          landlord = await db.collection('landlords').findOne({ _id: c });
          if (landlord) break;
        }
      }
    } catch (e) {
      console.warn('Landlord lookup failed (non-fatal):', e && e.message);
    }

    const landlordName = (landlord && landlord.fullName) || property.landlordName || 'Property Owner';
    const landlordPhone = (landlord && landlord.phone) || property.landlordPhone || '';
    const propertyName = property.name || property.propertyName || propertyCode;

    // Use tenant-supplied rent if provided, otherwise fall back to landlord-set rent
    const tenantRent = req.body.monthlyRent ? Number(req.body.monthlyRent) : 0;
    const rentNum = tenantRent > 0 ? tenantRent : (property.monthlyRent || 0);

    // Create tenant property link with pending status (awaiting landlord approval)
    const tenantPropertyData = {
      tenantId: tenantObjId,
      propertyId: property._id,
      propertyCode: propertyCode,
      propertyName: propertyName,
      landlordName: landlordName,
      landlordPhone: landlordPhone,
      location: property.location || property.address || property.propertyLocation || '',
      monthlyRent: rentNum,
      linkedDate: new Date(),
      status: 'pending',
      totalPayments: 0
    };

    const result = await db.collection('tenant_properties').insertOne(tenantPropertyData);

    // Create property tenant link visible to landlord as a pending join request
    try {
      await db.collection('property_tenants').insertOne({
        propertyId: property._id,
        tenantId: tenantObjId,
        monthlyRent: rentNum,
        linkedDate: new Date(),
        status: 'pending'
      });
    } catch (e) { console.warn('Failed to insert property_tenants link:', e && e.message); }

    // Auto-assign tenant role and ensure a tenants record exists
    try {
      const tenantProfileId = new ObjectId(req.userId);
      await db.collection('profiles').updateOne(
        { _id: tenantProfileId, role: { $ne: 'admin' } },
        { $set: { role: 'tenant', updated_at: new Date() } }
      );
      const profile = await db.collection('profiles').findOne({ _id: tenantProfileId });
      const existingTenant = await db.collection('tenants').findOne({ profileId: tenantProfileId });
      if (!existingTenant && profile) {
        await db.collection('tenants').insertOne({
          fullName: profile.full_name || profile.name || '',
          email: profile.email || '',
          phone: profile.phone || '',
          password: profile.password || '',
          profileId: tenantProfileId,
          linkedProperties: [],
          totalPayments: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    } catch (_) {}

    // Notify landlord about the new join request
    try {
      const tenantProfile = await db.collection('profiles').findOne({ _id: new ObjectId(req.userId) }).catch(() => null);
      const tenantName = tenantProfile ? (tenantProfile.full_name || tenantProfile.name || tenantProfile.email || 'A tenant') : 'A tenant';
      const tenantEmail = tenantProfile ? (tenantProfile.email || '') : '';

      // In-app notification for landlord
      if (property.landlordId) {
        let landlordObjId = null;
        try { landlordObjId = typeof property.landlordId === 'object' ? property.landlordId : new ObjectId(String(property.landlordId)); } catch (_) {}
        if (landlordObjId) {
          await db.collection('notifications').insertOne({
            user_id: landlordObjId,
            type: 'join_request',
            title: 'New Tenant Join Request',
            message: `${tenantName} has requested to join ${propertyName} using property code ${propertyCode}.`,
            data: { propertyId: String(property._id), propertyCode, tenantName, tenantEmail },
            read: false,
            created_at: new Date()
          }).catch(() => {});

          // Email the landlord — check landlords collection first, then profiles as fallback
          let landlordEmail = landlord && landlord.email ? landlord.email : null;
          if (!landlordEmail && property.landlordId) {
            try {
              const lid = property.landlordId;
              const profileCandidates = [];
              if (typeof lid === 'object') profileCandidates.push(lid);
              if (typeof lid === 'string') {
                profileCandidates.push(lid);
                try { profileCandidates.push(new ObjectId(lid)); } catch (_) {}
              }
              for (const c of profileCandidates) {
                const lp = await db.collection('profiles').findOne({ _id: c }, { projection: { email: 1, name: 1, full_name: 1 } });
                if (lp && lp.email) { landlordEmail = lp.email; break; }
              }
            } catch (_) {}
          }
          if (landlordEmail) {
            const { text, html } = tenantJoinRequestEmail(landlordName, {
              tenantName,
              tenantEmail,
              tenantPhone: tenantProfile && tenantProfile.phone ? tenantProfile.phone : null,
              propertyName,
              propertyCode,
              monthlyRent: rentNum
            });
            sendEmail(landlordEmail, `New Tenant Join Request — ${propertyName}`, text, html);
          }
        }
      }
    } catch (notifErr) {
      console.warn('Landlord join-request notification failed (non-fatal):', notifErr && notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Join request sent! Awaiting landlord approval.',
      property: { _id: result.insertedId, ...tenantPropertyData }
    });
  } catch (error) {
    console.error('Link property error:', error);
    return res.status(500).json({ error: error.message || 'Failed to link property' });
  }
});

// Unlink (delete) a tenant property
app.delete('/api/tenant/properties/:propertyId', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const tenantObjId = new ObjectId(req.userId);
    let propertyObjId;
    try { propertyObjId = new ObjectId(req.params.propertyId); } catch (_) {
      return res.status(400).json({ error: 'Invalid property ID' });
    }
    // Try matching by tenant_properties _id first, then by propertyId
    const deleted = await db.collection('tenant_properties').findOneAndDelete({
      $or: [
        { _id: propertyObjId, tenantId: tenantObjId },
        { propertyId: propertyObjId, tenantId: tenantObjId }
      ]
    });
    if (!deleted) return res.status(404).json({ error: 'Property link not found' });
    // Clean up property_tenants too (non-fatal)
    try {
      await db.collection('property_tenants').deleteOne({
        tenantId: tenantObjId,
        propertyId: (deleted.propertyId || propertyObjId)
      });
    } catch (_) {}
    return res.json({ success: true, message: 'Property unlinked successfully' });
  } catch (error) {
    console.error('Unlink property error:', error);
    return res.status(500).json({ error: error.message || 'Failed to unlink property' });
  }
});

// Get Tenant Properties
app.get('/api/tenant/properties', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const userId = new ObjectId(req.userId);

    // Resolve ALL IDs that may have been used to store this tenant's property links.
    // Three sources of mismatch exist:
    //  1. Direct registration → tenants._id used as tenantId in links
    //  2. Unified profile login → profiles._id used as tenantId in links
    //  3. Hybrid: registered directly but later logs in via profile (different IDs)
    // Strategy: collect every ID associated with this email and search all of them.
    const allIds = [userId];
    const addId = (id) => { if (id && !allIds.some(x => String(x) === String(id))) allIds.push(new ObjectId(String(id))); };

    // Check tenants collection by _id or profileId
    const tenantRecord = await db.collection('tenants')
      .findOne({ $or: [{ _id: userId }, { profileId: userId }] })
      .catch(() => null);
    if (tenantRecord) {
      addId(tenantRecord._id);
      addId(tenantRecord.profileId);
    }

    // Also resolve by email (catches the case where profileId was never set on the tenants record)
    const profileRecord = await db.collection('profiles')
      .findOne({ _id: userId })
      .catch(() => null);
    if (profileRecord?.email) {
      const tenantByEmail = await db.collection('tenants')
        .findOne({ email: profileRecord.email.toLowerCase() })
        .catch(() => null);
      if (tenantByEmail) {
        addId(tenantByEmail._id);
        addId(tenantByEmail.profileId);
      }
    }

    const tenantLinks = await db.collection('tenant_properties')
      .find({ tenantId: { $in: allIds } })
      .sort({ linkedDate: -1 })
      .toArray();

    if (!tenantLinks.length) {
      return res.json({ success: true, properties: [] });
    }

    // Enrich each link with fresh data from landlord_properties and property_tenants
    const enriched = await Promise.all(tenantLinks.map(async (link) => {
      let lp = null;
      let pt = null;
      try {
        if (link.propertyId) {
          lp = await db.collection('landlord_properties').findOne({ _id: link.propertyId });
          pt = await db.collection('property_tenants').findOne({
            propertyId: link.propertyId,
            tenantId: { $in: allIds }
          });
        }
      } catch (_) {}

      return {
        ...link,
        // Always reflect the latest values from landlord side
        propertyName: (lp && (lp.name || lp.propertyName)) || link.propertyName || 'Property',
        location: (lp && (lp.location || lp.address || lp.propertyLocation)) || link.location || '',
        monthlyRent: (pt && pt.monthlyRent) || (lp && lp.monthlyRent) || link.monthlyRent || 0,
        propertyCode: (lp && (lp.code || lp.propertyCode)) || link.propertyCode || link.code || '',
        units: (lp && lp.units) || link.units || 0,
      };
    }));

    return res.json({
      success: true,
      properties: enriched
    });
  } catch (error) {
    console.error('Get tenant properties error:', error);
    return res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// Get Tenant Property Payments
app.get('/api/tenant/properties/:id/payments', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const userId = new ObjectId(req.userId);
    const allIds = [userId];
    const addId2 = (id) => { if (id && !allIds.some(x => String(x) === String(id))) allIds.push(new ObjectId(String(id))); };
    const tenantRecord = await db.collection('tenants').findOne({ $or: [{ _id: userId }, { profileId: userId }] }).catch(() => null);
    if (tenantRecord) { addId2(tenantRecord._id); addId2(tenantRecord.profileId); }
    const profileRecord = await db.collection('profiles').findOne({ _id: userId }).catch(() => null);
    if (profileRecord?.email) {
      const tByEmail = await db.collection('tenants').findOne({ email: profileRecord.email.toLowerCase() }).catch(() => null);
      if (tByEmail) { addId2(tByEmail._id); addId2(tByEmail.profileId); }
    }

    const payments = await db.collection('rent_payments')
      .find({
        propertyId: new ObjectId(req.params.id),
        tenantId: { $in: allIds }
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return res.json({
      success: true,
      payments: payments || []
    });
  } catch (error) {
    console.error('Get tenant payments error:', error);
    return res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Pay Rent
app.post('/api/tenant/pay-rent', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { propertyId, amount } = req.body;

    if (!propertyId || !amount) {
      return res.status(400).json({ error: 'Property ID and amount are required' });
    }

    // Verify property belongs to tenant — accept either the tenant_properties _id
    // or the landlord property _id (propertyId field) so both call patterns work
    let tenantProperty = null;
    try {
      const pid = new ObjectId(propertyId);
      tenantProperty = await db.collection('tenant_properties').findOne({
        tenantId: new ObjectId(req.userId),
        $or: [{ _id: pid }, { propertyId: pid }],
        status: 'active'
      });
    } catch (_) {}

    if (!tenantProperty) {
      return res.status(404).json({ error: 'Property not found or not yet approved' });
    }

    const parsedAmount = parseFloat(amount);
    const paymentType = req.body.paymentType || 'full';

    // Look up tenant details to store denormalised name (speeds up admin/landlord display)
    let tenantRec = await db.collection('tenants').findOne({ _id: new ObjectId(req.userId) }).catch(() => null);
    if (!tenantRec) tenantRec = await db.collection('profiles').findOne({ _id: new ObjectId(req.userId) }).catch(() => null);
    const tenantName = tenantRec
      ? (tenantRec.fullName || tenantRec.full_name || tenantRec.name || tenantRec.email || '')
      : '';
    const tenantPhone = tenantRec ? (tenantRec.phone || '') : '';

    // Ensure we have the landlord property ObjectId (fall back to a lookup if missing)
    let landlordPropertyId = tenantProperty.propertyId;
    if (!landlordPropertyId && tenantProperty.propertyCode) {
      try {
        const lp = await db.collection('landlord_properties').findOne({ code: tenantProperty.propertyCode });
        if (lp) landlordPropertyId = lp._id;
      } catch (_) {}
    }

    // Create payment record — saved as completed immediately
    const paymentData = {
      tenantId: new ObjectId(req.userId),
      propertyId: landlordPropertyId || null,
      linkedPropertyId: new ObjectId(propertyId),
      tenantName,
      tenantPhone,
      propertyName: tenantProperty.propertyName || tenantProperty.address || '',
      landlordName: tenantProperty.landlordName || '',
      amount: parsedAmount,
      paymentType,
      status: 'completed',
      paymentMethod: 'mpesa',
      reference: 'BC' + Date.now().toString(36).toUpperCase(),
      paidAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('rent_payments').insertOne(paymentData);

    // Update tenant property total payments — use the resolved _id, not the raw param
    await db.collection('tenant_properties').updateOne(
      { _id: tenantProperty._id },
      { $inc: { totalPayments: parsedAmount } }
    );

    // Send payment receipt email with PDF attachment to tenant + alert to landlord
    try {
      // Look up tenant profile — try tenants collection first, then profiles
      let tenant = await db.collection('tenants').findOne({ _id: new ObjectId(req.userId) });
      if (!tenant) tenant = await db.collection('profiles').findOne({ _id: new ObjectId(req.userId) });
      if (!tenant && req.user) tenant = req.user;
      const propertyName = tenantProperty.propertyName || tenantProperty.address || 'Rent Payment';

      //  Tenant receipt 
      if (tenant && tenant.email) {
        const receiptData = {
          orderId: paymentData.reference,
          item: propertyName,
          amount: parsedAmount,
          phone: tenant.phone,
          paymentType: paymentType === 'full' ? 'rent' : paymentType,
          propertyCode: tenantProperty.propertyCode || paymentData.propertyCode || '',
          date: new Date()
        };
        const recipientName = tenant.full_name || tenant.fullName || tenant.email;
        const { text, html } = paymentReceiptEmail(recipientName, receiptData);
        sendEmail(tenant.email, 'Rent Payment Confirmed — BConnect Receipt', text, html);
      }

      //  Landlord alert 
      try {
        // Trace: tenant_properties → landlord_properties → landlords
        const landlordProp = tenantProperty.propertyId
          ? await db.collection('landlord_properties').findOne({ _id: tenantProperty.propertyId })
          : null;
        const landlord = landlordProp?.landlordId
          ? await db.collection('landlords').findOne({ _id: landlordProp.landlordId })
          : null;

        if (landlord && landlord.email) {
          const alertData = {
            tenantName:   tenant?.full_name || tenant?.fullName || tenant?.name || 'Tenant',
            tenantPhone:  tenant?.phone || '—',
            propertyName,
            amount:       parsedAmount,
            reference:    paymentData.reference,
            paymentType:  paymentType === 'full' ? 'rent' : paymentType,
            date:         new Date()
          };
          const landlordName = landlord.full_name || landlord.fullName || landlord.name || landlord.email;
          const { text, html } = landlordPaymentAlertEmail(landlordName, alertData);
          sendEmail(landlord.email, `Rent Received — ${alertData.tenantName} paid ${'KES ' + Number(parsedAmount).toLocaleString('en-KE')}`, text, html);
          console.log(`[email] Landlord alert sent to ${landlord.email} for payment ${paymentData.reference}`);
        }
      } catch (landlordErr) {
        console.error('Landlord alert email error:', landlordErr.message);
      }
    } catch (emailErr) {
      console.error('Rent receipt email error:', emailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Payment completed successfully',
      payment: {
        id: result.insertedId.toString(),
        ...paymentData
      }
    });
  } catch (error) {
    console.error('Pay rent error:', error);
    return res.status(500).json({ error: 'Failed to process payment' });
  }
});

// Request Repair
app.post('/api/tenant/request-repair', verifyToken, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const { propertyId, description, priority } = req.body;

    if (!propertyId || !description) {
      return res.status(400).json({ error: 'Property ID and description are required' });
    }

    // Create maintenance request
    const requestData = {
      tenantId: new ObjectId(req.userId),
      propertyId: new ObjectId(propertyId),
      description: description.trim(),
      priority: priority || 'normal',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('maintenance_requests').insertOne(requestData);

    return res.status(201).json({
      success: true,
      message: 'Repair request submitted successfully',
      request: {
        id: result.insertedId.toString(),
        ...requestData
      }
    });
  } catch (error) {
    console.error('Request repair error:', error);
    return res.status(500).json({ error: 'Failed to submit repair request' });
  }
});

// ============ TENANT PROPERTY EXTRAS: requests, announcements, messages ============

// Helper: ensure the tenant has a link to the property
async function tenantOwnsProperty(req, propertyIdParam) {
  let propertyId;
  try { propertyId = new ObjectId(propertyIdParam); } catch (_) { return null; }

  // Resolve all IDs this tenant may have been stored under (same logic as GET /api/tenant/properties)
  const userId = new ObjectId(req.userId);
  const allIds = [userId];
  const addId = (id) => { if (id && !allIds.some(x => String(x) === String(id))) { try { allIds.push(new ObjectId(String(id))); } catch(_){} } };

  const tenantRecord = await db.collection('tenants').findOne({ $or: [{ _id: userId }, { profileId: userId }] }).catch(() => null);
  if (tenantRecord) { addId(tenantRecord._id); addId(tenantRecord.profileId); }

  const profileRecord = await db.collection('profiles').findOne({ _id: userId }).catch(() => null);
  if (profileRecord?.email) {
    const tByEmail = await db.collection('tenants').findOne({ email: profileRecord.email.toLowerCase() }).catch(() => null);
    if (tByEmail) { addId(tByEmail._id); addId(tByEmail.profileId); }
  }

  const link = await db.collection('tenant_properties').findOne({
    tenantId: { $in: allIds },
    propertyId,
    status: 'active'
  });
  return link ? propertyId : null;
}

// Helper: ensure the landlord owns the property
async function landlordOwnsProperty(req, propertyIdParam) {
  let propertyId;
  try { propertyId = new ObjectId(propertyIdParam); } catch (_) { return null; }
  const property = await db.collection('landlord_properties').findOne({
    _id: propertyId,
    landlordId: new ObjectId(req.userId)
  });
  return property ? propertyId : null;
}

// Tenant: list their repair/maintenance requests for a property (with status)
app.get('/api/tenant/properties/:id/requests', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await tenantOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'Not linked to this property' });
    const requests = await db.collection('maintenance_requests')
      .find({ tenantId: new ObjectId(req.userId), propertyId })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    return res.json({ success: true, requests });
  } catch (error) {
    console.error('List tenant requests error:', error);
    return res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Landlord: post an announcement to a property
app.post('/api/landlord/properties/:id/announcements', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await landlordOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'You do not own this property' });
    const { title, body } = req.body || {};
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
    const doc = {
      propertyId,
      landlordId: new ObjectId(req.userId),
      title: String(title).trim(),
      body: String(body).trim(),
      createdAt: new Date()
    };
    const result = await db.collection('announcements').insertOne(doc);
    return res.status(201).json({ success: true, announcement: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error('Create announcement error:', error);
    return res.status(500).json({ error: 'Failed to create announcement' });
  }
});

// Landlord: list announcements for a property
app.get('/api/landlord/properties/:id/announcements', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await landlordOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'You do not own this property' });
    const list = await db.collection('announcements')
      .find({ propertyId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return res.json({ success: true, announcements: list });
  } catch (error) {
    console.error('List announcements (landlord) error:', error);
    return res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// Tenant: list announcements for a linked property
app.get('/api/tenant/properties/:id/announcements', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await tenantOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'Not linked to this property' });
    const list = await db.collection('announcements')
      .find({ propertyId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return res.json({ success: true, announcements: list });
  } catch (error) {
    console.error('List announcements (tenant) error:', error);
    return res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// Tenant: read messages with the landlord scoped to a property
app.get('/api/tenant/properties/:id/messages', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await tenantOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'Not linked to this property' });
    // Resolve all IDs to find messages regardless of which ID was used when sending
    const userId = new ObjectId(req.userId);
    const msgIds = [userId];
    const addMsgId = (id) => { if (id && !msgIds.some(x => String(x) === String(id))) { try { msgIds.push(new ObjectId(String(id))); } catch(_){} } };
    const tr = await db.collection('tenants').findOne({ $or: [{ _id: userId }, { profileId: userId }] }).catch(() => null);
    if (tr) { addMsgId(tr._id); addMsgId(tr.profileId); }
    const pr = await db.collection('profiles').findOne({ _id: userId }).catch(() => null);
    if (pr?.email) { const te = await db.collection('tenants').findOne({ email: pr.email.toLowerCase() }).catch(() => null); if (te) { addMsgId(te._id); addMsgId(te.profileId); } }

    const messages = await db.collection('property_messages')
      .find({ propertyId, tenantId: { $in: msgIds } })
      .sort({ createdAt: 1 })
      .limit(200)
      .toArray();
    return res.json({ success: true, messages });
  } catch (error) {
    console.error('Tenant messages list error:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Tenant: send a message to the landlord scoped to a property
app.post('/api/tenant/properties/:id/messages', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await tenantOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'Not linked to this property' });
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Message text is required' });

    // Use the canonical tenantId from the property link so the landlord can always query it back
    const userId = new ObjectId(req.userId);
    const link = await db.collection('tenant_properties').findOne({ propertyId });
    const canonicalTenantId = link?.tenantId || userId;

    const doc = {
      propertyId,
      tenantId: canonicalTenantId,
      sender: 'tenant',
      text: String(text).trim().slice(0, 2000),
      createdAt: new Date(),
      readByLandlord: false
    };
    const result = await db.collection('property_messages').insertOne(doc);
    return res.status(201).json({ success: true, message: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error('Tenant send message error:', error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// Landlord: list messages from a tenant on a property (?tenantId=...)
app.get('/api/landlord/properties/:id/messages', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await landlordOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'You do not own this property' });
    const filter = { propertyId };
    if (req.query.tenantId) {
      // Expand the tenantId to all related IDs to catch messages stored under any variant
      try {
        const qId = new ObjectId(req.query.tenantId);
        const tenantIds = [qId];
        const addTId = (id) => { if (id && !tenantIds.some(x => String(x) === String(id))) { try { tenantIds.push(new ObjectId(String(id))); } catch(_){} } };
        const tRec = await db.collection('tenants').findOne({ $or: [{ _id: qId }, { profileId: qId }] }).catch(() => null);
        if (tRec) { addTId(tRec._id); addTId(tRec.profileId); }
        filter.tenantId = { $in: tenantIds };
      } catch (_) {}
    }
    const messages = await db.collection('property_messages')
      .find(filter)
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray();
    return res.json({ success: true, messages });
  } catch (error) {
    console.error('Landlord messages list error:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Landlord: reply to a tenant on a property (body: { tenantId, text })
app.post('/api/landlord/properties/:id/messages', verifyToken, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database temporarily unavailable' });
    const propertyId = await landlordOwnsProperty(req, req.params.id);
    if (!propertyId) return res.status(403).json({ error: 'You do not own this property' });
    const { tenantId, text } = req.body || {};
    if (!tenantId || !text) return res.status(400).json({ error: 'tenantId and text are required' });
    let tenantObjId;
    try { tenantObjId = new ObjectId(tenantId); } catch (_) { return res.status(400).json({ error: 'Invalid tenantId' }); }
    const doc = {
      propertyId,
      tenantId: tenantObjId,
      sender: 'landlord',
      text: String(text).trim().slice(0, 2000),
      createdAt: new Date(),
      readByTenant: false
    };
    const result = await db.collection('property_messages').insertOne(doc);
    return res.status(201).json({ success: true, message: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error('Landlord send message error:', error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// Centralised error handler - returns JSON, logs only the message (no stack noise)
// 
// SELLER DASHBOARD API  (MongoDB-only)
// 

// GET /api/seller/dashboard  — stats for current seller only
app.get('/api/seller/dashboard', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const sellerId = String(req.user._id);

    const sellerQuery = { seller_id: sellerId };
    const [products, orders] = await Promise.all([
      db.collection('properties').find(sellerQuery).sort({ created_at: -1 }).limit(100).toArray(),
      db.collection('orders').find(sellerQuery).sort({ created_at: -1 }).limit(100).toArray()
    ]);

    const activeProducts  = products.filter(p => p.active && p.status !== 'rejected');
    const pendingProducts = products.filter(p => !p.active && p.status !== 'rejected');
    const rejectedProducts= products.filter(p => p.status === 'rejected');

    const completedOrders = orders.filter(o =>
      o.status === 'completed' || o.status === 'delivered' ||
      o.payment_status === 'COMPLETE'
    );
    const totalEarnings = completedOrders.reduce((s, o) => s + (Number(o.amount) || Number(o.total) || 0), 0);

    // Sales by month (last 6)
    const now = new Date();
    const monthlySales = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleString('en-KE', { month: 'short' });
      const monthOrders = orders.filter(o => {
        const od = new Date(o.created_at || o.createdAt);
        return od.getMonth() === d.getMonth() && od.getFullYear() === d.getFullYear();
      });
      monthlySales.push({ label, total: monthOrders.reduce((s, o) => s + (Number(o.amount) || Number(o.total) || 0), 0) });
    }

    // Category split
    const catMap = {};
    products.forEach(p => {
      const c = p.category || 'Other';
      catMap[c] = (catMap[c] || 0) + 1;
    });

    return res.json({
      success: true,
      stats: {
        totalEarnings,
        totalProducts: products.length,
        activeProducts: activeProducts.length,
        pendingProducts: pendingProducts.length,
        rejectedProducts: rejectedProducts.length,
        totalOrders: orders.length,
        completedOrders: completedOrders.length
      },
      monthlySales,
      categoryBreakdown: Object.entries(catMap).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count),
      recentOrders: orders.slice(-5).reverse()
    });
  } catch (err) {
    console.error('Seller dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/seller/subscribe — activate monthly unlimited plan
app.post('/api/seller/subscribe', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { paymentOrderId } = req.body || {};
    if (!paymentOrderId) return res.status(400).json({ error: 'paymentOrderId is required' });

    const order = await db.collection('orders').findOne({ order_id: paymentOrderId });
    if (!order) return res.status(404).json({ error: 'Payment order not found' });
    if (order.payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Payment not completed' });
    if (Number(order.amount) < 500) return res.status(400).json({ error: 'Insufficient payment amount' });

    const sellerObjId = req.user._id;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.collection('seller_subscriptions').updateOne(
      { sellerId: sellerObjId },
      { $set: { sellerId: sellerObjId, status: 'active', expiresAt, updatedAt: new Date(), paymentOrderId } },
      { upsert: true }
    );

    return res.json({ success: true, expiresAt, message: 'Unlimited listings activated for 30 days!' });
  } catch (err) {
    console.error('Seller subscribe error:', err);
    return res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// GET /api/seller/products  — seller's own listings only
app.get('/api/seller/products', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const sellerId = String(req.user._id);
    const sellerObjId = req.user._id;

    const [products, activeSub] = await Promise.all([
      db.collection('properties').find({ seller_id: sellerId }).sort({ created_at: -1 }).toArray(),
      db.collection('seller_subscriptions').findOne({ sellerId: sellerObjId, status: 'active', expiresAt: { $gt: new Date() } })
    ]);

    const FREE_LISTING_LIMIT = 4;
    const used = products.length;
    const hasUnlimited = !!activeSub;
    const freeRemaining = hasUnlimited ? null : Math.max(0, FREE_LISTING_LIMIT - used);

    return res.json({ success: true, products, quota: { used, limit: FREE_LISTING_LIMIT, freeRemaining, hasUnlimited, subExpiresAt: activeSub?.expiresAt || null } });
  } catch (err) {
    console.error('Seller products error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


//  LANDLORD WITHDRAWAL / BALANCE ROUTES 

// Get admin-set commission rate
app.get('/api/admin/commission-rate', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, rate: 10 });
    const setting = await db.collection('settings').findOne({ key: 'commission_rate' });
    return res.json({ success: true, rate: setting?.value ?? 10 });
  } catch (e) { return res.json({ success: true, rate: 10 }); }
});

// Admin set commission rate
app.put('/api/admin/commission-rate', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { rate } = req.body;
    if (typeof rate !== 'number' || rate < 0 || rate > 100) return res.status(400).json({ error: 'Rate must be 0-100' });
    await db.collection('settings').updateOne({ key: 'commission_rate' }, { $set: { key: 'commission_rate', value: rate } }, { upsert: true });
    return res.json({ success: true, rate });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Landlord request withdrawal
app.post('/api/landlord/withdrawal', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { landlordId, amount, phone, payoutMethod, accountNumber, accountName } = req.body;
    if (!landlordId || !amount || amount <= 0) return res.status(400).json({ error: 'landlordId and amount required' });

    // Get commission rate
    const setting = await db.collection('settings').findOne({ key: 'commission_rate' });
    const rate = setting?.value ?? 10;
    const deduction = Math.round((amount * rate) / 100);
    const netAmount = amount - deduction;

    const withdrawal = {
      landlord_id: landlordId,
      requested_amount: amount,
      commission_rate: rate,
      deduction_amount: deduction,
      net_amount: netAmount,
      phone: phone || '',
      payoutMethod: payoutMethod || 'mpesa',
      accountNumber: accountNumber || '',
      accountName: accountName || '',
      status: 'pending',
      created_at: new Date(),
      expected_by: new Date(Date.now() + 24 * 60 * 60 * 1000)
    };
    const result = await db.collection('withdrawals').insertOne(withdrawal);

    // Notify landlord
    const _wdLbl = payoutMethod === 'kcb' ? 'KCB Bank' : payoutMethod === 'equity' ? 'Equity Bank' : 'M-Pesa';
    const _wdDest = payoutMethod === 'mpesa' ? (phone || '') : `${accountNumber} (${accountName})`;
    db.collection('notifications').insertOne({ user_id: landlordId, role: 'landlord', type: 'withdrawal_submitted', title: 'Withdrawal Request Submitted', message: `Your KES ${amount.toLocaleString()} withdrawal via ${_wdLbl} ${_wdDest} is pending admin review. You'll receive KES ${netAmount.toLocaleString()} after ${rate}% commission.`, read: false, created_at: new Date() }).catch(() => {});
    // Notify admin
    db.collection('notifications').insertOne({ user_id: 'admin', role: 'admin', type: 'withdrawal_request', title: 'New Landlord Withdrawal', message: `Landlord (ID: ...${String(landlordId).slice(-6)}) requested KES ${amount.toLocaleString()} via ${_wdLbl} ${_wdDest}.`, read: false, created_at: new Date() }).catch(() => {});

    return res.json({ success: true, withdrawal: { ...withdrawal, _id: result.insertedId }, deduction, netAmount, rate });
  } catch (e) { console.error('Withdrawal error:', e); res.status(500).json({ error: 'Server error' }); }
});

// Get landlord withdrawal history
app.get('/api/landlord/withdrawals/:landlordId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, withdrawals: [] });
    const withdrawals = await db.collection('withdrawals')
      .find({ landlord_id: req.params.landlordId })
      .sort({ created_at: -1 }).limit(20).toArray();
    return res.json({ success: true, withdrawals });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Admin: list all withdrawals
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, withdrawals: [] });
    const [landlordWds, sellerWds] = await Promise.all([
      db.collection('withdrawals').find({}).sort({ created_at: -1 }).limit(100).toArray(),
      db.collection('seller_withdrawals').find({}).sort({ requestedAt: -1 }).limit(100).toArray()
    ]);
    const tagged = [
      ...landlordWds.map(w => ({ ...w, _type: 'landlord' })),
      ...sellerWds.map(w => ({
        ...w,
        _type: 'seller',
        requested_amount: w.amount,
        created_at: w.requestedAt
      }))
    ].sort((a, b) => new Date(b.created_at || b.requestedAt || 0) - new Date(a.created_at || a.requestedAt || 0));
    return res.json({ success: true, withdrawals: tagged });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Admin approve/process withdrawal
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { action, _type } = req.body;
    const newStatus = action === 'approve' ? 'completed' : 'rejected';
    const col = _type === 'seller' ? 'seller_withdrawals' : 'withdrawals';
    await db.collection(col).updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: newStatus, processed_at: new Date() } }
    );
    // Notify user of decision
    try {
      const wd = await db.collection(col).findOne({ _id: new ObjectId(req.params.id) });
      if (wd) {
        const userId = _type === 'seller' ? String(wd.sellerId) : String(wd.landlord_id);
        const role = _type === 'seller' ? 'seller' : 'landlord';
        const amt = (wd.requested_amount || wd.amount || 0).toLocaleString();
        const statusMsg = action === 'approve'
          ? `approved! Your KES ${amt} will be sent to your payout account shortly.`
          : `rejected. Please contact support if you have questions.`;
        db.collection('notifications').insertOne({ user_id: userId, role, type: `withdrawal_${action}d`, title: `Withdrawal ${action === 'approve' ? 'Approved ✓' : 'Rejected'}`, message: `Your withdrawal request of KES ${amt} has been ${statusMsg}`, read: false, created_at: new Date() }).catch(() => {});
      }
    } catch(ne) {}
    return res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Notification endpoints
app.get('/api/landlord/notifications/:landlordId', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, notifications: [] });
    const notifs = await db.collection('notifications').find({ user_id: req.params.landlordId, role: 'landlord' }).sort({ created_at: -1 }).limit(30).toArray();
    return res.json({ success: true, notifications: notifs });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/landlord/notifications/:landlordId/read-all', async (req, res) => {
  try {
    if (!db) return res.json({ success: true });
    await db.collection('notifications').updateMany({ user_id: req.params.landlordId, role: 'landlord' }, { $set: { read: true } });
    return res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/seller/notifications', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true, notifications: [] });
    const notifs = await db.collection('notifications').find({ user_id: String(req.userId), role: 'seller' }).sort({ created_at: -1 }).limit(30).toArray();
    return res.json({ success: true, notifications: notifs });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/seller/notifications/read-all', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ success: true });
    await db.collection('notifications').updateMany({ user_id: String(req.userId), role: 'seller' }, { $set: { read: true } });
    return res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/admin/notifications', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, notifications: [] });
    const notifs = await db.collection('notifications').find({ role: 'admin' }).sort({ created_at: -1 }).limit(50).toArray();
    return res.json({ success: true, notifications: notifs });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/admin/notifications/read-all', async (req, res) => {
  try {
    if (!db) return res.json({ success: true });
    await db.collection('notifications').updateMany({ role: 'admin' }, { $set: { read: true } });
    return res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/seller/products  — submit a new product (pending admin approval)
app.post('/api/seller/products', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const {
      title,
      description,
      price,
      category,
      subcategory,
      location,
      imageUrl,
      images,
      video_url,
      variants,
      paymentOrderId,
      paymentAmount
    } = req.body;

    if (!title || !category) return res.status(400).json({ error: 'Title and category are required' });

    const sellerId = String(req.user._id);
    const sellerObjId = req.user._id;

    // Check for active unlimited monthly subscription
    const activeSub = await db.collection('seller_subscriptions').findOne({
      sellerId: sellerObjId, status: 'active', expiresAt: { $gt: new Date() }
    });

    const existingCount = await db.collection('properties').countDocuments({ seller_id: sellerId });
    const FREE_LISTING_LIMIT = 4;
    const LISTING_FEE_KES = 200;
    const shouldCharge = !activeSub && existingCount >= FREE_LISTING_LIMIT;

    if (shouldCharge && !paymentOrderId) {
      return res.status(402).json({
        success: false,
        requiresPayment: true,
        paymentAmount: LISTING_FEE_KES,
        freeLimit: FREE_LISTING_LIMIT,
        usedCount: existingCount,
        message: `You have used your ${FREE_LISTING_LIMIT} free listings. Pay KES ${LISTING_FEE_KES} per listing or subscribe for KES 500/month for unlimited.`
      });
    }

    if (shouldCharge && paymentOrderId) {
      const order = await db.collection('orders').findOne({ order_id: paymentOrderId });
      if (!order) {
        return res.status(400).json({ error: 'Payment order not found' });
      }
      if (order.payment_status !== 'COMPLETE') {
        return res.status(400).json({ error: 'Payment not completed yet' });
      }
      if (Number(order.amount) < Number(paymentAmount || LISTING_FEE_KES)) {
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }
    }

    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []);
    const imgUrl = imgArr[0] || '';

    // Normalise variants
    const normVariants = Array.isArray(variants) ? variants.map(v => ({
      name:     (v.name || v.category || '').trim(),
      category: (v.name || v.category || '').trim(),
      size:     (v.size  || '').trim(),
      color:    (v.color || '').trim(),
      price:    v.price  ? parseFloat(v.price)  : null,
      stock:    v.stock  ? parseInt(v.stock)     : 0,
      image:    (v.image || '').trim()
    })).filter(v => v.name || v.size || v.color) : [];

    const normalizedCategory = category.toString().trim().toLowerCase();
    // Enforce exactly one of three listing types based on the category value
    let listingType;
    if (normalizedCategory === 'service' || normalizedCategory.includes('service')) {
      listingType = 'service';
    } else if (normalizedCategory === 'housing' || normalizedCategory.includes('housing') || normalizedCategory.includes('rent') || normalizedCategory.includes('rental')) {
      listingType = 'housing';
    } else {
      listingType = 'product'; // default covers 'product' and any legacy sub-categories
    }

    const now = new Date();
    // Normalise the category to one of the 3 canonical values
    const canonicalCategory = listingType; // 'product' | 'service' | 'housing'

    // Base price: use form price or lowest variant price
    const basePrice = parseFloat(price) ||
      (normVariants.length ? Math.min(...normVariants.map(v => v.price || Infinity).filter(isFinite)) : 0);

    const product = {
      title:       title.trim(),
      description: (description || '').trim(),
      price:       basePrice,
      category:    canonicalCategory,
      subcategory: (subcategory || '').trim() || null,
      location:    (location || '').trim(),
      images:      imgArr,
      imageUrl:    imgUrl,
      image_url:   imgUrl,
      video_url:   video_url || null,
      variants:    normVariants,
      has_variants: normVariants.length > 0,
      seller_id:   sellerId,
      seller_name: req.user.name || req.user.full_name || '',
      seller_email:req.user.email || '',
      status:      'pending',
      active:      false,
      rejection_reason: null,
      payment_amount: shouldCharge ? Number(paymentAmount || LISTING_FEE_KES) : 0,
      payment_order_id: paymentOrderId || null,
      listing_type: listingType,
      created_at:  now,
      updated_at:  now
    };

    const result = await db.collection('properties').insertOne(product);

    // Auto-assign seller role when a user submits their first listing
    try {
      await db.collection('profiles').updateOne(
        { _id: req.user._id, role: { $ne: 'admin' } },
        { $set: { role: 'seller', updated_at: new Date() } }
      );
    } catch (_) {}

    return res.status(201).json({ success: true, product: { ...product, _id: result.insertedId } });
  } catch (err) {
    console.error('Seller add product error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/seller/products/:id  — edit own product
app.put('/api/seller/products/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const sellerId = String(req.user._id);
    const { title, description, price, category, subcategory, location, imageUrl, images, video_url, variants } = req.body;

    const existing = await db.collection('properties').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.seller_id !== sellerId) return res.status(403).json({ error: 'Not your product' });

    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : existing.images || []);
    const imgUrl = imgArr[0] || '';

    // Normalise variants if provided
    const normVariants = Array.isArray(variants) ? variants.map(v => ({
      name:     (v.name || v.category || '').trim(),
      category: (v.name || v.category || '').trim(),
      size:     (v.size  || '').trim(),
      color:    (v.color || '').trim(),
      price:    v.price  ? parseFloat(v.price)  : null,
      stock:    v.stock  ? parseInt(v.stock)     : 0,
      image:    (v.image || '').trim()
    })).filter(v => v.name || v.size || v.color) : (existing.variants || []);

    const finalCategory = (category || existing.category).trim();
    const normalizedCategory = finalCategory.toLowerCase();
    let listingType = 'product';
    if (normalizedCategory === 'housing' || normalizedCategory.includes('housing') || normalizedCategory.includes('rent') || normalizedCategory.includes('rental')) {
      listingType = 'housing';
    } else if (normalizedCategory === 'service' || normalizedCategory.includes('service')) {
      listingType = 'service';
    }

    // Base price: form price, or lowest variant price, or keep existing
    const basePrice = parseFloat(price) ||
      (normVariants.length ? Math.min(...normVariants.map(v => v.price || Infinity).filter(isFinite)) : existing.price || 0);

    const updates = {
      title:        (title || existing.title).trim(),
      description:  (description !== undefined ? description : existing.description || '').trim(),
      price:        basePrice,
      category:     finalCategory,
      subcategory:  subcategory !== undefined ? ((subcategory || '').trim() || null) : (existing.subcategory || null),
      listing_type: listingType,
      location:     (location !== undefined ? location : existing.location || '').trim(),
      images:       imgArr,
      imageUrl:     imgUrl,
      image_url:    imgUrl,
      video_url:    video_url !== undefined ? (video_url || null) : (existing.video_url || null),
      variants:     normVariants,
      has_variants: normVariants.length > 0,
      status:       'pending',
      active:       false,
      rejection_reason: null,
      updated_at:   new Date()
    };

    await db.collection('properties').updateOne({ _id: new ObjectId(id) }, { $set: updates });
    return res.json({ success: true, message: 'Product updated and resubmitted for approval' });
  } catch (err) {
    console.error('Seller edit product error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/seller/products/:id  — delete own product
app.delete('/api/seller/products/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { id } = req.params;
    const sellerId = String(req.user._id);
    const existing = await db.collection('properties').findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.seller_id !== sellerId) return res.status(403).json({ error: 'Not your product' });
    await db.collection('properties').deleteOne({ _id: new ObjectId(id) });
    return res.json({ success: true });
  } catch (err) {
    console.error('Seller delete product error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/seller/withdrawals — seller's own withdrawal history
app.get('/api/seller/withdrawals', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const sellerId = new ObjectId(req.userId);
    const withdrawals = await db.collection('seller_withdrawals')
      .find({ sellerId })
      .sort({ requestedAt: -1 })
      .limit(50)
      .toArray();
    return res.json({ success: true, withdrawals });
  } catch (err) {
    console.error('Seller withdrawals fetch error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/seller/withdraw — seller requests an earnings withdrawal
app.post('/api/seller/withdraw', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const { amount, phone, payoutMethod, accountNumber, accountName } = req.body || {};
    if (!amount || Number(amount) < 100) return res.status(400).json({ error: 'Minimum withdrawal amount is KES 100' });
    if (!payoutMethod) return res.status(400).json({ error: 'Payout method is required' });
    if (payoutMethod === 'mpesa' && !phone) return res.status(400).json({ error: 'M-Pesa phone number is required' });
    if (payoutMethod !== 'mpesa' && (!accountNumber || !accountName)) return res.status(400).json({ error: 'Account number and account name are required' });

    const sellerId = new ObjectId(req.userId);
    const sellerIdStr = String(req.userId);

    // Check available balance before allowing withdrawal
    const [orders, pastWithdrawals] = await Promise.all([
      db.collection('orders').find({ seller_id: sellerIdStr, $or: [{ status: 'completed' }, { payment_status: 'COMPLETE' }] }).toArray(),
      db.collection('seller_withdrawals').find({ sellerId, status: { $in: ['pending', 'completed'] } }).toArray()
    ]);
    const totalEarnings = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const totalWithdrawn = pastWithdrawals.reduce((s, w) => s + (Number(w.amount) || 0), 0);
    const availableBalance = Math.max(0, totalEarnings - totalWithdrawn);

    if (Number(amount) > availableBalance) {
      return res.status(400).json({ error: `Amount exceeds available balance of KES ${availableBalance.toLocaleString()}` });
    }

    await db.collection('seller_withdrawals').insertOne({
      sellerId,
      amount: Number(amount),
      phone: payoutMethod === 'mpesa' ? String(phone).trim() : '',
      payoutMethod: String(payoutMethod).trim(),
      accountNumber: payoutMethod !== 'mpesa' ? String(accountNumber).trim() : '',
      accountName: payoutMethod !== 'mpesa' ? String(accountName).trim() : '',
      status: 'pending',
      requestedAt: new Date()
    });

    // Notify seller
    const _sLbl = payoutMethod === 'kcb' ? 'KCB Bank' : payoutMethod === 'equity' ? 'Equity Bank' : 'M-Pesa';
    const _sDest = payoutMethod === 'mpesa' ? String(phone).trim() : `${String(accountNumber).trim()} (${String(accountName).trim()})`;
    db.collection('notifications').insertOne({ user_id: String(req.userId), role: 'seller', type: 'withdrawal_submitted', title: 'Withdrawal Request Submitted', message: `Your KES ${Number(amount).toLocaleString()} withdrawal via ${_sLbl} ${_sDest} is pending admin review. No commission deducted — full amount will be sent.`, read: false, created_at: new Date() }).catch(() => {});
    // Notify admin
    db.collection('notifications').insertOne({ user_id: 'admin', role: 'admin', type: 'withdrawal_request', title: 'New Seller Withdrawal', message: `Seller (ID: ...${String(req.userId).slice(-6)}) requested KES ${Number(amount).toLocaleString()} via ${_sLbl} ${_sDest}.`, read: false, created_at: new Date() }).catch(() => {});

    return res.json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (err) {
    console.error('Seller withdraw error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/seller/promote  — seller pays to promote product to homepage slider
app.post('/api/seller/promote', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const { productId, paymentRef, days = 7 } = req.body;
    if (!productId) return res.status(400).json({ error: 'productId is required' });
    if (!paymentRef) return res.status(400).json({ error: 'paymentRef is required' });

    const product = await db.collection('properties').findOne({ _id: new ObjectId(productId) });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (String(product.seller_id) !== String(req.user._id))
      return res.status(403).json({ error: 'Not your product' });
    if (!product.active) return res.status(400).json({ error: 'Product must be approved/active before promoting' });

    const order = await db.collection('orders').findOne({ order_id: paymentRef });
    if (!order) {
      return res.status(400).json({ error: 'Promotion payment order not found' });
    }
    if (order.payment_status !== 'COMPLETE') {
      return res.status(400).json({ error: 'Promotion payment has not completed yet' });
    }

    const expiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const imgUrl = product.imageUrl || product.image_url || (product.images && product.images[0]) || '';

    const slider = {
      title:       product.title,
      subtitle:    product.description ? product.description.slice(0, 80) : '',
      imageUrl:    imgUrl,
      image_url:   imgUrl,
      buttonText:  'Shop Now',
      buttonLink:  `/products.html?id=${productId}`,
      active:      true,
      promoted:    true,
      seller_id:   String(req.user._id),
      seller_name: req.user.name || req.user.full_name || '',
      productId:   productId,
      paymentRef:  paymentRef,
      expiresAt:   expiry,
      durationDays: days,
      order:       999,
      created_at:  new Date()
    };

    const result = await db.collection('sliders').insertOne(slider);
    await db.collection('properties').updateOne(
      { _id: new ObjectId(productId) },
      { $set: { promoted: true, promotedUntil: expiry } }
    );
    return res.json({ success: true, slider: { ...slider, _id: result.insertedId }, expiresAt: expiry });
  } catch (err) {
    console.error('Seller promote error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/seller/orders  — seller's orders
app.get('/api/seller/orders', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const sellerId = req.user ? String(req.user._id) : null;
    const query = sellerId ? { seller_id: sellerId } : {};
    const orders = await db.collection('orders')
      .find(query)
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    return res.json({ success: true, orders });
  } catch (err) {
    console.error('Seller orders error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

//  EVENTS & TICKETS 

// GET /api/events — public listing
app.get('/api/events', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, events: [] });
    const { category, limit = 100 } = req.query;
    const query = { active: true };
    if (category && category !== 'all') {
      query.category = { $regex: new RegExp(category, 'i') };
    }
    const events = await db.collection('events')
      .find(query)
      .sort({ event_date: 1, created_at: -1 })
      .limit(parseInt(limit))
      .toArray();
    return res.json({ success: true, events });
  } catch (err) {
    console.error('Events fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/events/:id — single event
app.get('/api/events/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const event = await db.collection('events').findOne({ _id: new ObjectId(req.params.id) });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    return res.json({ success: true, event });
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/events/:id/buy-ticket — buy ticket
app.post('/api/events/:id/buy-ticket', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const event = await db.collection('events').findOne({ _id: new ObjectId(req.params.id) });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const qty = parseInt(req.body.quantity) || 1;
    const ticketsLeft = event.tickets_available !== undefined && event.tickets_available !== null
      ? event.tickets_available - (event.tickets_sold || 0)
      : Infinity;

    if (ticketsLeft < qty) {
      return res.status(400).json({ error: `Only ${ticketsLeft} ticket(s) left` });
    }
    if (event.status === 'sold_out' || event.status === 'cancelled') {
      return res.status(400).json({ error: 'Event is not available for booking' });
    }

    const ticketCode = 'TKT-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).toUpperCase().slice(2,6);
    const ticketDoc = {
      event_id: event._id,
      event_title: event.title,
      quantity: qty,
      ticket_code: ticketCode,
      buyer_name: req.body.buyer_name || 'Guest',
      buyer_email: req.body.buyer_email || '',
      buyer_phone: req.body.buyer_phone || '',
      total_amount: (event.ticket_price || 0) * qty,
      status: 'confirmed',
      created_at: new Date()
    };

    await db.collection('tickets').insertOne(ticketDoc);
    await db.collection('events').updateOne(
      { _id: event._id },
      { $inc: { tickets_sold: qty }, $set: { updated_at: new Date() } }
    );

    const newSold = (event.tickets_sold || 0) + qty;
    if (event.tickets_available && newSold >= event.tickets_available) {
      await db.collection('events').updateOne({ _id: event._id }, { $set: { status: 'sold_out' } });
    }

    return res.json({ success: true, ticket_code: ticketCode, ticket: ticketDoc });
  } catch (err) {
    console.error('Buy ticket error:', err);
    return res.status(500).json({ error: 'Failed to process ticket purchase' });
  }
});

// POST /api/admin/events — create event (admin)
app.post('/api/admin/events', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { title, description, event_date, venue, location, category, ticket_price, tickets_available, organizer, imageUrl, images } = req.body;
    if (!title || !event_date) return res.status(400).json({ error: 'Title and event date are required' });
    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : []);
    const doc = {
      title: title.trim(),
      description: (description || '').trim(),
      event_date: new Date(event_date),
      venue: (venue || '').trim(),
      location: (location || '').trim(),
      category: (category || 'Other').trim(),
      ticket_price: parseFloat(ticket_price) || 0,
      tickets_available: tickets_available ? parseInt(tickets_available) : null,
      tickets_sold: 0,
      organizer: (organizer || 'bConnect').trim(),
      images: imgArr,
      imageUrl: imgArr[0] || '',
      image_url: imgArr[0] || '',
      status: 'upcoming',
      active: true,
      created_at: new Date(),
      updated_at: new Date()
    };
    const result = await db.collection('events').insertOne(doc);
    return res.status(201).json({ success: true, event: { ...doc, _id: result.insertedId } });
  } catch (err) {
    console.error('Add event error:', err);
    return res.status(500).json({ error: 'Failed to add event' });
  }
});

// PUT /api/admin/events/:id — update event (admin)
app.put('/api/admin/events/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const { title, description, event_date, venue, location, category, ticket_price, tickets_available, organizer, imageUrl, images, status, active } = req.body;
    const imgArr = Array.isArray(images) ? images : (imageUrl ? [imageUrl] : undefined);
    const update = { updated_at: new Date() };
    if (title !== undefined) update.title = title.trim();
    if (description !== undefined) update.description = description.trim();
    if (event_date !== undefined) update.event_date = new Date(event_date);
    if (venue !== undefined) update.venue = venue.trim();
    if (location !== undefined) update.location = location.trim();
    if (category !== undefined) update.category = category.trim();
    if (ticket_price !== undefined) update.ticket_price = parseFloat(ticket_price) || 0;
    if (tickets_available !== undefined) update.tickets_available = tickets_available ? parseInt(tickets_available) : null;
    if (organizer !== undefined) update.organizer = organizer.trim();
    if (imgArr !== undefined) { update.images = imgArr; update.imageUrl = imgArr[0] || ''; update.image_url = imgArr[0] || ''; }
    if (status !== undefined) update.status = status;
    if (active !== undefined) update.active = !!active;
    await db.collection('events').updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/admin/events/:id — delete event (admin)
app.delete('/api/admin/events/:id', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    await db.collection('events').deleteOne({ _id: new ObjectId(req.params.id) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete event' });
  }
});

// GET /api/admin/events — admin list all events
app.get('/api/admin/events', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, events: [] });
    const events = await db.collection('events').find({}).sort({ event_date: 1, created_at: -1 }).limit(200).toArray();
    return res.json({ success: true, events });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/admin/tickets — admin list all tickets sold
app.get('/api/admin/tickets', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, tickets: [] });
    const tickets = await db.collection('tickets').find({}).sort({ created_at: -1 }).limit(200).toArray();
    return res.json({ success: true, tickets });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// GET /api/tickets/verify/:code — verify a ticket by code (public, for staff scanners)
app.get('/api/tickets/verify/:code', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const code = (req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Ticket code is required' });
    const ticket = await db.collection('tickets').findOne({ ticket_code: code });
    if (!ticket) return res.status(404).json({ valid: false, error: 'Ticket not found. Check the code and try again.' });
    const event = ticket.event_id
      ? await db.collection('events').findOne({ _id: ticket.event_id })
      : null;
    return res.json({
      valid: true,
      ticket: {
        ticket_code: ticket.ticket_code,
        event_title: ticket.event_title || event?.title || '—',
        event_date: event?.event_date || null,
        venue: event?.venue || event?.location || '—',
        buyer_name: ticket.buyer_name || 'Guest',
        buyer_phone: ticket.buyer_phone || '',
        buyer_email: ticket.buyer_email || '',
        quantity: ticket.quantity || 1,
        total_amount: ticket.total_amount || 0,
        status: ticket.status || 'confirmed',
        created_at: ticket.created_at
      }
    });
  } catch (err) {
    console.error('Ticket verify error:', err);
    return res.status(500).json({ error: 'Failed to verify ticket' });
  }
});

// PUT /api/tickets/mark-used/:code — mark a ticket as used (scanned at gate)
app.put('/api/tickets/mark-used/:code', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });
    const code = (req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Ticket code required' });
    const ticket = await db.collection('tickets').findOne({ ticket_code: code });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.status === 'used') {
      return res.json({ success: false, alreadyUsed: true, used_at: ticket.used_at, message: 'Ticket was already scanned' });
    }
    await db.collection('tickets').updateOne(
      { ticket_code: code },
      { $set: { status: 'used', used_at: new Date() } }
    );
    return res.json({ success: true, message: 'Ticket marked as used' });
  } catch (err) {
    console.error('Mark-used error:', err);
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// GET /api/organizer/events?name=... — get events by organizer name
app.get('/api/organizer/events', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, events: [] });
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ success: true, events: [] });
    const events = await db.collection('events')
      .find({ organizer: { $regex: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } })
      .sort({ event_date: 1 })
      .toArray();
    return res.json({ success: true, events });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /api/organizer/events/:id/tickets — tickets for an organizer's event
app.get('/api/organizer/events/:id/tickets', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, tickets: [] });
    const tickets = await db.collection('tickets')
      .find({ event_id: new ObjectId(req.params.id) })
      .sort({ created_at: -1 })
      .limit(500)
      .toArray();
    return res.json({ success: true, tickets });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// ============ LISTING IMAGE UPLOAD ============
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const sharp  = require('sharp');

const listingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

app.post('/api/upload/listing-image', listingUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No image file received' });

    const pipeline = sharp(req.file.buffer);
    const [mainBuf, thumbBuf] = await Promise.all([
      pipeline.clone().resize({ width: 1000, height: 1000, fit: 'cover', position: 'centre' }).jpeg({ quality: 82 }).toBuffer(),
      pipeline.clone().resize({ width: 400,  height: 400,  fit: 'cover', position: 'centre' }).jpeg({ quality: 78 }).toBuffer()
    ]);

    if (CLOUDINARY_ENABLED) {
      const [main, thumb] = await Promise.all([
        uploadToCloudinary(mainBuf, { resource_type: 'image', format: 'jpg' }),
        uploadToCloudinary(thumbBuf, { resource_type: 'image', format: 'jpg' })
      ]);
      return res.json({ success: true, url: main.secure_url, thumbUrl: thumb.secure_url });
    }

    if (!db) return res.status(503).json({ success: false, error: 'Database not connected and Cloudinary not configured' });
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    const base = 'listing-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    async function bufToGridFS(buf, filename) {
      const up = bucket.openUploadStream(filename, { contentType: 'image/jpeg' });
      await new Promise((resolve, reject) => Readable.from(buf).pipe(up).on('finish', resolve).on('error', reject));
      return up.id.toString();
    }

    const [mainId, thumbId] = await Promise.all([
      bufToGridFS(mainBuf, base + '.jpg'),
      bufToGridFS(thumbBuf, base + '_thumb.jpg')
    ]);

    res.json({ success: true, url: `/api/files/${mainId}`, thumbUrl: `/api/files/${thumbId}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const listingVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

app.post('/api/upload/listing-video', listingVideoUpload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No video file received' });

    if (CLOUDINARY_ENABLED) {
      const result = await uploadToCloudinary(req.file.buffer, { resource_type: 'video', folder: 'bconnect/videos' });
      return res.json({ success: true, url: result.secure_url });
    }

    if (!db) return res.status(503).json({ success: false, error: 'Database not connected and Cloudinary not configured' });
    const ext = path.extname(req.file.originalname) || '.mp4';
    const filename = 'listing-video-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    const up = bucket.openUploadStream(filename, { contentType: req.file.mimetype });
    await new Promise((resolve, reject) => Readable.from(req.file.buffer).pipe(up).on('finish', resolve).on('error', reject));
    res.json({ success: true, url: `/api/files/${up.id.toString()}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ AI LISTING DESCRIPTION ============
app.post('/api/ai/listing-description', async (req, res) => {
  try {
    const { name, category, subcategory, price } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Listing name is required' });

    const catLabel = { product: 'product', service: 'service', housing: 'property/rental' }[category] || category || 'listing';
    const pricePart = price ? `, priced at KES ${Number(price).toLocaleString()}` : '';
    const subPart   = subcategory ? ` (${subcategory})` : '';

    const prompt = `Write a concise, compelling product/listing description for a Kenya-based marketplace called BConnect.

Item: ${name}
Type: ${catLabel}${subPart}${pricePart}

Requirements:
- 2–4 sentences, plain text (no markdown, no bullet points, no headings)
- Highlight key benefits and appeal to Kenyan buyers
- Professional and persuasive tone
- End with a brief call-to-action

Return ONLY the description text, nothing else.`;

    const result = await generateGeminiResponse(prompt, 'listing-description', { name, category, price });
    if (!result) return res.status(503).json({ success: false, error: 'AI unavailable, please try again later' });
    res.json({ success: true, description: result.trim() });
  } catch (e) {
    console.error('AI listing description error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ BROADCAST EMAIL ============
const broadcastUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB to accommodate video
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only image or video files are allowed'));
  }
});

app.post('/api/admin/broadcast-email', broadcastUpload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not connected' });

    const { role, subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

    const query = (role && role !== 'all') ? { role, email: { $exists: true, $ne: '' } } : { email: { $exists: true, $ne: '' } };
    const users = await db.collection('profiles').find(query).toArray();
    const recipients = users.filter(u => u.email && u.email.includes('@'));

    if (recipients.length === 0) return res.json({ success: true, sent: 0, skipped: 0, failed: 0 });

    const { sendEmail } = require('./email');
    let sent = 0, failed = 0, skipped = 0;

    const attachments = [];
    let imageHtml = '';
    let videoHtml = '';

    // Image attachment (embedded inline)
    const imageFile = req.files?.image?.[0];
    if (imageFile) {
      const cid = 'broadcast-image@bconnect';
      attachments.push({ filename: imageFile.originalname, content: imageFile.buffer, contentType: imageFile.mimetype, cid });
      imageHtml = `<div style="text-align:center;margin:16px 0"><img src="cid:${cid}" alt="Attachment" style="max-width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)"></div>`;
    }

    // Video attachment (sent as file attachment — email clients don't render video)
    const videoFile = req.files?.video?.[0];
    if (videoFile) {
      attachments.push({ filename: videoFile.originalname || 'promo-video.webm', content: videoFile.buffer, contentType: videoFile.mimetype });
      videoHtml = `<div style="background:#f0f4ff;border:1px solid #c7d2fe;border-radius:10px;padding:14px 18px;margin:16px 0;text-align:center">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#3730a3">🎬 Video Attached</p>
        <p style="margin:0;font-size:13px;color:#6366f1">${videoFile.originalname || 'promo-video.webm'} has been attached to this email.</p>
      </div>`;
    }

    for (const user of recipients) {
      if (!user.email) { skipped++; continue; }
      const name = user.full_name || user.name || 'BConnect User';
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body{margin:0;padding:0;background:#f4f4f7;font-family:'Segoe UI',Arial,sans-serif}
        .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
        .header{background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:28px 32px;text-align:center}
        .header h1{margin:0;color:#fff;font-size:22px;font-weight:800}
        .header p{margin:6px 0 0;color:rgba(255,255,255,.8);font-size:13px}
        .body{padding:28px 32px;color:#374151;font-size:15px;line-height:1.7}
        .footer{background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;font-size:12px;color:#9ca3af}
      </style></head><body>
      <div class="wrap">
        <div class="header"><h1>BConnect</h1><p>Kenya's Property & Marketplace Platform</p></div>
        <div class="body">
          <p>Hi <strong>${name}</strong>,</p>
          ${message.replace(/\n/g,'<br>')}
          ${imageHtml}
          ${videoHtml}
        </div>
        <div class="footer">© ${new Date().getFullYear()} BConnect · Nairobi, Kenya<br>This email was sent to all ${role && role !== 'all' ? role + 's' : 'BConnect users'}.</div>
      </div></body></html>`;
      const text = `Hi ${name},\n\n${message}${videoFile ? '\n\n[A promo video has been attached to this email]' : ''}`;
      const ok = await sendEmail(user.email, subject, text, html, attachments.length ? attachments : undefined);
      if (ok) sent++; else failed++;
    }

    const notes = [imageFile ? `image: ${imageFile.originalname}` : '', videoFile ? `video: ${videoFile.originalname}` : ''].filter(Boolean).join(', ');
    console.log(`[broadcast] Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}${notes ? ` (+${notes})` : ''} — "${subject}"`);
    res.json({ success: true, sent, failed, skipped, hasImage: !!imageFile, hasVideo: !!videoFile });
  } catch (err) {
    console.error('[broadcast] Error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast email', details: err.message });
  }
});
// ============ END BROADCAST EMAIL ============

// 
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.warn(`Request error [${req.method} ${req.url}]:`, err && err.message ? err.message : err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
(async () => {
  const connected = await connectToMongoDB();
  app.listen(PORT, '0.0.0.0', async () => {
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
    }
    console.log(`\n[OK] Server running on port ${PORT}${connected ? '' : ' (degraded mode)'}`);
    console.log(`[LOCAL]  Access from this device: http://localhost:${PORT}`);
    console.log(`[NETWORK] Access from other devices: http://${localIP}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    if (connected) {
      console.log('Connected to MongoDB Atlas\n');
      try { await initializeDefaultCategories(); } catch (e) { console.warn('Category init skipped:', e.message); }
    } else {
      console.log('Database features are disabled until MONGODB_URI is configured.\n');
    }

    if (waBot) {
      setTimeout(async () => {
        try {
          await waBot.startBot(db, genAI);
          console.log('[WhatsApp Bot] Initialised — scan QR at /whatsapp-qr.html');
        } catch (e) {
          console.warn('[WhatsApp Bot] Failed to start:', e.message);
        }
      }, 2000);
    }
  });
})();

// ═══════════════════════════════════════════════
//  EVENT SUBMISSIONS (public organizer portal)
// ═══════════════════════════════════════════════

// POST /api/events/submit — public organizer submits event for admin review
app.post('/api/events/submit', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });

    const {
      title, description, event_date, venue, location, category,
      ticket_price, tickets_available, imageUrl,
      organizer_name, organizer_email, organizer_phone
    } = req.body;
    if (!title || !event_date || !organizer_name || !organizer_email) {
      return res.status(400).json({ error: 'Title, date, organizer name and email are required' });
    }
    const doc = {
      title: title.trim(),
      description: (description || '').trim(),
      event_date: new Date(event_date),
      venue: (venue || '').trim(),
      location: (location || '').trim(),
      category: (category || 'Other').trim(),
      ticket_price: parseFloat(ticket_price) || 0,
      tickets_available: tickets_available ? parseInt(tickets_available) : null,
      imageUrl: (imageUrl || '').trim(),
      organizer: organizer_name.trim(),
      organizer_name: organizer_name.trim(),
      organizer_email: organizer_email.trim().toLowerCase(),
      organizer_phone: (organizer_phone || '').trim(),
      status: 'pending',
      submitted_at: new Date(),
      updated_at: new Date()
    };
    const result = await db.collection('event_submissions').insertOne(doc);

    // Auto-assign organizer role to the submitting user (matched by email)
    try {
      if (organizer_email) {
        await db.collection('profiles').updateOne(
          { email: organizer_email.trim().toLowerCase(), role: { $ne: 'admin' } },
          { $set: { role: 'organizer', updated_at: new Date() } }
        );
      }
    } catch (_) {}

    return res.status(201).json({ success: true, submissionId: result.insertedId, message: 'Event submitted for review' });
  } catch (err) {
    console.error('Event submit error:', err);
    return res.status(500).json({ error: 'Failed to submit event' });
  }
});

// GET /api/admin/event-submissions — admin view pending submissions
app.get('/api/admin/event-submissions', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, submissions: [] });
    const submissions = await db.collection('event_submissions').find({}).sort({ submitted_at: -1 }).toArray();
    return res.json({ success: true, submissions });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

// PUT /api/admin/event-submissions/:id/approve — approve and publish
app.put('/api/admin/event-submissions/:id/approve', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    const sub = await db.collection('event_submissions').findOne({ _id: new ObjectId(req.params.id) });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });
    const imgArr = sub.imageUrl ? [sub.imageUrl] : [];
    const eventDoc = {
      title: sub.title, description: sub.description, event_date: sub.event_date,
      venue: sub.venue, location: sub.location, category: sub.category,
      ticket_price: sub.ticket_price, tickets_available: sub.tickets_available,
      tickets_sold: 0, organizer: sub.organizer_name,
      images: imgArr, imageUrl: sub.imageUrl || '', image_url: sub.imageUrl || '',
      status: 'upcoming', active: true,
      created_at: new Date(), updated_at: new Date()
    };
    const result = await db.collection('events').insertOne(eventDoc);
    await db.collection('event_submissions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'approved', event_id: result.insertedId, updated_at: new Date() } }
    );
    return res.json({ success: true, eventId: result.insertedId });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to approve submission' });
  }
});

// PUT /api/admin/event-submissions/:id/reject — reject submission
app.put('/api/admin/event-submissions/:id/reject', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'DB not connected' });
    await db.collection('event_submissions').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'rejected', rejection_reason: req.body.reason || '', updated_at: new Date() } }
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reject submission' });
  }
});

// GET /api/admin/users-list — lightweight list of all users for dropdowns (id, name, email, role)
app.get('/api/admin/users-list', async (req, res) => {
  try {
    if (!db) return res.json({ success: true, users: [] });
    const users = await db.collection('profiles')
      .find({}, { projection: { full_name: 1, email: 1, role: 1 } })
      .sort({ full_name: 1 })
      .toArray();
    return res.json({ success: true, users });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users list' });
  }
});

// ── AUTO-CLEANUP: delete unverified accounts whose token expired > 7 days ago ──
function scheduleUnverifiedCleanup() {
  async function runCleanup() {
    if (!db) return;
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await db.collection('profiles').deleteMany({
        email_verified: false,
        verification_token_expires: { $lt: cutoff }
      });
      if (result.deletedCount > 0) {
        console.log(`[cleanup] Removed ${result.deletedCount} expired unverified account(s)`);
      }
    } catch (e) {
      console.warn('[cleanup] Failed to clean unverified accounts:', e.message);
    }
  }
  // Run once at startup (after 30s to let DB connect), then every 6 hours
  setTimeout(runCleanup, 30000);
  const t = setInterval(runCleanup, 6 * 60 * 60 * 1000);
  if (t.unref) t.unref();
  console.log('[cleanup] Unverified account cleanup scheduled (every 6h, 7-day expiry grace period)');
}
scheduleUnverifiedCleanup();
