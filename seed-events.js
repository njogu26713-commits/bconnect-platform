require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set — cannot seed events.');
  process.exit(1);
}

const events = [
  {
    title: 'Nairobi Jazz & Soul Festival',
    description: 'A premier outdoor jazz and soul music festival bringing together Kenya\'s finest musicians and international artists for an unforgettable evening under the stars at Uhuru Gardens.',
    event_date: new Date('2026-08-15T18:00:00'),
    venue: 'Uhuru Gardens',
    location: 'Nairobi, Kenya',
    category: 'concert',
    ticket_price: 1500,
    tickets_available: 500,
    tickets_sold: 87,
    organizer: 'Nairobi Live Events',
    imageUrl: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80',
    images: ['https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80'],
    image_url: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80',
    status: 'upcoming',
    active: true,
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    title: 'Safaricom Premier League Finals',
    description: 'Watch Kenya\'s biggest football clubs battle it out in the season\'s most anticipated match. Live entertainment, food stalls, and fan zones make this a full-day experience for the whole family.',
    event_date: new Date('2026-07-25T15:00:00'),
    venue: 'Kasarani Stadium',
    location: 'Nairobi, Kenya',
    category: 'sports',
    ticket_price: 800,
    tickets_available: 3000,
    tickets_sold: 1240,
    organizer: 'KPL Sports Management',
    imageUrl: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=800&q=80',
    images: ['https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=800&q=80'],
    image_url: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=800&q=80',
    status: 'upcoming',
    active: true,
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    title: 'East Africa Tech Summit 2026',
    description: 'Three days of keynotes, workshops and networking with Africa\'s top tech founders, VCs and engineers. Topics include AI, fintech, agritech and the future of mobile money across East Africa.',
    event_date: new Date('2026-09-05T09:00:00'),
    venue: 'KICC — Kenyatta International Convention Centre',
    location: 'Nairobi, Kenya',
    category: 'tech',
    ticket_price: 5000,
    tickets_available: 800,
    tickets_sold: 312,
    organizer: 'AfricaTech Hub',
    imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80',
    images: ['https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80'],
    image_url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80',
    status: 'upcoming',
    active: true,
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    title: 'Nairobi Street Food Festival',
    description: 'Celebrate the best of Kenyan street cuisine — nyama choma, mutura, samosas, mandazi and much more from over 60 vendors. Live cooking demos, DJ sets, and the annual best-chef competition.',
    event_date: new Date('2026-08-02T11:00:00'),
    venue: 'Ngong Racecourse',
    location: 'Nairobi, Kenya',
    category: 'food',
    ticket_price: 500,
    tickets_available: 2000,
    tickets_sold: 654,
    organizer: 'Taste of Kenya Events',
    imageUrl: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&q=80',
    images: ['https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&q=80'],
    image_url: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800&q=80',
    status: 'upcoming',
    active: true,
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    title: 'Blankets & Wine — Mombasa Edition',
    description: 'Kenya\'s most loved lifestyle music festival comes to the Coast! Bring your blanket and enjoy live Afropop, Bongo Flava and R&B performances against a stunning ocean backdrop with artisan markets and craft cocktails.',
    event_date: new Date('2026-07-19T14:00:00'),
    venue: 'Nyali Beach Hotel Grounds',
    location: 'Mombasa, Kenya',
    category: 'concert',
    ticket_price: 2000,
    tickets_available: 1200,
    tickets_sold: 430,
    organizer: 'Blankets & Wine Kenya',
    imageUrl: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80',
    images: ['https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80'],
    image_url: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=800&q=80',
    status: 'upcoming',
    active: true,
    created_at: new Date(),
    updated_at: new Date()
  }
];

async function seed() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db('bconnect');
    console.log('Connected to MongoDB.');

    const existing = await db.collection('events').countDocuments();
    if (existing > 0) {
      console.log(`Events collection already has ${existing} document(s). Inserting anyway...`);
    }

    const result = await db.collection('events').insertMany(events);
    console.log(`✓ Inserted ${result.insertedCount} events successfully.`);
    Object.values(result.insertedIds).forEach((id, i) => {
      console.log(`  [${i + 1}] ${events[i].title} → ${id}`);
    });
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seed();
