# BConnect

A full-stack marketplace and property platform built with Node.js/Express, MongoDB, and plain HTML/CSS/JS.

## Features

- **Marketplace** — product listings, seller dashboards, cart, orders, payments
- **Housing / Rentals** — landlord & tenant dashboards, rent payments, property listings
- **Events** — organiser dashboard, ticket verification
- **AI Assistant** — Grok (xAI) powered chat (requires `XAI_API_KEY`)
- **WhatsApp Bot** — optional Baileys-based bot (enable with `WHATSAPP_BOT_ENABLED=true`)
- **M-Pesa Payments** — STK push (requires Safaricom sandbox/live credentials)

## How to run

```
PORT=5000 node server.js
```

The workflow `Start application` is already configured and starts on port 5000.

## Required secrets

| Secret | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string (required) |
| `JWT_SECRET` | JWT signing secret (defaults to an insecure placeholder — set in production) |

## Optional secrets

| Secret | Purpose |
|---|---|
| `EMAIL_USER` | Gmail/SMTP username for transactional email |
| `EMAIL_PASS` | Gmail/SMTP password or app-password |
| `XAI_API_KEY` | xAI (Grok) API key for AI assistant |
| `MPESA_CONSUMER_KEY` | Safaricom M-Pesa consumer key |
| `MPESA_CONSUMER_SECRET` | Safaricom M-Pesa consumer secret |
| `MPESA_SHORTCODE` | M-Pesa business shortcode |
| `MPESA_PASSKEY` | M-Pesa passkey |
| `MPESA_CALLBACK_URL` | Public callback URL for M-Pesa STK push |

## Stack

- **Backend**: Node.js, Express
- **Database**: MongoDB Atlas (via native driver)
- **Auth**: JWT (`jsonwebtoken`) + bcrypt
- **Email**: Nodemailer
- **Payments**: M-Pesa STK push (Safaricom), auto-succeeds if keys not set
- **AI**: xAI Grok via OpenAI-compatible SDK; Gemini as fallback
- **File storage**: MongoDB GridFS

## User preferences

<!-- Add your preferences here -->
