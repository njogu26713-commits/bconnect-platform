// ============ LANDLORD API ENDPOINTS ============

// Register/Create Landlord Account
async function registerLandlord(fullName, email, phone, password) {
  try {
    const response = await fetch('/api/landlord/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, phone, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Registration failed');
    return data;
  } catch (error) {
    console.error('Register error:', error);
    throw error;
  }
}

// Login Landlord
async function loginLandlord(email, password) {
  try {
    const response = await fetch('/api/landlord/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('landlordToken', data.token);
    localStorage.setItem('landlordId', data.landlordId);
    localStorage.setItem('token', data.token);
    localStorage.setItem('authToken', data.token);
    return data;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

// Get Landlord Properties
async function getLandlordProperties() {
  const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
  const response = await fetch('/api/landlord/properties', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Failed to fetch properties');
  return data.properties || [];
}

// Create Property
async function createProperty(name, location, units, monthlyRent, extras = {}) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch('/api/landlord/properties', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, location, units, monthlyRent, ...extras })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to create property');
    return data;
  } catch (error) {
    console.error('Create property error:', error);
    throw error;
  }
}

// Get Property Details
async function getPropertyDetails(propertyId) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch(`/api/landlord/properties/${propertyId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch property');
    return data.property;
  } catch (error) {
    console.error('Fetch property error:', error);
    throw error;
  }
}

// Get Property Tenants
async function getPropertyTenants(propertyId) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch(`/api/landlord/properties/${propertyId}/tenants`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch tenants');
    return data.tenants || [];
  } catch (error) {
    console.error('Fetch tenants error:', error);
    return [];
  }
}

// Get Property Payments
async function getPropertyPayments(propertyId) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch(`/api/landlord/properties/${propertyId}/payments`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch payments');
    return data.payments || [];
  } catch (error) {
    console.error('Fetch payments error:', error);
    return [];
  }
}

// Get Property Maintenance Requests
async function getPropertyMaintenance(propertyId) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch(`/api/landlord/properties/${propertyId}/maintenance`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch maintenance requests');
    return data.requests || [];
  } catch (error) {
    console.error('Fetch maintenance error:', error);
    return [];
  }
}

// Update Maintenance Request Status
async function updateMaintenanceStatus(requestId, status) {
  try {
    const token = localStorage.getItem('landlordToken') || localStorage.getItem('token');
    const response = await fetch(`/api/landlord/maintenance/${requestId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to update request');
    return data;
  } catch (error) {
    console.error('Update maintenance error:', error);
    throw error;
  }
}

// Logout Landlord
function logoutLandlord() {
  localStorage.removeItem('landlordToken');
  localStorage.removeItem('landlordId');
}

// ============ TENANT API ENDPOINTS ============

// Register/Create Tenant Account
async function registerTenant(fullName, email, phone, password) {
  try {
    const response = await fetch('/api/tenant/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, email, phone, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Registration failed');
    return data;
  } catch (error) {
    console.error('Register error:', error);
    throw error;
  }
}

// Login Tenant
async function loginTenant(email, password) {
  try {
    const response = await fetch('/api/tenant/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('tenantToken', data.token);
    localStorage.setItem('tenantId', data.tenantId);
    localStorage.setItem('token', data.token);
    localStorage.setItem('authToken', data.token);
    return data;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

// Link Property for Tenant
async function linkProperty(propertyCode, monthlyRent) {
  try {
    const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
    const body = { propertyCode };
    if (monthlyRent && Number(monthlyRent) > 0) body.monthlyRent = Number(monthlyRent);
    const response = await fetch('/api/tenant/link-property', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to link property');
    return data;
  } catch (error) {
    console.error('Link property error:', error);
    throw error;
  }
}

// Get Tenant Linked Properties
async function getTenantProperties() {
  try {
    const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
    const response = await fetch('/api/tenant/properties', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch properties');
    return data.properties || [];
  } catch (error) {
    console.error('Fetch properties error:', error);
    return [];
  }
}

// Get Tenant Payment History
async function getTenantPayments(propertyId) {
  try {
    const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
    const response = await fetch(`/api/tenant/properties/${propertyId}/payments`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch payments');
    return data.payments || [];
  } catch (error) {
    console.error('Fetch payments error:', error);
    return [];
  }
}

// Pay Rent
async function payRent(propertyId, amount) {
  try {
    const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
    const response = await fetch(`/api/tenant/pay-rent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ propertyId, amount, paymentType: arguments[2] || 'full' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Payment failed');
    return data;
  } catch (error) {
    console.error('Payment error:', error);
    throw error;
  }
}

// Request Repair
async function requestRepair(propertyId, description) {
  try {
    const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
    const response = await fetch(`/api/tenant/request-repair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ propertyId, description })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to submit request');
    return data;
  } catch (error) {
    console.error('Repair request error:', error);
    throw error;
  }
}

// Logout Tenant
function logoutTenant() {
  localStorage.removeItem('tenantToken');
  localStorage.removeItem('tenantId');
}


// ===== Tenant property extras (announcements, requests, messages) =====
async function getPropertyAnnouncements(propertyId) {
  const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
  const r = await fetch(`/api/tenant/properties/${propertyId}/announcements`, { headers: { 'Authorization': `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed to load announcements');
  return d.announcements || [];
}
async function getPropertyRequests(propertyId) {
  const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
  const r = await fetch(`/api/tenant/properties/${propertyId}/requests`, { headers: { 'Authorization': `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed to load requests');
  return d.requests || [];
}
async function getPropertyMessages(propertyId) {
  const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
  const r = await fetch(`/api/tenant/properties/${propertyId}/messages`, { headers: { 'Authorization': `Bearer ${token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed to load messages');
  return d.messages || [];
}
async function sendPropertyMessage(propertyId, text) {
  const token = localStorage.getItem('tenantToken') || localStorage.getItem('token');
  const r = await fetch(`/api/tenant/properties/${propertyId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ text }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed to send message');
  return d.message;
}
