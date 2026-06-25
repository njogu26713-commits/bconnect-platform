# BConnect - Real Estate & Services Platform

A comprehensive platform connecting buyers, sellers, landlords, and tenants for real estate, services, and property management.

## Features

- **Multi-role Authentication**: Support for buyers, sellers, landlords, and tenants
- **Dynamic Navigation**: Role-based navigation that shows relevant dashboard icons
- **Property Management**: List, search, and manage properties
- **Service Marketplace**: Book and provide services
- **Product Marketplace**: Buy and sell products
- **Maintenance Requests**: Submit and track property maintenance requests
- **Payment Integration**: Secure payment processing
- **Real-time Communication**: Live updates and notifications

## Tech Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Supabase (PostgreSQL, Auth, Real-time)
- **Styling**: Tailwind CSS
- **Icons**: Unicode emojis and custom CSS

## Setup Instructions

### 1. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to your project dashboard
3. Copy your project URL and anon key
4. Run the SQL schema in `supabase-schema.sql` in your Supabase SQL editor

### 2. Configuration



### 3. Database Tables

The following tables are created automatically:

- `profiles` - User profiles with roles
- `properties` - Property listings
- `maintenance_requests` - Maintenance request tracking
- `payments` - Payment records
- `products` - Product marketplace
- `orders` - Order management
- `order_items` - Order line items
- `services` - Service listings
- `bookings` - Service booking system

### 4. User Roles

- **Buyer**: Can browse properties, make payments, submit maintenance requests
- **Seller**: Can list products, manage inventory, view orders
- **Landlord**: Can list properties, manage tenants, view maintenance requests
- **Tenant**: Can pay rent, submit maintenance requests (accessed via payrent.html)

## File Structure

```
 website.html          # Main landing page with dynamic navigation
 login.html            # Authentication (sign up/sign in)
 tenant-dashboard.html # Buyer/Tenant dashboard
 seller-dashboard.html # Seller dashboard
 landlord.html         # Landlord dashboard
 payrent.html          # Rent payment page (for tenants)
 mongodb atlas
 README.md            # This file
```

## Usage

### For New Users:
1. Visit `login.html`
2. Click "Sign Up" tab
3. Fill in your details and select your role
4. Check your email for confirmation
5. Sign in with your credentials

### For Existing Users:
1. Visit `login.html`
2. Select your role from the dropdown
3. Enter your email and password
4. You'll be redirected to your role-specific dashboard

### Navigation:
- The main website (`website.html`) shows different navigation icons based on your logged-in role
- Buyers see the Pay Rent icon
- Sellers see the Seller Dashboard + Pay Rent icons
- Landlords see the Landlord Dashboard icon

## API Endpoints

All data operations use Supabase's REST API. Key operations include:

- **Authentication**: Sign up/sign in with email/password
- **Profiles**: User profile management
- **Properties**: CRUD operations for property listings
- **Maintenance**: Request submission and status tracking
- **Payments**: Payment processing and history
- **Products**: Product listing and ordering
- **Services**: Service booking system

## Security

- Row Level Security (RLS) enabled on all tables
- Users can only access their own data
- Landlords can view data related to their properties
- Sellers can manage their own products and orders

## Development

To modify the application:

1. Edit the HTML/CSS/JS files as needed
2. Test locally (files work without a server)
3. Update the Supabase schema if new tables are needed
4. Deploy to your hosting platform

## Support

For issues or questions:
- Check the Supabase dashboard for data/logs
- Review browser console for JavaScript errors
- Ensure all Supabase policies are correctly configured

## License

This project is for educational and demonstration purposes.
