'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
let mongoClient = null;
let database = null;

async function getDb() {
  if (database) return database;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  mongoClient = new MongoClient(process.env.MONGODB_URI);
  await mongoClient.connect();
  database = mongoClient.db();
  return database;
}

function userView(user, roleOverride) {
  return {
    id: String(user._id),
    name: user.fullName || user.full_name || user.name || user.email,
    email: user.email,
    phone: user.phone || '',
    role: roleOverride || user.role || 'user'
  };
}

function configuredAdminEmails() {
  return String(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function isConfiguredAdmin(email) {
  return configuredAdminEmails().includes(String(email || '').trim().toLowerCase());
}

function signToken(user, roleOverride) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const view = userView(user, roleOverride);
  return jwt.sign({ sub: view.id, email: view.email, role: view.role }, secret, { expiresIn: '7d' });
}

function authConfigError() {
  const missing = [];
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  return missing.length ? `Authentication is not configured. Add ${missing.join(' and ')} to the deployment environment.` : null;
}

function databaseErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/bad auth|authentication failed|ไม่ถูกต้อง|auth failed/i.test(message)) {
    return 'Database authentication failed. Check the MongoDB username, password, database name, and URL-encode special characters in the password.';
  }
  if (/ENOTFOUND|timed out|ETIMEOUT|ECONNREFUSED|querySrv/i.test(message)) {
    return 'Database connection failed. Check the MongoDB cluster hostname, network access rules, and MONGODB_URI.';
  }
  return 'Database service is unavailable. Check MONGODB_URI and the deployment logs.';
}

// Temporary rollout setting: allow users to sign in without email verification.
// Re-enable by setting DISABLE_EMAIL_VERIFICATION=false in deployment secrets.
const EMAIL_VERIFICATION_DISABLED = String(process.env.DISABLE_EMAIL_VERIFICATION || 'true').toLowerCase() !== 'false';

async function findUserByEmail(email, role) {
  const db = await getDb();
  const normalized = String(email || '').trim().toLowerCase();
  const collections = role === 'landlord' ? ['landlords'] : role === 'tenant' ? ['tenants'] : ['users', 'profiles', 'landlords', 'tenants'];
  for (const name of collections) {
    const user = await db.collection(name).findOne({ email: normalized });
    if (user) return { user, role: role || user.role || (name === 'landlords' ? 'landlord' : name === 'tenants' ? 'tenant' : 'user') };
  }
  return null;
}

async function authenticate(email, password, role) {
  const found = await findUserByEmail(email, role);
  if (!found) return { ok: false, status: 401, error: 'Invalid email or password.' };
  const stored = found.user.password || found.user.passwordHash || found.user.password_hash;
  const valid = stored && await bcrypt.compare(String(password || ''), String(stored));
  if (!valid) return { ok: false, status: 401, error: 'Invalid email or password.' };
  const effectiveRole = isConfiguredAdmin(found.user.email) ? 'admin' : found.role;
  const view = userView(found.user, effectiveRole);
  if (!EMAIL_VERIFICATION_DISABLED && (found.user.emailVerified === false || found.user.email_verified === false)) {
    return { ok: false, status: 403, error: 'Please verify your email before signing in.', requiresVerification: true, email: view.email };
  }
  return { ok: true, success: true, token: signToken(found.user, effectiveRole), user: view, role: view.role };
}

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  }
}));

async function loginHandler(req, res, role) {
  try {
    const configError = authConfigError();
    if (configError) return res.status(503).json({ error: configError });
    const result = await authenticate(req.body.email, req.body.password, role);
    return res.status(result.ok ? 200 : result.status).json(result);
  } catch (error) {
    console.error('[Auth] Login failed:', error.message);
    return res.status(503).json({ error: databaseErrorMessage(error) });
  }
}

app.post('/api/auth/login', (req, res) => loginHandler(req, res));
app.post('/api/landlord/login', (req, res) => loginHandler(req, res, 'landlord'));
app.post('/api/tenant/login', (req, res) => loginHandler(req, res, 'tenant'));

