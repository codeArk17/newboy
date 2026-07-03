const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const {
  validatePricePerNight,
  validateVideoTourUrl,
  toPriceBigInt,
  fromPriceBigInt,
} = require('./validation');
const { requireAdmin } = require('./adminAuth');
const {
  readProperties,
  writeProperties,
  nextPropertyId,
} = require('./propertiesStore');

const multer = require('multer');

dotenv.config();
const prisma = new PrismaClient();

// Ensure the data directory exists so propertiesStore.js never throws on first run
const fs = require('fs');
const path = require('path');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const propertiesFile = path.join(dataDir, 'properties.json');
if (!fs.existsSync(propertiesFile)) fs.writeFileSync(propertiesFile, '[]', 'utf-8');

// ── Uploads directory ─────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","X-Admin-Key","Authorization"]
}));
app.use(express.json());

// Serve uploaded images as static files
app.use('/uploads', express.static(uploadsDir));

// ── Image upload ──────────────────────────────────────────────────────────────
// multer must run BEFORE requireAdmin on multipart routes so headers are readable
app.post('/api/admin/upload', upload.single('image'), (req, res) => {
  // Manual admin key check (works with multipart requests)
  const adminKey = req.headers['x-admin-key'] || '';
  const expectedKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '';
  if (!adminKey || !expectedKey || adminKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No image file received or file type not allowed.' });
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const url = `${protocol}://${host}/uploads/${req.file.filename}`;
  res.json({ url });
});

const LISTING_TYPES = ['Rent', 'Sale'];

function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitize(value[k]);
    return out;
  }
  return value;
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === '');
  return missing.length ? missing : null;
}

function normalizeListingType(raw) {
  const t = String(raw || 'Rent').trim();
  if (t.toLowerCase() === 'sale') return 'Sale';
  return 'Rent';
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (_) {}
  // Always return 200 so the frontend knows the server is up.
  // The db field tells you whether the database connection is healthy.
  res.json({ ok: true, db: dbOk });
});

// ── Properties (static file, public read) ─────────────────────────────────────

app.get('/api/properties', (req, res) => {
  res.json(readProperties());
});

// ── Houses (public read — active only) ────────────────────────────────────────

app.get('/api/houses', async (req, res) => {
  try {
    const houses = await prisma.house.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(sanitize(houses));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch houses', detail: e?.message });
  }
});

function buildHouseData(body, { partial = false } = {}) {
  const data = {};
  if (!partial || body.title !== undefined) data.title = String(body.title || '').trim();
  if (!partial || body.description !== undefined) {
    data.description = String(body.description || 'n/a').trim();
  }
  if (!partial || body.address !== undefined) data.address = String(body.address || 'n/a').trim();
  if (!partial || body.city !== undefined) data.city = String(body.city || '').trim();
  if (body.pricePerNight !== undefined) {
    const priceCheck = validatePricePerNight(body.pricePerNight);
    if (!priceCheck.ok) return { error: priceCheck.error };
    data.pricePerNight = toPriceBigInt(priceCheck.value);
  }
  if (body.listingType !== undefined) data.listingType = normalizeListingType(body.listingType);
  if (body.bedrooms !== undefined) {
    data.bedrooms = Number.isFinite(Number(body.bedrooms)) ? Number(body.bedrooms) : 0;
  }
  if (body.bathrooms !== undefined) {
    data.bathrooms = Number.isFinite(Number(body.bathrooms)) ? Number(body.bathrooms) : 0;
  }
  if (body.sqft !== undefined) {
    data.sqft = Number.isFinite(Number(body.sqft)) ? Math.max(0, Number(body.sqft)) : 0;
  }
  if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl ? String(body.imageUrl) : null;
  if (body.subImageUrls !== undefined) {
    data.subImageUrls = Array.isArray(body.subImageUrls) ? body.subImageUrls : [];
  }
  if (body.videoTourUrl !== undefined) {
    const videoCheck = validateVideoTourUrl(body.videoTourUrl);
    if (!videoCheck.ok) return { error: videoCheck.error };
    data.videoTourUrl = videoCheck.value;
  }
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  return { data };
}

app.post('/api/houses', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['title', 'city', 'pricePerNight']);
    if (missing) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const built = buildHouseData(body);
    if (built.error) return res.status(400).json({ error: built.error });
    if (!built.data.pricePerNight) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    const house = await prisma.house.create({
      data: {
        ...built.data,
        listingType: normalizeListingType(body.listingType),
        bedrooms: built.data.bedrooms ?? (Number(body.bedrooms) || 0),
        bathrooms: built.data.bathrooms ?? (Number(body.bathrooms) || 0),
        sqft: built.data.sqft ?? (Number(body.sqft) || 0),
        // Default new listings to active so they appear on the homepage immediately
        isActive: built.data.isActive !== undefined ? built.data.isActive : true,
      },
    });
    res.status(201).json(sanitize(house));
  } catch (e) {
    res.status(400).json({ error: 'Failed to create house', detail: e?.message });
  }
});

