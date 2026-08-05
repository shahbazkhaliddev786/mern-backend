import Stripe from 'stripe';
import config from './config.js';

// Initialize with a dummy key if missing so it doesn't crash the entire app on startup.
// It will fail when actually used if the environment variable is not set.
export const stripeClient = new Stripe(config.STRIPE_SECRET || 'sk_test_fallback');