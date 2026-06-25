# BConnect

A Node.js/Express application that serves the BConnect property + marketplace site (HTML pages from the project root) and a JSON API for products, orders, profiles, payments, and tenant features.

## Stack
- Runtime: Node.js 20
- Server: Express 4 (`server.js`) serving static HTML files in the project root
- Optional services (only used if their env vars are set):
  - MongoDB Atlas (`MONGODB_URI`) — primary data store
  - Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) — auxiliary storage
  - Google Gemini (`GEMINI_API_KEY`) — AI assistant endpoints (model: gemini-2.5-flash)
  - M-Pesa Daraja (`MPESA_*`) — STK push payments
  - Nodemailer/Gmail SMTP (`EMAIL_USER`, `EMAIL_PASS`) — transactional email

## Email System (`email.js`)
- Reusable `sendEmail(to, subject, text, html)` function — non-blocking, logs success/failure
- Gmail SMTP via Nodemailer; requires `EMAIL_USER` (Gmail address) + `EMAIL_PASS` (App Password)
- If credentials are missing the server starts normally and email is silently skipped
- HTML templates: `welcomeEmail`, `passwordResetEmail`, `paymentReceiptEmail`, `bookingConfirmationEmail`

### Email Triggers
| Event | Template | When fired |
|---|---|---|
| New registration | Welcome | After successful `POST /api/auth/register` |
| Payment completed | Receipt | Inside `updateOrderStatus()` when M-Pesa callback = COMPLETE |
| Password reset request | Reset link (15 min expiry) | `POST /api/auth/forgot-password` |
| Viewing booked | Booking confirmation | `POST /api/bookings/viewing` |

### Password Reset Flow
1. User visits `/reset-password.html` → enters email → `POST /api/auth/forgot-password`
2. Server generates 32-byte token, stores with 15-min expiry in `profiles` collection
3. Email sent with link: `/reset-password.html?token=<token>`
4. User clicks link → page switches to "Set New Password" view → `POST /api/auth/reset-password`
5. Token validated, password hashed (bcrypt), token cleared from DB

## Replit setup
- Workflow `Start application`: `PORT=5000 node server.js` (webview, port 5000)
- The Express app trusts the Replit proxy (`app.set('trust proxy', 1)`) so the rate limiter works behind the iframe proxy.
- `app.listen` binds to `0.0.0.0` and uses `process.env.PORT`.
- When the optional services above are not configured the server starts in degraded mode and the API endpoints return safe empty responses.

## Shared header & footer
- Every HTML page loads `/shared-layout.js?v=N` (cache-busted by version) just before `</body>`.
- The script removes any pre-existing `<header>`, `<nav>`, `<footer>`, `.topbar`, `.mobile-menu`, etc., wraps the page's original body content in `<div id="bc-page-content">` (preserving any flex/grid layout the page used on `<body>`), then prepends a single shared header and appends a single shared footer.
- Nav links: Home, Solutions, Features, Marketplace, Services, Landlord, Tenant, About, Support, Login. Active link is highlighted automatically based on the current filename.
- To change the header/footer site-wide, edit `shared-layout.js` and bump the `?v=N` query string in the script tag of every HTML page (a small Python loop is the easiest way).

## Dev caching & rate limits
- In development, HTML pages and `/shared-layout.js` are sent with `Cache-Control: no-store` so edits show up immediately. In production, normal static caching applies.
- The global rate limiter only throttles mutating requests (POST/PUT/PATCH/DELETE); GET/HEAD requests for pages, static assets, and read-only APIs are not rate limited, so screenshot/preview reloads don't trip 429s.

## Deployment
- Target: `autoscale`
- Run command: `node server.js`


  ## Tenant property dashboard (personalized, laptop-optimized)
  After a tenant links a property, the dashboard transforms into a clean, modern, laptop-optimized space (no bottom nav). Sections are stacked vertically inside a wider container (`max-width: 1280px` via `body.has-property-dashboard`):
  1. **Welcome section** — eyebrow, "Welcome back, {name}", a green animated *Active Tenant* status pill, and a unit + property summary line.
  2. **Featured property card** — image side (gradient + building icon fallback, or `prop.imageUrl`/`image`/`propertyImage` if present) and an info side with property name, location, code, optional unit, and a landlord bar with avatar, name, phone, and Call / Message quick-action buttons. Message routes to the Messages tab.
  3. **Horizontal page navigation** — full-width segmented buttons (Rent, Announcements, Maintenance, Messages, History). Active item gets the brand gradient.
  4. **Rent panel** — gradient hero with "Amount Due This Month", status badge, next due date, prominent green **Pay Now via M-Pesa** button and **Set Reminder**. Below it a 3-up grid of *Last Payment*, *Current Balance* (rent − completed payments this month), *Payment Status*. Below that a *Recent Updates from Landlord* card showing the 3 latest announcements with a "View all →" link to the Announcements tab.
  5. **Other tabs** — Announcements (full list), Maintenance (form + tracked list), Messages (per-property chat with landlord), History (combined activity feed).
  - **Auto-select** — if exactly one property is linked, the tenant lands on it directly (no list step).

  ### New backend endpoints (server.js, MongoDB)
  - `GET  /api/tenant/properties/:id/requests` — tenant's repair/complaint history with status.
  - `GET  /api/tenant/properties/:id/announcements` — read announcements for a linked property.
  - `POST /api/landlord/properties/:id/announcements` — landlord posts an announcement (`{title, body}`).
  - `GET  /api/landlord/properties/:id/announcements` — landlord lists their property announcements.
  - `GET/POST /api/tenant/properties/:id/messages` — tenant chat thread with landlord.
  - `GET/POST /api/landlord/properties/:id/messages` — landlord side of the same thread (`POST` body needs `tenantId`).

  Collections used: `announcements`, `property_messages`, plus existing `maintenance_requests`. Both helper functions `tenantOwnsProperty` and `landlordOwnsProperty` enforce per-property authorization.
  

  ## Landlord property dashboard (announcements + chat)
  On the property dashboard:
  - **Announcements card** — title + body composer; lists every announcement landlord has sent for that property.
  - **Linked Tenants card** — tenant name, rent, phone, link date, plus a **Message** button per tenant.
  - **Maintenance & Complaints card** — list of incoming requests with Mark In Progress / Mark Resolved (existing).
  - **Chat modal** — slide-in modal opens when Message is clicked; shows the full thread for that tenant (their bubbles left, landlord bubbles right) and a reply input. Reuses the same `property_messages` collection as the tenant side, so messages flow both ways in real time on next load.
  - **On-page toasts** — landlord side now uses the same toast notifications as the tenant side (alerts auto-routed).
  