app.put('/api/houses/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const built = buildHouseData(req.body || {}, { partial: true });
    if (built.error) return res.status(400).json({ error: built.error });
    if (Object.keys(built.data).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const house = await prisma.house.update({ where: { id }, data: built.data });
    res.json(sanitize(house));
  } catch (e) {
    res.status(400).json({ error: 'Failed to update house', detail: e?.message });
  }
});

app.delete('/api/houses/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await prisma.house.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: 'Failed to delete house', detail: e?.message });
  }
});

// ── Admin: dashboard data ─────────────────────────────────────────────────────

/** Lightweight check for admin login (no DB schema dependencies). */
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get('/api/admin/houses', requireAdmin, async (req, res) => {
  try {
    const houses = await prisma.house.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(sanitize(houses));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch houses' });
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [houseRows, bookings, staticProps] = await Promise.all([
      prisma.$queryRaw`SELECT "listingType", "isActive" FROM "House"`.catch(() =>
        prisma.house.findMany({ select: { isActive: true } }).then((rows) =>
          rows.map((h) => ({ listingType: 'Rent', isActive: h.isActive })),
        ),
      ),
      prisma.booking.findMany({ select: { status: true, totalPrice: true } }),
      Promise.resolve(readProperties()),
    ]);

    const houses = houseRows ?? [];
    const dbRent = houses.filter((h) => (h.listingType ?? 'Rent') !== 'Sale').length;
    const dbSale = houses.filter((h) => h.listingType === 'Sale').length;
    
    

    const bookingByStatus = { PENDING: 0, CONFIRMED: 0, CANCELLED: 0 };
    let bookingRevenue = 0;
    for (const b of bookings) {
      const s = b.status || 'PENDING';
      bookingByStatus[s] = (bookingByStatus[s] || 0) + 1;
      if (s === 'CONFIRMED') bookingRevenue += fromPriceBigInt(b.totalPrice);
    }

    const activeListings =
      houses.filter((h) => h.isActive).length;

    res.json({
      listings: {
        rent: dbRent,
        sale: dbSale,
        active: activeListings,
        total: houses.length,
      },
      bookings: {
        byStatus: bookingByStatus,
        total: bookings.length,
        confirmedRevenue: bookingRevenue,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load stats', detail: e?.message });
  }
});

// ── Admin: static properties.json CRUD ──────────────────────────────────────

app.get('/api/admin/properties', requireAdmin, (req, res) => {
  res.json(readProperties());
});

app.post('/api/admin/properties', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['title', 'city', 'price', 'type']);
    if (missing) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const list = readProperties();
    const entry = {
      id: nextPropertyId(list),
      title: String(body.title).trim(),
      city: String(body.city).trim(),
      price: String(body.price).trim(),
      bedrooms: Number(body.bedrooms) || 0,
      bathrooms: Number(body.bathrooms) || 0,
      sqft: Number(body.sqft) || 0,
      type: normalizeListingType(body.type),
      badge: String(body.badge || 'Available').trim(),
      image: body.image ? String(body.image) : '',
      gallery: Array.isArray(body.gallery) ? body.gallery : [],
      videos: Array.isArray(body.videos) ? body.videos : [],
    };
    list.push(entry);
    writeProperties(list);
    res.status(201).json(entry);
  } catch (e) {
    res.status(400).json({ error: 'Failed to create property', detail: e?.message });
  }
});

app.put('/api/admin/properties/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const list = readProperties();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Property not found' });

  const body = req.body || {};
  const current = list[idx];
  list[idx] = {
    ...current,
    ...(body.title !== undefined && { title: String(body.title).trim() }),
    ...(body.city !== undefined && { city: String(body.city).trim() }),
    ...(body.price !== undefined && { price: String(body.price).trim() }),
    ...(body.type !== undefined && { type: normalizeListingType(body.type) }),
    ...(body.badge !== undefined && { badge: String(body.badge).trim() }),
    ...(body.bedrooms !== undefined && { bedrooms: Number(body.bedrooms) }),
    ...(body.bathrooms !== undefined && { bathrooms: Number(body.bathrooms) }),
    ...(body.sqft !== undefined && { sqft: Number(body.sqft) }),
    ...(body.image !== undefined && { image: String(body.image) }),
    ...(body.gallery !== undefined && { gallery: body.gallery }),
    ...(body.videos !== undefined && { videos: body.videos }),
  };
  writeProperties(list);
  res.json(list[idx]);
});

app.delete('/api/admin/properties/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const list = readProperties();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return res.status(404).json({ error: 'Property not found' });
  writeProperties(next);
  res.status(204).end();
});

// ── Bookings ──────────────────────────────────────────────────────────────────

