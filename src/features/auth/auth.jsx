import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createTimeline, stagger } from 'animejs';
import { API_BASE } from '../../core/config.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Shared flat backdrop for the entry pages: dot-grid paper with a few
// bordered shapes floating off the grid.
export function PageBackdrop() {
  return (
    <div className="page-backdrop" aria-hidden="true">
      <div className="page-backdrop-grid" />
      <div className="page-backdrop-shape shape-circle" />
      <div className="page-backdrop-shape shape-square" />
      <div className="page-backdrop-shape shape-pill" />
    </div>
  );
}

// ── Auth Context ──

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('pcb_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => {
        // Only a genuine rejection of the token should clear the session; a
        // network/timeout/abort failure must leave the stored token intact.
        if (r.status === 401 || r.status === 403) {
          if (!cancelled) { localStorage.removeItem('pcb_token'); setToken(null); }
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((data) => { if (!cancelled && data?.user) setUser(data.user); })
      .catch(() => { /* offline/aborted: keep the token and retry on next load */ })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [token]);

  const login = (newToken, userData) => {
    localStorage.setItem('pcb_token', newToken);
    setToken(newToken);
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('pcb_token');
    setToken(null);
    setUser(null);
    window.location.hash = '';
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// ── Home Page ──

export function HomePage() {
  const pageRef = useRef(null);

  // Entrance choreography: hero copy pops in first, then the pipeline steps
  // cascade. Skipped entirely for reduced-motion users.
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return undefined;
    const q = (selector) => pageRef.current.querySelectorAll(selector);
    const tl = createTimeline({ defaults: { ease: 'outCubic', duration: 550 } });
    tl.add(q('.home-eyebrow'), { translateY: [18, 0], opacity: [0, 1] })
      .add(q('.home-title'), {
        translateY: [26, 0],
        opacity: [0, 1],
        rotate: ['-6deg', '-1.5deg'],
        duration: 700,
        ease: 'outBack',
      }, '-=350')
      .add(q('.home-subtitle'), { translateY: [20, 0], opacity: [0, 1] }, '-=450')
      .add(q('.home-actions'), { translateY: [16, 0], opacity: [0, 1], duration: 500 }, '-=400')
      .add(q('.pipeline-step, .pipeline-arrow'), {
        translateY: [24, 0],
        opacity: [0, 1],
        duration: 500,
        delay: stagger(70),
      }, '-=250');
    return () => tl.revert();
  }, []);

  return (
    <main className="home-page" ref={pageRef}>
      <PageBackdrop />
      <div className="home-hero">
        <p className="home-eyebrow">Prompt → Schematic → Simulation → Board</p>
        <h1 className="home-title">PCB Pilot</h1>
        <p className="home-subtitle">
          Describe a circuit in plain English. Get a validated schematic,
          SPICE simulation, and KiCad-ready netlist — in seconds.
        </p>
        <div className="home-actions">
          <a href="#login" className="btn btn-primary">Log in</a>
          <a href="#signup" className="btn btn-outline">Create account</a>
        </div>
      </div>

      <div className="home-pipeline">
        <div className="pipeline-step">
          <span className="pipeline-number">1</span>
          <h3>Describe</h3>
          <p>Type a prompt like &ldquo;low-pass RC filter at 1kHz&rdquo;</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">2</span>
          <h3>Generate</h3>
          <p>AI builds a validated circuit model with real component values</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">3</span>
          <h3>Simulate</h3>
          <p>Ngspice runs a real SPICE simulation and returns waveforms</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">4</span>
          <h3>Export</h3>
          <p>Download KiCad netlist, SPICE deck, and circuit JSON</p>
        </div>
      </div>
    </main>
  );
}

// ── Login Page ──

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (submitting) return;

    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Unable to log in. Please try again.'); return; }
      login(data.token, data.user);
      window.location.hash = '';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <PageBackdrop />
      <form className="auth-card" onSubmit={handleSubmit} noValidate>
        <h2>Log in to PCB Pilot</h2>
        {error && <div className="auth-error">{error}</div>}
        <label className="auth-label">
          Email
          <input
            type="email"
            className="auth-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="auth-label">
          Password
          <input
            type="password"
            className="auth-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          {submitting ? 'Logging in...' : 'Log in'}
        </button>
        <p className="auth-switch">
          Don&rsquo;t have an account? <a href="#signup">Sign up</a>
        </p>
      </form>
    </main>
  );
}

// ── Signup Page ──

export function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (submitting) return;

    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Unable to create account. Please try again.'); return; }
      setSuccess(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <main className="auth-page">
        <PageBackdrop />
        <div className="auth-card">
          <h2>Check your email</h2>
          <p className="auth-success-msg">
            We sent a verification link to <strong>{email}</strong>.
            Click the link in the email, then <a href="#login">log in</a>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <PageBackdrop />
      <form className="auth-card" onSubmit={handleSubmit} noValidate>
        <h2>Create your account</h2>
        {error && <div className="auth-error">{error}</div>}
        <label className="auth-label">
          Email
          <input
            type="email"
            className="auth-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="auth-label">
          Password
          <input
            type="password"
            className="auth-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label className="auth-label">
          Confirm password
          <input
            type="password"
            className="auth-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Sign up'}
        </button>
        <p className="auth-switch">
          Already have an account? <a href="#login">Log in</a>
        </p>
      </form>
    </main>
  );
}

// ── Email Verification Handler ──

export function VerifyPage() {
  const [status, setStatus] = useState('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/token=([a-f0-9]+)/);
    if (!match) { setStatus('error'); setMessage('No verification token found.'); return; }

    fetch(`${API_BASE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: match[1] }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
      .then(({ ok, data }) => {
        setStatus(ok ? 'success' : 'error');
        setMessage(ok ? data.message : data.error);
      })
      .catch(() => { setStatus('error'); setMessage('Network error.'); });
  }, []);

  return (
    <main className="auth-page">
      <PageBackdrop />
      <div className="auth-card">
        {status === 'verifying' && <p>Verifying your email...</p>}
        {status === 'success' && (
          <>
            <h2>Email verified</h2>
            <p className="auth-success-msg">{message} <a href="#login">Log in now</a></p>
          </>
        )}
        {status === 'error' && (
          <>
            <h2>Verification failed</h2>
            <p className="auth-error">{message}</p>
          </>
        )}
      </div>
    </main>
  );
}
