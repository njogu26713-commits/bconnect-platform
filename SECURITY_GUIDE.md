# BConnect Security Fixes - Complete Guide

##  CRITICAL ISSUES TO FIX

### Issue 1: API Keys Exposed in Frontend
**Problem**: Supabase keys visible in `website.html` and other client files
**Risk**: Anyone can read your keys from browser DevTools
**Fix**: Move all Supabase calls to backend (server.js)

### Issue 2: No User Authentication
**Problem**: Users not verified before accessing features
**Risk**: Anyone can create/modify/delete data
**Fix**: Implement JWT-based authentication

### Issue 3: CORS Too Open
**Problem**: `app.use(cors())` allows all origins
**Risk**: Third-party sites can access your APIs
**Fix**: Restrict to specific origins

### Issue 4: No Rate Limiting
**Problem**: Attackers can spam endpoints
**Risk**: Denial of service attacks
**Fix**: Add rate limiting middleware

---

##  STEP 1: Secure your .env file

Make sure these are ONLY in .env, NEVER in code:
```
SUPABASE_SERVICE_ROLE_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
MPESA_CONSUMER_SECRET=your_secret_here
MPESA_PASSKEY=your_passkey_here
JWT_SECRET=your_random_secret_key_here
```

Add to `.gitignore`:
```
.env
node_modules/
*.log
```

---

##  STEP 2: Update server.js with Security

### A. Install Rate Limiting Package
```bash
npm install express-rate-limit
```

### B. Update server.js imports
Replace the current imports section with:

```javascript
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const jwt = require('jsonwebtoken');

dotenv.config();

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY,
  JWT_SECRET = 'your_Secret_Key_Change_This_In_Production',
  PORT = 3000,
  NODE_ENV = 'development',
  ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:8000'
} = process.env;

// Validate critical env vars
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const app = express();

// CORS Configuration - Restrict to known origins only
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = ALLOWED_ORIGINS.split(',');
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(require('cors')(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // strict limit on auth attempts
  message: 'Too many login attempts, please try again later.'
});

app.use(limiter); // Apply to all routes
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// Serve static files SECURELY
app.use(express.static('.', {
  dotfiles: 'deny', // Don't serve .env, .git etc
  maxAge: '1d'
}));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});
```

### C. Add JWT Authentication Middleware

Add after the Claude initialization:

```javascript
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
```

### D. Update CORS-dependent endpoints

Remove `app.use(express.static('.'))`  and replace with secure version above.

---

##  STEP 3: Create Authentication Endpoints

Add these endpoints to server.js:

```javascript
// User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create user in Supabase Auth
    const { data, error } = await supabase.auth.signUpWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Save user profile
    const { error: insertError } = await supabase
      .from('users')
      .insert({
        id: data.user.id,
        email,
        fullName,
        createdAt: new Date(),
      });

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    const token = generateToken(data.user.id);

    return res.json({
      success: true,
      token,
      user: {
        id: data.user.id,
        email,
        fullName,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(data.user.id);

    // Get user profile
    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    return res.json({
      success: true,
      token,
      user: profile,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get Current User (requires auth)
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.userId)
      .single();

    res.json(data);
  } catch (error) {
    res.status(404).json({ error: 'User not found' });
  }
});
```

---

##  STEP 4: Protect Sensitive Endpoints

Update your existing endpoints to use `verifyToken`:

```javascript
// EXAMPLE: Protect the AI chat endpoint
app.post('/api/ai/chat', verifyToken, async (req, res) => {
  // Add userId to request
  const { message, context } = req.body;
  
  try {
    // Your existing chat logic here
    // Now you know which user is making the request via req.userId
    
    const completion = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    res.json({
      success: true,
      response: completion.content[0].text,
      timestamp: new Date().toISOString(),
      userId: req.userId  // Track who used the API
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    res.status(500).json({ error: 'AI service temporarily unavailable' });
  }
});
```

---

##  STEP 5: Create Secure Auth Frontend

