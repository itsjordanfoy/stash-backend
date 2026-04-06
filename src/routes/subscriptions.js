const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { query } = require('../database/db');
const { authenticate, loadUserData } = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

// GET /api/subscriptions/status
router.get('/status', authenticate, async (req, res) => {
  const result = await query(
    `SELECT subscription_status, subscription_end_at, imports_used FROM users WHERE id = $1`,
    [req.user.id]
  );
  const user = result.rows[0];
  res.json({
    status: user.subscription_status,
    end_at: user.subscription_end_at,
    imports_used: user.imports_used,
    free_limit: 5,
    is_paid: user.subscription_status === 'paid',
  });
});

// POST /api/subscriptions/checkout  — create Stripe Checkout session
router.post('/checkout', authenticate, loadUserData, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      metadata: { userId: req.user.id },
      success_url: `${process.env.APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/subscription/cancel`,
      customer_email: req.user.email,
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    logger.error('Stripe checkout error', { error: err.message });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/subscriptions/portal  — Stripe customer portal
router.post('/portal', authenticate, async (req, res) => {
  try {
    const userResult = await query(
      'SELECT subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const subscriptionId = userResult.rows[0]?.subscription_id;
    if (!subscriptionId) return res.status(400).json({ error: 'No active subscription' });

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.customer,
      return_url: `${process.env.APP_URL}/settings`,
    });

    res.json({ portalUrl: session.url });
  } catch (err) {
    logger.error('Stripe portal error', { error: err.message });
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// POST /api/subscriptions/webhook  — raw body (configured in index.js)
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Stripe webhook signature failed', { error: err.message });
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await query(
          `UPDATE users
           SET subscription_status = 'paid',
               subscription_id = $1,
               stripe_customer_id = $2
           WHERE id = $3`,
          [session.subscription, session.customer, session.metadata.userId]
        );
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = await getUserIdFromCustomer(sub.customer);
        if (userId) {
          await query(
            `UPDATE users
             SET subscription_status = $1,
                 subscription_end_at = to_timestamp($2)
             WHERE id = $3`,
            [sub.status === 'active' ? 'paid' : sub.status, sub.current_period_end, userId]
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const userId = await getUserIdFromCustomer(sub.customer);
        if (userId) {
          await query(
            `UPDATE users SET subscription_status = 'cancelled' WHERE id = $1`,
            [userId]
          );
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const userId = await getUserIdFromCustomer(invoice.customer);
        if (userId) {
          await query(
            `UPDATE users SET subscription_status = 'past_due' WHERE id = $1`,
            [userId]
          );
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook processing error', { type: event.type, error: err.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function getUserIdFromCustomer(customerId) {
  const result = await query(
    `SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return result.rows[0]?.id || null;
}

module.exports = router;
