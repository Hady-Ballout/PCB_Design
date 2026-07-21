// Thin client for the backend billing routes. All three endpoints require the
// stored JWT; callers handle a null/failed result as "billing unavailable".
import { API_BASE } from '../../core/config.js';

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('pcb_token')}`,
});

// → {url} for redirecting to Stripe's hosted checkout.
export async function createCheckoutSession(plan, interval) {
  const res = await fetch(`${API_BASE}/api/billing/checkout`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ plan, interval }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
  return data;
}

// → {url} for Stripe's hosted subscription-management portal.
export async function openBillingPortal() {
  const res = await fetch(`${API_BASE}/api/billing/portal`, {
    method: 'POST',
    headers: authHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not open the billing portal.');
  return data;
}

// → {plan, planStatus, periodEnd, usage, limits} or null when unavailable.
export async function fetchBillingStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/billing/status`, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