app.get('/api/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      include: { house: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(sanitize(bookings));
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const body = req.body || {};
    const missing = requireFields(body, ['houseId', 'guestName', 'guestEmail', 'checkIn', 'checkOut']);
    if (missing) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const { houseId, guestName, guestEmail, checkIn, checkOut } = body;

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    if (isNaN(checkInDate) || isNaN(checkOutDate)) {
      return res.status(400).json({ error: 'Invalid checkIn or checkOut date' });
    }
    if (checkOutDate <= checkInDate) {
      return res.status(400).json({ error: 'checkOut must be after checkIn' });
    }

    const house = await prisma.house.findUnique({ where: { id: Number(houseId) } });
    if (!house || !house.isActive) {
      return res.status(400).json({ error: 'House not found or inactive' });
    }

    const nights = Math.max(
      1,
      Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24)),
    );
    const pricePerNight = fromPriceBigInt(house.pricePerNight);
    const totalPrice = toPriceBigInt(nights * pricePerNight);

    const booking = await prisma.booking.create({
      data: {
        houseId: Number(houseId),
        guestName: String(guestName).trim(),
        guestEmail: String(guestEmail).trim().toLowerCase(),
        checkIn: checkInDate,
        checkOut: checkOutDate,
        totalPrice,
      },
    });
    res.status(201).json(sanitize(booking));
  } catch (e) {
    res.status(400).json({ error: 'Failed to create booking', detail: e?.message });
  }
});

app.put('/api/bookings/:id/status', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const { status } = req.body || {};
  const validStatuses = ['PENDING', 'CONFIRMED', 'CANCELLED'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const updated = await prisma.booking.update({ where: { id }, data: { status } });
    res.json(sanitize(updated));
  } catch (e) {
    res.status(400).json({ error: 'Failed to update booking status', detail: e?.message });
  }
});


// ── Paystack Payments ─────────────────────────────────────────────────────────

app.post('/api/verify-payment', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = await response.json();
    if (data.data?.status === 'success') {
      res.json({ success: true, data: data.data });
    } else {
      res.status(400).json({ success: false, error: 'Payment not successful' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Verification failed', detail: e?.message });
  }
});

app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(
      'https://api.paystack.co/transaction?perPage=100',
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = await response.json();

    function getMeta(fields, key) {
      if (!Array.isArray(fields)) return '';
      return fields.find((f) => f.variable_name === key)?.value ?? '';
    }

    const transactions = (data.data ?? []).map((t) => {
      const meta = t.metadata?.custom_fields ?? [];
      const metaName = getMeta(meta, 'full_name');
      const customerName =
        metaName ||
        [t.customer?.first_name, t.customer?.last_name].filter(Boolean).join(' ') ||
        t.customer?.email ||
        '—';
      return {
        reference: t.reference,
        amount: t.amount,
        status: t.status,
        channel: t.channel,
        currency: t.currency,
        customerName,
        customerEmail: t.customer?.email ?? '—',
        phone: getMeta(meta, 'phone'),
        property: getMeta(meta, 'property'),
        intent: getMeta(meta, 'intent'),
        paidAt: t.paid_at,
      };
    });
    res.json(transactions);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch payments', detail: e?.message });
  }
});

app.get('/api/admin/payments/:reference', requireAdmin, async (req, res) => {
  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(req.params.reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = await response.json();
    if (!data.data) return res.status(404).json({ error: 'Transaction not found' });
    res.json(data.data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch receipt', detail: e?.message });
  }
});


app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API key not configured' });

  let listingsContext = '';
  try {
    const [houses, properties] = await Promise.all([
      prisma.house.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } }),
      Promise.resolve(readProperties()),
    ]);
    const all = [
      ...sanitize(houses).map(h =>
        `[DB] ${h.title} | ${h.city} | \u20a6${Number(h.pricePerNight).toLocaleString('en-NG')}/night | ${h.bedrooms}bed ${h.bathrooms}bath | Type: ${h.listingType}`
      ),
      ...properties.map(p =>
        `[Listing] ${p.title} | ${p.city} | ${p.price} | ${p.bedrooms}bed ${p.bathrooms}bath | Type: ${p.type}`
      ),
    ];
    listingsContext = all.length
      ? `\n\nCurrent NawftHomes listings:\n${all.join('\n')}`
      : '\n\nNo active listings at the moment.';
  } catch (_) {}

  const systemPrompt = `You are Nawft, a friendly and knowledgeable AI assistant for NawftHomes - a Nigerian real estate company based in Ibadan.
Your job is to help visitors learn about available properties, understand how to book a viewing, and answer questions about renting or buying.
Keep answers concise, warm, and helpful. Always respond in plain text (no markdown).
Contact: 09027512008 (call or WhatsApp). Office: 16, Islamic Shopping Mall, Mall Block D (Upstairs), Bashorun, Ibadan.
Payments are handled securely via Paystack. Viewings require 24-hour advance notice.${listingsContext}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.text })),
    { role: 'user', content: message },
  ];

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 400,
        temperature: 0.7,
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      return res.status(500).json({ error: data?.error?.message || 'Groq error' });
    }
    const reply = data.choices?.[0]?.message?.content?.trim() || 'Sorry, I could not get a response.';
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reach Groq', detail: e?.message });
  }
});


const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
// ── Gemini Chatbot ────────────────────────────────────────────────────────────