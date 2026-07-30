import React, { useEffect, useRef } from 'react';
import { createTimeline, stagger } from 'animejs';
import { BreadboardPreview } from '../realisticSchematic/BreadboardPreview.jsx';

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

export function LandingPage() {
  const pageRef = useRef(null);

  // Entrance choreography: hero copy pops in first, then the pipeline steps
  // cascade. Skipped entirely for reduced-motion users.
  useEffect(() => {
    if (prefersReducedMotion() || !pageRef.current) return undefined;
    const q = (selector) => pageRef.current.querySelectorAll(selector);
    const tl = createTimeline({ defaults: { ease: 'outCubic', duration: 550 } });
    tl.add(q('.home-hero .home-eyebrow'), { translateY: [18, 0], opacity: [0, 1] })
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
      <div className="home-hero">
        <p className="home-eyebrow">Prompt → Schematic → Simulation → Board</p>
        <h1 className="home-title">Impedo</h1>
        <p className="home-subtitle">
          Describe a circuit in plain English. Get a validated schematic,
          SPICE simulation, and KiCad-ready netlist — in seconds.
        </p>
        <div className="home-actions">
          <a href="#app" className="btn btn-primary">Start</a>
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

      <section className="home-cases" aria-label="Example builds">
        <div className="home-cases-header">
          <p className="home-eyebrow">Real breadboards, real parts</p>
          <h2 className="home-cases-title">See it the way you&rsquo;d build it</h2>
          <p className="home-cases-subtitle">
            Every circuit also renders as a realistic breadboard — actual part
            footprints, labeled pins, and jumper wires routed hole to hole.
          </p>
        </div>

        {HOME_CASES.map(({ tag, accent, title, body, prompt, circuit, alt }) => (
          <article className={`case-card case-accent-${accent}`} key={title}>
            <div className="case-visual">
              <BreadboardPreview circuit={circuit} className="case-art" ariaLabel={alt} />
            </div>
            <div className="case-body">
              <span className="case-tag">{tag}</span>
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
