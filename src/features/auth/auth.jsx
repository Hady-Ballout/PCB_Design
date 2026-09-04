import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createTimeline, stagger } from 'animejs';
import { API_BASE } from '../../core/config.js';
import { BreadboardPreview } from '../realisticSchematic/BreadboardPreview.jsx';
import { placeholderAt } from '../landing/typingPlaceholder.js';
import { stashPendingPrompt } from '../landing/pendingPrompt.js';

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

// Real circuits fed to the actual realistic-schematic renderer for the
// use-case cards. These run through the same `circuitToBreadboard` transform
// and part artwork the interactive breadboard view uses (see BreadboardPreview)
// — the cards show the genuine generated board, not a drawing. Node/pin orders
// follow the positional contracts in core/componentKinds.js.

// Helper: an Arduino Uno's 24-pin node array with only the named pins wired and
// the rest left on NC placeholders. `pins` maps a canonical pin name → net.
const UNO_PINS = ['5V', '3V3', 'GND', 'VIN', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
const unoNodes = (pins) =>
  UNO_PINS.map((name, index) => pins[name] ?? `NC_U1_${index + 1}`);

// Thermistor divider on A0 + I2C OLED (SDA=A4, SCL=A5), powered off the Uno.
const THERMOMETER_CIRCUIT = {
  title: 'OLED thermometer',
  components: [
    { ref: 'U1', kind: 'arduino_uno', value: 'Uno R3', nodes: unoNodes({ '5V': 'VCC5', GND: '0', A0: 'TH', A4: 'SDA', A5: 'SCL' }) },
    { ref: 'RT1', kind: 'thermistor', value: '10k', nodes: ['VCC5', 'TH'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['TH', '0'] },
    { ref: 'U2', kind: 'oled_display', value: 'SSD1306', nodes: ['VCC5', '0', 'SCL', 'SDA'] },
  ],
};

// HC-SR04 on D9/D10, a buzzer on D8, and two indicator LEDs on D5/D6.
const DISTANCE_CIRCUIT = {
  title: 'Ultrasonic parking alarm',
  components: [
    { ref: 'U1', kind: 'arduino_uno', value: 'Uno R3', nodes: unoNodes({ '5V': 'VCC5', GND: '0', D5: 'LED2', D6: 'LED1', D8: 'BUZ', D9: 'TRIG', D10: 'ECHO' }) },
    { ref: 'U2', kind: 'ultrasonic_sensor', value: 'HC-SR04', nodes: ['VCC5', 'TRIG', 'ECHO', '0'] },
    { ref: 'BZ1', kind: 'buzzer', value: '', nodes: ['BUZ', '0'] },
    { ref: 'R1', kind: 'resistor', value: '220', nodes: ['LED1', 'LED1K'] },
    { ref: 'D1', kind: 'led', value: 'red', nodes: ['LED1K', '0'] },
    { ref: 'R2', kind: 'resistor', value: '220', nodes: ['LED2', 'LED2K'] },
    { ref: 'D2', kind: 'led', value: 'yellow', nodes: ['LED2K', '0'] },
  ],
};

// Analog night light: an LDR/resistor divider biases an NPN that drives the LED
// as the room darkens — no microcontroller.
const NIGHT_LIGHT_CIRCUIT = {
  title: 'Dusk night light',
  components: [
    { ref: 'V1', kind: 'voltage_source', value: '5V', nodes: ['VCC', '0'] },
    { ref: 'R1', kind: 'resistor', value: '10k', nodes: ['VCC', 'BASE'] },
    { ref: 'LDR1', kind: 'photoresistor', value: '10k', nodes: ['BASE', '0'] },
    { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['LEDK', 'BASE', '0'] },
    { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC', 'LEDA'] },
    { ref: 'D1', kind: 'led', value: 'red', nodes: ['LEDA', 'LEDK'] },
  ],
};

const HOME_CASES = [
  {
    tag: 'Sensors + Display',
    accent: 'pink',
    title: 'Room thermometer with an OLED readout',
    body: 'Ask for a thermistor thermometer and watch it come together on a real '
      + 'breadboard: an Arduino Uno, the sensor divider seated in the rails, and '
      + 'an I2C OLED wired up with color-coded jumpers you can trace hole by hole.',
    prompt: '“Arduino thermometer that shows °C on an OLED display”',
    circuit: THERMOMETER_CIRCUIT,
    alt: 'Arduino Uno, thermistor divider, and I2C OLED on a breadboard',
  },
  {
    tag: 'Distance + Sound',
    accent: 'blue',
    title: 'Parking sensor that beeps as you get close',
    body: 'An HC-SR04 ultrasonic sensor, a buzzer, and indicator LEDs — placed '
      + 'like the real parts, with pin labels on every leg. Tap any pin to '
      + 'highlight its whole net across the board.',
    prompt: '“Ultrasonic distance alarm that beeps faster as things get closer”',
    circuit: DISTANCE_CIRCUIT,
    alt: 'HC-SR04 ultrasonic sensor, buzzer, and LEDs wired to an Arduino Uno',
  },
  {
    tag: 'Light + Automation',
    accent: 'purple',
    title: 'Night light that switches on at dusk',
    body: 'A photoresistor divider drives an LED that fades up when the room '
      + 'goes dark. The breadboard view mirrors exactly what you would build on '
      + 'your desk — so you can follow it wire for wire.',
    prompt: '“Night light that turns an LED on when it gets dark”',
    circuit: NIGHT_LIGHT_CIRCUIT,
    alt: 'Photoresistor divider, transistor, and LED on a breadboard',
  },
];

// Example builds the hero prompt types out for itself, in the order they
// cycle. Each one is a prompt the generator actually handles.
const HERO_EXAMPLES = [
  'Blink an LED every 2 seconds with a 555 timer',
  'Arduino thermometer that shows °C on an OLED display',
  'Ultrasonic parking alarm that beeps faster as you get closer',
  'Night light that turns an LED on when it gets dark',
];

// Self-typing placeholder for the hero prompt. Reduced-motion users get the
// first example as a static placeholder instead of the animation.
function useTypingPlaceholder(examples) {
  const [text, setText] = useState(() => (prefersReducedMotion() ? examples[0] ?? '' : ''));
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const start = Date.now();
    const timer = setInterval(() => setText(placeholderAt(examples, Date.now() - start)), 30);
    return () => clearInterval(timer);
  }, [examples]);
  return text;
}

const twoDigits = (index) => String(index + 1).padStart(2, '0');

export function HomePage() {
  const { user } = useAuth();
  const pageRef = useRef(null);
  const [draft, setDraft] = useState('');
  const placeholder = useTypingPlaceholder(HERO_EXAMPLES);

  // The prompt survives the sign-up wall: stash it, send the visitor to
  // sign-up (or straight into the workspace when already signed in), and the
  // workspace drains it into the chat draft on mount.
  const submitPrompt = (event) => {
    event?.preventDefault();
    stashPendingPrompt(draft);
    window.location.hash = user ? 'app' : 'signup';
  };
  const onPromptKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) submitPrompt(event);
  };

  // Entrance choreography: hero copy pops in first, then the pipeline steps
  // cascade. Skipped entirely for reduced-motion users.
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return undefined;
    const q = (selector) => pageRef.current.querySelectorAll(selector);
    const tl = createTimeline({ defaults: { ease: 'outCubic', duration: 550 } });
    tl.add(q('.home-hero .home-eyebrow'), { translateY: [18, 0], opacity: [0, 1] })
      .add(q('.home-title'), { translateY: [26, 0], opacity: [0, 1], duration: 650 }, '-=350')
      .add(q('.home-subtitle'), { translateY: [20, 0], opacity: [0, 1] }, '-=450')
      .add(q('.home-prompt'), { translateY: [16, 0], opacity: [0, 1], duration: 500 }, '-=400')
      .add(q('.pipeline-step, .pipeline-arrow'), {
        translateY: [24, 0],
        opacity: [0, 1],
        duration: 500,
        delay: stagger(70),
      }, '-=250');
    return () => tl.revert();
  }, []);

  // Scroll reveal for the use-case cards: each card slides in once as it
  // enters the viewport. Reduced-motion users see them immediately (the
  // hidden state only exists under prefers-reduced-motion: no-preference).
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return undefined;
    const cards = pageRef.current.querySelectorAll('.case-card, .home-cases-header');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2 });
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, []);

  return (
    <main className="home-page" ref={pageRef}>
      <PageBackdrop />
      <header className="home-header">
        <a href="#home" className="brand-sticker">Impedo</a>
        <nav className="home-header-actions" aria-label="Account">
          <a href="#login" className="home-text-link">Log in</a>
          <a href="#signup" className="btn btn-primary">Start building free</a>
        </nav>
      </header>

      <div className="home-hero">
        <p className="home-eyebrow">Prompt → Schematic → Simulation → Board</p>
        <h1 className="home-title">From a sentence to a circuit you can build.</h1>
        <p className="home-subtitle">
          Describe a circuit in plain English. Get a validated schematic,
          SPICE simulation, and KiCad-ready netlist — in seconds.
        </p>
        <form className="home-prompt" onSubmit={submitPrompt}>
          <label className="sr-only" htmlFor="home-prompt-input">Describe what you want to build</label>
          <textarea
            id="home-prompt-input"
            className="home-prompt-input"
            rows={3}
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onPromptKeyDown}
          />
          <div className="home-prompt-actions">
            <span className="home-prompt-hint">Enter to build · Shift+Enter for a new line</span>
            <button type="submit" className="btn btn-primary">Build this →</button>
          </div>
        </form>
      </div>

      <div className="home-pipeline">
        <div className="pipeline-step">
          <span className="pipeline-number">01</span>
          <h3>Describe</h3>
          <p>Type a prompt like &ldquo;low-pass RC filter at 1kHz&rdquo;</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">02</span>
          <h3>Generate</h3>
          <p>AI builds a validated circuit model with real component values</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">03</span>
          <h3>Simulate</h3>
          <p>Ngspice runs a real SPICE simulation and returns waveforms</p>
        </div>
        <div className="pipeline-arrow">&rarr;</div>
        <div className="pipeline-step">
          <span className="pipeline-number">04</span>
          <h3>Export</h3>
          <p>Download KiCad netlist, SPICE deck, and circuit JSON</p>
        </div>
      </div>

      <section className="home-cases" aria-label="Example builds">
        <div className="home-cases-header">
          <p className="home-eyebrow">Real breadboards, real parts</p>
          <h2 className="home-cases-title">See it the way you&rsquo;d build it</h2>
          <p className="home-cases-subtitle">
            Every circuit also renders as a realistic breadboard — actual part
            footprints, labeled pins, and jumper wires routed hole to hole.
          </p>
        </div>

        {HOME_CASES.map(({ tag, accent, title, body, prompt, circuit, alt }, index) => (
          <article className={`case-card case-accent-${accent}`} key={title}>
            <div className="case-visual">
              <BreadboardPreview circuit={circuit} className="case-art" ariaLabel={alt} />
            </div>
            <div className="case-body">
              <span className="case-tag">{twoDigits(index)} · {tag}</span>
              <h3>{title}</h3>
              <p>{body}</p>
              <p className="case-prompt">{prompt}</p>
            </div>
          </article>
        ))}
      </section>
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
        <h2>Log in to Impedo</h2>
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
