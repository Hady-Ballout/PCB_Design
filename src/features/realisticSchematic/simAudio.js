// Web Audio for simulated buzzers. One square oscillator + gain per buzzer
// ref, created lazily on the first update — which happens inside the effect
// the Run click initiated, so Chrome's autoplay policy is satisfied. Gain
// changes ramp via setTargetAtTime so tones start and stop without pops.

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const ACTIVE_BUZZER_HZ = 2400; // typical active-buzzer tone for DC drive
const MAX_GAIN = 0.15;

export const createSimAudio = () => {
  let context = null;
  const voices = new Map(); // ref -> { oscillator, gain }

  const voiceFor = (ref) => {
    if (!voices.has(ref)) {
      const oscillator = context.createOscillator();
      oscillator.type = 'square';
      const gain = context.createGain();
      gain.gain.value = 0;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      voices.set(ref, { oscillator, gain });
    }
    return voices.get(ref);
  };

  return {
    // observables: Map<ref, obs>; buzzerRefs: refs of buzzer parts in the circuit.
    update(observables, buzzerRefs) {
      if (!buzzerRefs.length) return;
      if (!context) {
        try {
          context = new (window.AudioContext || window.webkitAudioContext)();
        } catch {
          return; // no audio available — sim carries on silently
        }
      }
      for (const ref of buzzerRefs) {
        const observable = observables?.get?.(ref);
        const voice = voiceFor(ref);
        const level = clamp01(Math.abs(observable?.volts ?? 0) / 5) * MAX_GAIN;
        voice.gain.gain.setTargetAtTime(level, context.currentTime, 0.02);
        voice.oscillator.frequency.value = observable?.freqHz ?? ACTIVE_BUZZER_HZ;
      }
    },
    stop() {
      for (const { oscillator, gain } of voices.values()) {
        try {
          gain.gain.setTargetAtTime(0, context?.currentTime ?? 0, 0.01);
          oscillator.stop((context?.currentTime ?? 0) + 0.05);
        } catch { /* already stopped */ }
      }
      voices.clear();
      context?.close?.().catch?.(() => {});
      context = null;
    },
  };
};
