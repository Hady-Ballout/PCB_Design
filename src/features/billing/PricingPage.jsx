import React, { useEffect, useState } from 'react';
import { PageBackdrop, useAuth } from '../auth/auth.jsx';
import { createCheckoutSession, fetchBillingStatus } from './billing.js';
import './billing.css';

// Display copy only — enforcement lives in the backend's PLAN_LIMITS and the
// actual amounts live in Stripe's dashboard prices.
const TIERS = [
  {
    id: 'free',
    name: 'Free',
    price: { month: '$0', year: '$0' },
    tagline: 'Try real AI circuit design.',
    features: [
      '5 AI circuit generations / month',
      '20 Plan & Ask assists / month',
      'Unlimited SPICE simulations',
      'KiCad netlist & firmware export',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: { month: '$15', year: '$150' },
    interval: { month: '/month', year: '/year' },
    tagline: 'For makers shipping real projects.',
    features: [
      '200 AI circuit generations / month',
      'Unlimited Plan & Ask assists',
      'Unlimited SPICE simulations',
      'KiCad netlist & firmware export',
    ],
    highlight: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: { month: '$40', year: '$400' },
    interval: { month: '/month', year: '/year' },
    tagline: 'For heavy and shared use.',
    features: [
      'Unlimited generations (fair use)',
      'Unlimited Plan & Ask assists',
      'Unlimited SPICE simulations',
      'Priority support',
    ],
  },
];

export function PricingPage() {
  const { user } = useAuth();
  const [interval, setInterval] = useState('month');
  const [currentPlan, setCurrentPlan] = useState(null);
  const [busyPlan, setBusyPlan] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchBillingStatus().then((status) => {
      if (!cancelled && status) setCurrentPlan(status.plan);
    });
    return () => { cancelled = true; };
  }, [user]);

  const choose = async (tierId) => {
    if (tierId === 'free') {
      window.location.hash = user ? '' : '#signup';
      return;
    }
    if (!user) {
      window.location.hash = '#signup';
      return;
    }
    setError('');
    setBusyPlan(tierId);
    try {
      const { url } = await createCheckoutSession(tierId, interval);
      window.location.assign(url);
    } catch (checkoutError) {
      setError(checkoutError.message);
      setBusyPlan(null);
    }
  };

  const buttonLabel = (tier) => {
    if (tier.id === currentPlan) return 'Current plan';
    if (busyPlan === tier.id) return 'Redirecting…';
    if (tier.id === 'free') return user ? 'Included' : 'Start free';
    return `Get ${tier.name}`;
  };

  return (
    <main className="pricing-page">
      <PageBackdrop />
      <div className="pricing-header">
        <p className="home-eyebrow">Plans &amp; pricing</p>
        <h1>Build more circuits</h1>
        <p className="pricing-subtitle">
          Every plan includes the full workspace — schematics, breadboards,
          simulation, and exports. Paid plans raise the AI limits.
        </p>
        <div className="pricing-toggle" role="group" aria-label="Billing interval">
          <button
            type="button"
            className={interval === 'month' ? 'active' : ''}
            onClick={() => setInterval('month')}
          >
            Monthly
          </button>
          <button
            type="button"
            className={interval === 'year' ? 'active' : ''}
            onClick={() => setInterval('year')}
          >
            Annual <span className="pricing-toggle-note">2 months free</span>
          </button>
        </div>
        {error && <div className="auth-error pricing-error">{error}</div>}
      </div>

      <div className="pricing-grid">
        {TIERS.map((tier) => (
          <article
            className={`pricing-card${tier.highlight ? ' highlighted' : ''}${tier.id === currentPlan ? ' current' : ''}`}
            key={tier.id}
          >
            {tier.highlight && <span className="pricing-badge">Most popular</span>}
            <h2>{tier.name}</h2>
            <p className="pricing-price">
              {tier.price[interval]}
              {tier.interval && <span className="pricing-interval">{tier.interval[interval]}</span>}
            </p>
            <p className="pricing-tagline">{tier.tagline}</p>
            <ul className="pricing-features">
              {tier.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            <button
              type="button"
              className={`btn ${tier.highlight ? 'btn-primary' : 'btn-outline'} pricing-cta`}
              onClick={() => choose(tier.id)}
              disabled={busyPlan !== null || tier.id === currentPlan || (tier.id === 'free' && Boolean(user))}
            >
              {buttonLabel(tier)}
            </button>
          </article>
        ))}
      </div>

      <p className="pricing-footnote">
        Payments and invoices are handled by Stripe. Cancel or switch plans
        any time from Manage subscription in the workspace.
        {' '}
        <a href={user ? '#' : '#login'}>{user ? 'Back to the workspace' : 'Log in'}</a>
      </p>
    </main>
  );
}
