# BConnect Platform - API Endpoints Documentation

## Authentication
All protected endpoints require a Bearer token in the Authorization header:
```
Authorization: Bearer <token>
```

---

## LANDLORD ENDPOINTS

### 1. Register Landlord
**POST** `/api/landlord/register`
- **Rate Limited**: Yes (5 attempts per 15 minutes)
- **Auth Required**: No
- **Request Body**:
  ```json
  {
    "fullName": "John Doe",
    "email": "landlord@example.com",
    "phone": "254712345678",
    "password": "securePassword123"
  }
  ```
- **Response**: JWT token, landlordId
- **Collection**: `landlords` (with bcrypt hashed password)

### 2. Login Landlord
**POST** `/api/landlord/login`
- **Rate Limited**: Yes (5 attempts per 15 minutes)
- **Auth Required**: No
- **Request Body**:
  ```json
  {
    "email": "landlord@example.com",
    "password": "securePassword123"
  }
  ```
- **Response**: JWT token, landlordId

### 3. Get Landlord Properties
**GET** `/api/landlord/properties`
- **Auth Required**: Yes (Bearer token)
- **Query Params**: None
- **Response**: Array of property objects
- **Collection**: `landlord_properties` (filtered by landlordId)

### 4. Create Property
**POST** `/api/landlord/properties`
- **Auth Required**: Yes
- **Request Body**:
  ```json
  {
    "name": "Downtown Apartments",
    "location": "Nairobi CBD",
    "units": 5
  }
  ```
- **Response**: New property with auto-generated 6-char code
- **Collection**: `landlord_properties`

### 5. Get Property Details
**GET** `/api/landlord/properties/:id`
- **Auth Required**: Yes
- **Response**: Single property object

### 6. Get Property Tenants
**GET** `/api/landlord/properties/:id/tenants`
- **Auth Required**: Yes
- **Response**: Array of tenant objects linked to property
- **Collection**: `property_tenants`

### 7. Get Property Payments
**GET** `/api/landlord/properties/:id/payments`
- **Auth Required**: Yes
- **Response**: Payment history (last 50)
- **Collection**: `rent_payments`

---

## TENANT ENDPOINTS

### 1. Register Tenant
**POST** `/api/tenant/register`
- **Rate Limited**: Yes (5 attempts per 15 minutes)
- **Auth Required**: No
- **Request Body**:
  ```json
  {
    "fullName": "Jane Smith",
    "email": "tenant@example.com",
    "phone": "254712345678",
    "password": "securePassword123"
  }
  ```
- **Response**: JWT token, tenantId
- **Collection**: `tenants`

### 2. Login Tenant
**POST** `/api/tenant/login`
- **Rate Limited**: Yes
- **Auth Required**: No
- **Request Body**:
  ```json
  {
    "email": "tenant@example.com",
    "password": "securePassword123"
  }
  ```
- **Response**: JWT token, tenantId

### 3. Link Property
**POST** `/api/tenant/link-property`
- **Auth Required**: Yes
- **Request Body**:
  ```json
  {
    "propertyCode": "ABC123",
    "monthlyRent": 30000
  }
  ```
- **Description**: Links tenant to a property using the landlord's property code
- **Response**: Linked property object
- **Collections**: `tenant_properties`, `property_tenants`, `landlord_properties` (updated)

### 4. Get Tenant Properties
**GET** `/api/tenant/properties`
- **Auth Required**: Yes
- **Response**: Array of linked properties
- **Collection**: `tenant_properties`

### 5. Get Property Payment History
**GET** `/api/tenant/properties/:id/payments`
- **Auth Required**: Yes
- **Response**: Payment history for specific property
- **Collection**: `rent_payments`

### 6. Pay Rent
**POST** `/api/tenant/pay-rent`
- **Auth Required**: Yes
- **Request Body**:
  ```json
  {
    "propertyId": "64a5f8b2c1d2e3f4g5h6i7j8",
    "amount": 30000
  }
  ```
- **Response**: Payment record with pending status
- **Collections**: `rent_payments`, `tenant_properties` (updated)

