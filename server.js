const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || 'https://americanpatriotnews.news';

// --- Firebase Admin Setup ---
// Initialize with project ID (uses Application Default Credentials or service account)
let db;
try {
  admin.initializeApp({
    projectId: 'remotejobs-db8b0'
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully');
} catch (err) {
  console.warn('Firebase Admin init warning:', err.message);
  console.warn('Running without Firestore — articles will use local fallback');
  db = null;
}

// --- Stripe Setup ---
// Uses test key by default — replace with live key for production
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_PLACEHOLDER';
let stripe;
try {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
} catch (err) {
  console.warn('Stripe init warning:', err.message);
  stripe = null;
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname), {
  extensions: ['html']
}));

// --- In-Memory Article Store (fallback when Firestore unavailable) ---
let localArticles = [];

// --- API Routes ---

// Get all articles
app.get('/api/articles', async (req, res) => {
  try {
    if (db) {
      const snapshot = await db.collection('articles').orderBy('date', 'desc').get();
      const articles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      return res.json(articles);
    }
    res.json(localArticles);
  } catch (err) {
    console.error('Error fetching articles:', err.message);
    res.json(localArticles);
  }
});

// Create article
app.post('/api/articles', async (req, res) => {
  const article = {
    title: req.body.title || '',
    category: req.body.category || 'Politics',
    author: req.body.author || 'Staff Writer',
    summary: req.body.summary || '',
    body: req.body.body || '',
    imageUrl: req.body.imageUrl || '',
    section: req.body.section || 'politics',
    premium: req.body.premium || false,
    date: req.body.date || new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString()
  };

  // Try Firestore first, fall back to local
  if (db) {
    try {
      const docRef = await db.collection('articles').add(article);
      return res.json({ id: docRef.id, ...article });
    } catch (err) {
      console.warn('Firestore write failed, using local:', err.message);
    }
  }

  // Local fallback
  article.id = 'local_' + Date.now();
  localArticles.unshift(article);
  res.json(article);
});

// Update article
app.put('/api/articles/:id', async (req, res) => {
  const { id } = req.params;
  const updates = {
    title: req.body.title,
    category: req.body.category,
    author: req.body.author,
    summary: req.body.summary,
    body: req.body.body,
    imageUrl: req.body.imageUrl,
    section: req.body.section,
    premium: req.body.premium,
    date: req.body.date,
    updatedAt: new Date().toISOString()
  };
  Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

  if (db) {
    try {
      await db.collection('articles').doc(id).update(updates);
      return res.json({ id, ...updates });
    } catch (err) {
      console.warn('Firestore update failed, using local:', err.message);
    }
  }

  const idx = localArticles.findIndex(a => a.id === id);
  if (idx >= 0) {
    localArticles[idx] = { ...localArticles[idx], ...updates };
    return res.json(localArticles[idx]);
  }
  res.status(404).json({ error: 'Article not found' });
});

// Delete article
app.delete('/api/articles/:id', async (req, res) => {
  const { id } = req.params;

  if (db) {
    try {
      await db.collection('articles').doc(id).delete();
      return res.json({ deleted: true });
    } catch (err) {
      console.warn('Firestore delete failed, using local:', err.message);
    }
  }

  localArticles = localArticles.filter(a => a.id !== id);
  res.json({ deleted: true });
});

// --- Stripe: Top Comment ($5 Pin) ---
app.post('/api/create-pin-session', async (req, res) => {
  const { email } = req.body;

  if (!stripe || STRIPE_SECRET_KEY === 'sk_test_PLACEHOLDER') {
    return res.json({
      demo: true,
      message: 'Top Comment payment of $5 would be processed. Set STRIPE_SECRET_KEY to enable.'
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Top Comment — The American Patriot',
            description: 'Pin your comment to the top of the discussion for 24 hours.'
          },
          unit_amount: 500,
        },
        quantity: 1,
      }],
      customer_email: email || undefined,
      success_url: `${BASE_URL}/?donated=true#comments`,
      cancel_url: `${BASE_URL}/?canceled=true#comments`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe pin error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Stripe: Create Subscription Checkout Session ---
app.post('/api/create-checkout-session', async (req, res) => {
  const { plan, email } = req.body;

  // Price mapping — replace these with your actual Stripe Price IDs
  const prices = {
    monthly: process.env.STRIPE_PRICE_MONTHLY || 'price_monthly_placeholder',
    annual: process.env.STRIPE_PRICE_ANNUAL || 'price_annual_placeholder',
    founding: process.env.STRIPE_PRICE_FOUNDING || 'price_founding_placeholder'
  };

  if (!stripe || STRIPE_SECRET_KEY === 'sk_test_PLACEHOLDER') {
    return res.json({
      demo: true,
      message: `Stripe checkout would redirect for "${plan}" plan at ${plan === 'monthly' ? '$5/mo' : plan === 'annual' ? '$39/yr' : '$99/yr'}. Set STRIPE_SECRET_KEY env var and create Price IDs in Stripe Dashboard to enable.`
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: plan === 'monthly' ? 'subscription' : 'subscription',
      line_items: [{ price: prices[plan], quantity: 1 }],
      customer_email: email || undefined,
      success_url: `${BASE_URL}/?subscribed=true`,
      cancel_url: `${BASE_URL}/?canceled=true`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Stripe: Create Donation Checkout Session ---
app.post('/api/create-donation-session', async (req, res) => {
  const { amount, email } = req.body;

  if (!stripe || STRIPE_SECRET_KEY === 'sk_test_PLACEHOLDER') {
    return res.json({
      demo: true,
      message: `Stripe donation checkout would process $${amount}. Set STRIPE_SECRET_KEY env var to enable live payments.`
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Donation to The American Patriot',
            description: `Thank you for your $${amount} contribution to independent conservative media.`
          },
          unit_amount: amount * 100, // cents
        },
        quantity: 1,
      }],
      customer_email: email || undefined,
      success_url: `${BASE_URL}/?donated=true`,
      cancel_url: `${BASE_URL}/?canceled=true`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe donation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Fallback: serve index.html for unknown routes ---
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`\n  The American Patriot`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Admin panel at http://localhost:${PORT}/admin.html`);
  console.log(`  Stripe: ${STRIPE_SECRET_KEY === 'sk_test_PLACEHOLDER' ? 'DEMO MODE (set STRIPE_SECRET_KEY)' : 'LIVE'}`);
  console.log(`  Firestore: ${db ? 'CONNECTED' : 'LOCAL FALLBACK'}\n`);
});
