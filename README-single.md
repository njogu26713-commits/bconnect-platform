# BConnect - Single File Deployment

This is a single-file deployment of the BConnect platform, perfect for uploading to Replit or other online IDEs.

## Features

- **Housing Management**: Rent payment tracking and tenant management
- **Marketplace**: Product submission and approval system with premium options
- **Admin Dashboard**: Review and approve product submissions
- **M-PESA Integration**: Secure payment processing
- **User Authentication**: Role-based access control

## Setup Instructions

1. **Upload to Replit**:
   - Create a new Replit project
   - Upload `bconnect-single-file.js` and `package-single.json`
   - Rename `package-single.json` to `package.json`

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Environment Variables**:
   Create a `.env` file with the following variables:
   ```
   MPESA_CONSUMER_KEY=your_mpesa_consumer_key
   MPESA_CONSUMER_SECRET=your_mpesa_consumer_secret
   MPESA_SHORTCODE=your_mpesa_shortcode
   MPESA_PASSKEY=your_mpesa_passkey
   MPESA_CALLBACK_URL=your_callback_url
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   PORT=3000
   ```

4. **Database Setup**:
   Run the SQL commands in `database-setup.sql` in your Supabase SQL editor.

5. **Run the Application**:
   ```bash
   npm start
   ```

## Available Routes

- `/` - Main website
- `/api/*` - API endpoints for data management

## User Roles

- **Admin**: Can approve/reject product submissions
- **Seller**: Can submit products for approval
- **Landlord**: Can manage tenants and rent payments
- **Tenant**: Can pay rent and view payment history

## Premium Features

Sellers can pay for premium placements:
- **Trending**: KSh 500
- **Featured**: KSh 1,000
- **Stream**: KSh 750

## Technologies Used

- **Backend**: Node.js, Express.js
- **Database**: Supabase (PostgreSQL)
- **Payments**: M-PESA STK Push
- **Authentication**: Supabase Auth
- **Frontend**: HTML5, CSS3, JavaScript

## File Structure

The entire application is contained in a single file:
- Server setup and configuration
- API endpoints
- HTML pages embedded as strings
- Client-side JavaScript
- CSS styles

This makes it easy to deploy to platforms like Replit that work best with single-file applications.