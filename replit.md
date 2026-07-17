# BConnect

All-in-one digital platform connecting people, businesses, landlords, tenants, service providers, and event organizers.

## Stack

- **Frontend**: Plain HTML/CSS/JS pages (no build step)
- **Backend**: Node.js + Express (`server.js`)
- **Database**: MongoDB Atlas (required)
- **Image storage**: MongoDB GridFS (default) or Cloudinary (optional)
- **Payments**: M-Pesa STK push (optional)
- **AI assistant**: OpenAI-compatible (xAI Grok, optional)
- **Messaging**: WhatsApp bot via Baileys (optional), Africa's Talking SMS (optional)

## How to run

```bash
npm install
node server.js   # or: npm start
```

The workflow `Start application` runs `PORT=5000 node server.js`.

## Required secrets

| Secret | Purpose |
|--------|---------|
| `MONGODB_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | JWT signing secret for auth |

## Optional secrets

| Secret | Purpose |
|--------|---------|
| `EMAIL_USER` / `EMAIL_PASS` | Gmail/Nodemailer for transactional email |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary CDN for images |
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` / `MPESA_SHORTCODE` / `MPESA_PASSKEY` / `MPESA_CALLBACK_URL` | M-Pesa payments |
| `XAI_API_KEY` | AI assistant (xAI Grok) |
| `AT_USERNAME` / `AT_API_KEY` | Africa's Talking SMS |
| `ADMIN_SETUP_KEY` | Admin account bootstrap |

## Key files

- `server.js` — main Express server with all API routes
- `email.js` — Nodemailer email helpers
- `sms.js` — Africa's Talking SMS helper
- `api-client.js` — frontend JS API wrapper
- `*.html` — frontend pages (index, login, admin, housing, events, orders, etc.)
- `global.css` — shared styles

## Admin dashboard

Visit `/admin.html` to access the admin panel. To create the first admin account, call:

```
POST /api/admin/setup
{ "email": "...", "password": "...", "fullName": "...", "secretKey": "<ADMIN_SETUP_KEY>" }
```

`ADMIN_SETUP_KEY` must be set as a secret. If the email already exists, it promotes that user to admin.

## Known fixes

- **Admin page was empty**: The `api()` helper in `admin.html` was not sending the Authorization header, causing all `/api/admin/*` calls to fail with 401/403 silently. Fixed — the token from `localStorage` is now included in every request.

## User preferences

- Keep the existing HTML/CSS/JS + Node.js/Express/MongoDB stack — do not migrate or restructure without asking.
