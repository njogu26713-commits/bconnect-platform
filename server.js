'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

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
