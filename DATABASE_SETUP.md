# BConnect Platform - Database Setup Guide

## Quick Start

### 1. Set Up MongoDB Atlas (Free Tier)

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create a free account
3. Create a new project
4. Create a cluster (M0 free tier is sufficient)
5. Wait for cluster to be deployed (5-10 minutes)
6. Create a database user:
   - Security → Database Access → Add Database User
   - Username: `bconnect_user`
   - Password: Generate secure password and save it
7. Create an IP whitelist entry:
   - Security → Network Access → Add IP Address
   - Select "Allow Access from Anywhere" (0.0.0.0/0)
8. Get connection string:
   - Click "Connect" on your cluster
   - Choose "Connect Your Application"
   - Copy the connection string

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Database
MONGODB_URI=mongodb+srv://bconnect_user:YOUR_PASSWORD@cluster.mongodb.net/bconnect?retryWrites=true&w=majority

# JWT
JWT_SECRET=your_super_secret_key_change_this_in_production_12345

# Server
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8000

# Optional: M-Pesa (if you have sandbox credentials)
MPESA_CONSUMER_KEY=your_key_here
MPESA_CONSUMER_SECRET=your_secret_here
MPESA_SHORTCODE=123456
MPESA_PASSKEY=your_passkey_here
MPESA_CALLBACK_URL=https://your-app.com/mpesa/callback

# Optional: Anthropic (for AI features)
ANTHROPIC_API_KEY=your_anthropic_key_here
```

### 3. Start the Server

```bash
# Navigate to project directory
cd c:\Users\BRIAN.DESKTOP-58653DK\OneDrive\Desktop\bconnect-platform

# Install dependencies (if not already done)
npm install

# Start server
npm start
# or
node server.js
```

You should see:
```
 Successfully connected to MongoDB Atlas!
 Server running on port 3000
 Access from this device: http://localhost:3000
 Access from other devices: http://192.168.100.9:3000
```

### 4. Test the API

#### Option A: Using curl

```bash
# Test 1: Register a landlord
curl -X POST http://localhost:3000/api/landlord/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Landlord",
    "email": "john@example.com",
    "phone": "254712345678",
    "password": "SecurePass123"
  }'

# Save the token from response
# Example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Test 2: Create a property (replace TOKEN with the token from Test 1)
curl -X POST http://localhost:3000/api/landlord/properties \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{
    "name": "Downtown Apartments",
    "location": "Nairobi CBD",
    "units": 5
  }'

# Save the property code from response (e.g., "ABC123")

# Test 3: Register a tenant
curl -X POST http://localhost:3000/api/tenant/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Jane Tenant",
    "email": "jane@example.com",
    "phone": "254712345679",
    "password": "SecurePass123"
  }'

# Save the tenant token from response

# Test 4: Link property to tenant (replace TENANT_TOKEN and PROPERTY_CODE)
curl -X POST http://localhost:3000/api/tenant/link-property \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TENANT_TOKEN" \
  -d '{
    "propertyCode": "PROPERTY_CODE",
    "monthlyRent": 30000
  }'
```

#### Option B: Using the automated test script

```bash
node test-endpoints.js
```

This will run all endpoint tests and show results in color-coded output.

#### Option C: Using Postman

1. Download [Postman](https://www.postman.com/downloads/)
2. Create a new workspace
3. Import collection (or create manually)
4. Set up environment variables:
   - `base_url`: http://localhost:3000
   - `landlord_token`: (will be filled after login)
   - `tenant_token`: (will be filled after login)

### 5. Verify Database Collections

Connect to MongoDB Atlas to verify collections are created:

1. Go to MongoDB Atlas
2. Click "Browse Collections"
3. You should see these collections after running tests:
   - `landlords` - Landlord accounts
   - `landlord_properties` - Properties created by landlords
   - `tenants` - Tenant accounts
   - `tenant_properties` - Tenant-property links
   - `property_tenants` - Property-tenant relationships
   - `rent_payments` - Payment records
   - `maintenance_requests` - Repair requests

## MongoDB Connection String Format

```
mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/DATABASE_NAME?retryWrites=true&w=majority
```

Example:
```
mongodb+srv://bconnect_user:MySecurePassword123@cluster0.mongodb.net/bconnect?retryWrites=true&w=majority
```

## Troubleshooting

### Connection Failed

**Problem**: Server shows "MongoDB connection failed"

**Solution**:
1. Check MongoDB URI in `.env` file
2. Verify username/password are correct
3. Check IP whitelist in MongoDB Atlas (should include your IP)
4. Try connecting with MongoDB Compass to test connection

### Collections Not Created

**Problem**: Collections don't appear in MongoDB Atlas

**Solution**:
1. Run the test suite to trigger database writes
2. Collections are created automatically on first write operation
3. Check server console for any errors

### Token Errors

**Problem**: "Invalid or expired token" error

**Solution**:
1. Ensure token is copied correctly
2. Check token hasn't expired (7 days)
3. Verify `Authorization: Bearer TOKEN` header format
4. Make new login request to get fresh token

### Rate Limiting

**Problem**: "Too many login attempts" after multiple tests

**Solution**:
- Wait 15 minutes for rate limit to reset
- Or restart the server to reset in-memory limit
- Adjust `max: 5` in `authLimiter` config if needed

## Frontend Integration

### Using api-client.js

The frontend API client automatically uses tokens from localStorage:

```javascript
// Frontend code (landlord-dashboard.html or tenant-dashboard.html)
const response = await registerLandlord('John', 'john@example.com', '254712345678', 'pass123');
// This calls: POST /api/landlord/register with data
```

### Token Storage

Tokens are stored in localStorage:
- `landlordToken` - Landlord JWT token
- `landlordId` - Landlord account ID
- `tenantToken` - Tenant JWT token
- `tenantId` - Tenant account ID

## Database Backup

### Export Collections

```bash
# Export all collections to JSON
mongoexport --uri "mongodb+srv://user:pass@cluster.mongodb.net/bconnect" \
  --collection landlords \
  --out landlords.json
```

### Backup in MongoDB Atlas

1. Go to MongoDB Atlas
2. Click on cluster
3. Click "Backup" tab
4. Create on-demand backup
5. Download backup files

## Production Deployment

### Before Going Live

1. Change `JWT_SECRET` to a long, random string
2. Set `NODE_ENV=production`
3. Remove `ALLOWED_ORIGINS=*` - specify exact domains
4. Enable IP whitelist (not 0.0.0.0/0)
5. Create database backup
6. Test all endpoints thoroughly
7. Set up HTTPS
8. Configure M-Pesa production credentials

### Deploy to Hosting

Popular options:
- **Heroku** - `git push heroku main`
- **Railway** - Push to GitHub, auto-deploy
- **Render** - Free tier available
- **DigitalOcean** - Droplet with Node.js
- **AWS** - EC2 or Elastic Beanstalk

## Security Considerations

-  Passwords are hashed with bcryptjs (10 salt rounds)
-  JWTs are signed with SECRET_KEY
-  All sensitive data in .env file (never commit)
-  Rate limiting on auth endpoints
-  CORS enabled for development (should be restricted in production)
-  SQL injection prevention (MongoDB doesn't use SQL)

## Support

For issues:
1. Check console logs in terminal
2. Review API_ENDPOINTS.md for endpoint details
3. Check MongoDB Atlas connection logs
4. Review environment variables are set correctly
5. Test with curl before trying from frontend