app.post('/api/auth/register', async (req, res) => {
  try {
    const configError = authConfigError();
    if (configError) return res.status(503).json({ success: false, error: configError });
    const email = String(req.body.email || '').trim().toLowerCase();
    const fullName = String(req.body.fullName || '').trim();
    const password = String(req.body.password || '');
    const phone = String(req.body.phone || '').trim();
    if (!email || !fullName || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Name, email, and a password of at least 6 characters are required.' });
    }
    const db = await getDb();
    const existing = await db.collection('users').findOne({ email });
    if (existing) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    const user = {
      fullName,
      email,
      phone,
      role: isConfiguredAdmin(email) ? 'admin' : 'user',
      password: await bcrypt.hash(password, 12),
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const inserted = await db.collection('users').insertOne(user);
    user._id = inserted.insertedId;
    const role = user.role;
    const view = userView(user, role);
    return res.status(201).json({ success: true, token: signToken(user, role), user: view });
  } catch (error) {
    console.error('[Auth] Registration failed:', error.message);
    return res.status(503).json({ success: false, error: databaseErrorMessage(error) });
  }
});

function queryLimit(req, fallback = 50) {
  const value = Number.parseInt(req.query.limit, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 100) : fallback;
}

async function safeCollectionFind(collectionName, filter, req) {
  try {
    const db = await getDb();
    return await db.collection(collectionName)
      .find(filter || {})
      .sort({ created_at: -1, createdAt: -1, event_date: 1 })
      .limit(queryLimit(req))
      .toArray();
  } catch (error) {
    console.error(`[API] ${collectionName} lookup failed:`, error.message);
    return [];
  }
}

app.get('/api/products', async (req, res) => {
  const filter = { active: { $ne: false }, listing_type: { $nin: ['service', 'housing'] } };
  if (req.query.category) filter.category = { $regex: String(req.query.category), $options: 'i' };
  if (req.query.location) filter.location = { $regex: String(req.query.location), $options: 'i' };
  return res.json({ success: true, products: await safeCollectionFind('properties', filter, req) });
});

app.get('/api/services', async (req, res) => {
  const filter = { active: { $ne: false }, $or: [{ listing_type: 'service' }, { category: { $regex: /service/i } }] };
  return res.json({ success: true, services: await safeCollectionFind('properties', filter, req) });
});

app.get('/api/events', async (req, res) => {
  return res.json({ success: true, events: await safeCollectionFind('events', { active: { $ne: false } }, req) });
});

app.get('/api/properties', async (req, res) => {
  return res.json({ success: true, properties: await safeCollectionFind('properties', { active: { $ne: false } }, req) });
});

app.get('/api/housing', async (req, res) => {
  const rows = await safeCollectionFind('landlord_properties', { status: { $ne: 'inactive' } }, req);
  return res.json({ success: true, properties: rows, housing: rows });
});

app.get('/api/homepage', async (req, res) => {
  const [products, services, events, properties] = await Promise.all([
    safeCollectionFind('properties', { active: { $ne: false }, listing_type: { $nin: ['service', 'housing'] } }, req),
    safeCollectionFind('properties', { active: { $ne: false }, listing_type: 'service' }, req),
    safeCollectionFind('events', { active: { $ne: false } }, req),
    safeCollectionFind('landlord_properties', { status: { $ne: 'inactive' } }, req)
  ]);
  return res.json({ success: true, products, services, events, properties, featured: products.slice(0, 8) });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bconnect',
    whatsappBotEnabled: String(process.env.WHATSAPP_BOT_ENABLED).toLowerCase() === 'true',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, service: 'bconnect' });
});

// Compatibility layer for frontend modules that were shipped before the backend
// was restored. These responses keep pages usable while individual feature
// handlers are added; public reads return empty collections rather than 404s.
app.use('/api', (req, res, next) => {
  if (!req.path || req.path === '/health' || req.path === '/status') return next();
  const route = req.path.toLowerCase();
  if (req.method === 'GET') {
    if (/\/notifications|\/orders|\/products|\/services|\/events|\/properties|\/payments|\/withdrawals|\/submissions|\/tickets|\/users|\/sellers|\/landlords|\/tenants|\/organizers|\/featured|\/stats|\/dashboard|\/homepage|\/profile/.test(route)) {
      return res.json({ success: true, data: [], items: [], products: [], services: [], events: [], properties: [], users: [], notifications: [], orders: [], payments: [], withdrawals: [], stats: {} });
    }
    if (/\/ai\//.test(route)) return res.json({ success: true, reply: '', text: '', result: null });
    return res.json({ success: true, data: [] });
  }
  if (/\/auth\/(forgot-password|resend-verification|reset-password|2fa)|\/events\/submit|\/buy-ticket|\/upload\//.test(route)) {
    return res.status(503).json({ success: false, error: 'This feature is temporarily unavailable.' });
  }
  return res.status(503).json({ success: false, error: 'This API feature is temporarily unavailable.' });
});

app.use(express.static(ROOT, {
  extensions: ['html'],
  index: 'website.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found' });
  return next();
});

app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'website.html')));

app.use((error, _req, res, _next) => {
  console.error('[Server]', error.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BConnect] Server listening on port ${PORT}`);
});

async function startWhatsAppBot() {
  if (String(process.env.WHATSAPP_BOT_ENABLED).toLowerCase() !== 'true') return;
  try {
    const bot = require('./whatsapp-bot');
    await bot.startBot(null);
    console.log('[BConnect] WhatsApp bot started');
  } catch (error) {
    console.error('[BConnect] WhatsApp bot failed to start:', error.message);
  }
}

startWhatsAppBot();

function shutdown(signal) {
  console.log(`[BConnect] ${signal} received; shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
