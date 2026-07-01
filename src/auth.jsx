import React, { createContext, useContext, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ── Auth Context ──

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('pcb_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setUser(data.user))
      .catch(() => { localStorage.removeItem('pcb_token'); setToken(null); })
      .finally(() => setLoading(false));
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
  return (
    <main className="home-page">
      <div className="home-hero">
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

  const handleSubmit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      login(data.token, data.user);
      window.location.hash = 'workspace';
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
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
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        </label>
        <button className="btn btn-primary auth-submit" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Logging in...' : 'Log in'}
        </button>
        <p className="auth-switch">
          Don&rsquo;t have an account? <a href="#signup">Sign up</a>
        </p>
      </div>
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

  const handleSubmit = async () => {
    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
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
      <div className="auth-card">
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
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        </label>
        <button className="btn btn-primary auth-submit" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Creating account...' : 'Sign up'}
        </button>
        <p className="auth-switch">
          Already have an account? <a href="#login">Log in</a>
        </p>
      </div>
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