### 7. Request Repair/Maintenance
**POST** `/api/tenant/request-repair`
- **Auth Required**: Yes
- **Request Body**:
  ```json
  {
    "propertyId": "64a5f8b2c1d2e3f4g5h6i7j8",
    "description": "Broken tap in bathroom",
    "priority": "normal"
  }
  ```
- **Response**: Maintenance request record
- **Collection**: `maintenance_requests`

---

## MONGODB COLLECTIONS SCHEMA

### landlords
```javascript
{
  _id: ObjectId,
  fullName: String,
  email: String (unique, lowercase),
  phone: String,
  password: String (hashed),
  properties: [ObjectId],
  totalTenants: Number,
  totalRevenue: Number,
  createdAt: Date,
  updatedAt: Date
}
```

### landlord_properties
```javascript
{
  _id: ObjectId,
  landlordId: ObjectId,
  name: String,
  location: String,
  units: Number,
  code: String (unique 6-char), // Used by tenants to link
  tenants: [ObjectId],
  totalTenants: Number,
  totalRevenue: Number,
  status: String (active/inactive),
  createdAt: Date,
  updatedAt: Date
}
```

### tenants
```javascript
{
  _id: ObjectId,
  fullName: String,
  email: String (unique, lowercase),
  phone: String,
  password: String (hashed),
  linkedProperties: [ObjectId],
  totalPayments: Number,
  createdAt: Date,
  updatedAt: Date
}
```

### tenant_properties
```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  propertyId: ObjectId,
  propertyCode: String,
  propertyName: String,
  landlordName: String,
  landlordPhone: String,
  monthlyRent: Number,
  linkedDate: Date,
  status: String (active/inactive),
  totalPayments: Number
}
```

### property_tenants
```javascript
{
  _id: ObjectId,
  propertyId: ObjectId,
  tenantId: ObjectId,
  monthlyRent: Number,
  linkedDate: Date,
  status: String (active/inactive)
}
```

### rent_payments
```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  propertyId: ObjectId,
  amount: Number,
  status: String (pending/completed/failed),
  paymentMethod: String (mpesa),
  createdAt: Date,
  updatedAt: Date
}
```

### maintenance_requests
```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  propertyId: ObjectId,
  description: String,
  priority: String (low/normal/high),
  status: String (pending/in-progress/completed),
  createdAt: Date,
  updatedAt: Date
}
```

---

## ERROR RESPONSES

All endpoints return standardized error responses:

### 400 - Bad Request
```json
{ "error": "All fields are required" }
```

### 401 - Unauthorized
```json
{ "error": "Invalid email or password" }
```

### 404 - Not Found
```json
{ "error": "Property not found" }
```

### 503 - Service Unavailable
```json
{ "error": "Database not connected" }
```

---

## SECURITY FEATURES

-  Password hashing with bcryptjs (10 salt rounds)
-  JWT tokens with 7-day expiration
-  Rate limiting on authentication endpoints
-  Email uniqueness validation
-  Property code uniqueness enforcement
-  User ownership verification on protected routes

---

## ENVIRONMENT VARIABLES

Required for database functionality:
```
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/bconnect
JWT_SECRET=your_secret_key_change_in_production
```

Optional (for payment processing):
```
MPESA_CONSUMER_KEY=xxxxx
MPESA_CONSUMER_SECRET=xxxxx
MPESA_SHORTCODE=xxxxx
MPESA_PASSKEY=xxxxx
MPESA_CALLBACK_URL=https://yourapp.com/mpesa/callback
```

---

## TESTING WITH CURL

### Register Landlord
```bash
curl -X POST http://localhost:3000/api/landlord/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Doe",
    "email": "landlord@example.com",
    "phone": "254712345678",
    "password": "password123"
  }'
```

### Login Landlord
```bash
curl -X POST http://localhost:3000/api/landlord/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "landlord@example.com",
    "password": "password123"
  }'
```

### Create Property (with token)
```bash
curl -X POST http://localhost:3000/api/landlord/properties \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "Downtown Apartments",
    "location": "Nairobi CBD",
    "units": 5
  }'
```

---

## NEXT STEPS

1. Set MONGODB_URI environment variable
2. Test endpoints with frontend (api-client.js)
3. Integrate with M-Pesa payment gateway
4. Add email verification
5. Implement notification system