Create new file `login.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BConnect - Login</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .auth-container {
            background: white;
            padding: 2rem;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            width: 100%;
            max-width: 400px;
        }
        h1 {
            color: #667eea;
            text-align: center;
            margin-bottom: 2rem;
        }
        .form-group {
            margin-bottom: 1rem;
        }
        label {
            display: block;
            margin-bottom: 0.5rem;
            color: #333;
            font-weight: 500;
        }
        input {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 5px;
            font-size: 1rem;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 5px rgba(102, 126, 234, 0.3);
        }
        button {
            width: 100%;
            padding: 0.75rem;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 1rem;
        }
        button:hover {
            background: #5568d3;
        }
        .toggle-mode {
            text-align: center;
            margin-top: 1rem;
            color: #666;
        }
        .toggle-mode a {
            color: #667eea;
            cursor: pointer;
        }
        .error {
            background: #fee;
            color: #c33;
            padding: 0.75rem;
            border-radius: 5px;
            margin-bottom: 1rem;
            display: none;
        }
        .success {
            background: #efe;
            color: #3c3;
            padding: 0.75rem;
            border-radius: 5px;
            margin-bottom: 1rem;
            display: none;
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1> BConnect</h1>
        
        <div id="error" class="error"></div>
        <div id="success" class="success"></div>

        <form id="authForm">
            <div id="nameGroup" class="form-group" style="display: none;">
                <label for="fullName">Full Name</label>
                <input type="text" id="fullName" required>
            </div>

            <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" required>
            </div>

            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" required>
            </div>

            <button type="submit" id="submitBtn">Login</button>
        </form>

        <div class="toggle-mode">
            <span id="modeText">Don't have an account? </span>
            <a onclick="toggleMode()" id="toggleLink">Sign Up</a>
        </div>
    </div>

    <script>
        let isLoginMode = true;

        const authForm = document.getElementById('authForm');
        const nameGroup = document.getElementById('nameGroup');
        const submitBtn = document.getElementById('submitBtn');
        const toggleLink = document.getElementById('toggleLink');
        const modeText = document.getElementById('modeText');
        const errorDiv = document.getElementById('error');
        const successDiv = document.getElementById('success');

        function toggleMode() {
            isLoginMode = !isLoginMode;
            nameGroup.style.display = isLoginMode ? 'none' : 'block';
            submitBtn.textContent = isLoginMode ? 'Login' : 'Create Account';
            modeText.textContent = isLoginMode ? "Don't have an account? " : 'Already have an account? ';
            errorDiv.style.display = 'none';
        }

        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            errorDiv.style.display = 'none';
            successDiv.style.display = 'none';

            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/register';
            const body = isLoginMode 
                ? { email, password }
                : { email, password, fullName: document.getElementById('fullName').value };

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Authentication failed');
                }

                // Save token to localStorage
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));

                successDiv.textContent = isLoginMode ? 'Login successful!' : 'Account created!';
                successDiv.style.display = 'block';

                setTimeout(() => {
                    window.location.href = 'website.html';
                }, 1500);
            } catch (error) {
                errorDiv.textContent = error.message;
                errorDiv.style.display = 'block';
            }
        });
    </script>
</body>
</html>
```

---

##  STEP 6: Update Frontend to Use Token

In your JavaScript files (website.html, etc.), add token to all API calls:

```javascript
const getAuthHeader = () => {
  const token = localStorage.getItem('token');
  if (!token) {
    window.location.href = 'login.html';
    return null;
  }
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
};

// Example: Update AI chat call
async function sendAIMessage(message) {
  const headers = getAuthHeader();
  if (!headers) return;

  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, context: 'Web app' })
  });

  const data = await response.json();
  return data;
}
```

---

##  STEP 7: Database Schema (Supabase SQL)

Create these tables in Supabase:

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR UNIQUE NOT NULL,
  fullName VARCHAR NOT NULL,
  role VARCHAR DEFAULT 'user', -- user, seller, landlord, admin
  avatar_url TEXT,
  verified BOOLEAN DEFAULT false,
  createdAt TIMESTAMP DEFAULT NOW()
);

-- Orders table
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  itemId UUID,
  itemType VARCHAR, -- product, service, housing
  amount DECIMAL NOT NULL,
  status VARCHAR DEFAULT 'pending', -- pending, paid, failed
  mpesaRef VARCHAR,
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Listings table (products, services, housing)
CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR NOT NULL, -- product, service, housing
  title VARCHAR NOT NULL,
  description TEXT,
  price DECIMAL NOT NULL,
  location VARCHAR,
  category VARCHAR,
  images TEXT[], -- array of image URLs
  status VARCHAR DEFAULT 'active', -- active, sold, pending
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX idx_orders_userId ON orders(userId);
CREATE INDEX idx_listings_userId ON listings(userId);
CREATE INDEX idx_listings_type ON listings(type);
```

---

##  STEP 8: Environment Variables

Update `.env`:

```
SUPABASE_URL=https://qjenuskqxacpvvvpbubp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_OjjWXtWz2Cj0vQEqGAyjew_NXuRAmgh
ANTHROPIC_API_KEY=sk-ant-xxxxx
MPESA_CONSUMER_KEY=xxxxx
MPESA_CONSUMER_SECRET=xxxxx
MPESA_SHORTCODE=174379
MPESA_PASSKEY=xxxxx
MPESA_CALLBACK_URL=https://yourdomain.com/mpesa/callback
JWT_SECRET=your_super_secret_random_string_here_min_32_chars
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

---

##  STEP 9: Testing Security

```bash
# Run after implementing
npm install jsonwebtoken

# Test your endpoints
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpass123","fullName":"Test User"}'

# Should return a token, use it for other requests
curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer your_token_here"
```

---

##  Security Checklist

- [ ] Add `verifyToken` to all endpoints that access user data
- [ ] Move Supabase keys to backend only
- [ ] Implement CORS restrictions
- [ ] Add rate limiting
- [ ] Create login.html page
- [ ] Update frontend to send auth tokens
- [ ] Validate all user inputs on backend
- [ ] Use HTTPS in production (not just HTTP)
- [ ] Set JWT_SECRET to strong random string
- [ ] Test login/register flow
- [ ] Set correct ALLOWED_ORIGINS for production

---

##  Priority Implementation Order

1. **Week 1**: Implement auth endpoints + frontend login page
2. **Week 2**: Add `verifyToken` to sensitive endpoints
3. **Week 3**: Update CORS + Rate limiting + Database schema
4. **Week 4**: Full security audit + HTTPS setup

This will transform BConnect from prototype to production-ready! 
