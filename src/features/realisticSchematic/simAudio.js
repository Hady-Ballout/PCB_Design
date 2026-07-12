// Web Audio for simulated buzzers. The AudioContext is started explicitly by
// the Run-button gesture so browsers do not suspend it under autoplay policy.
// One square oscillator + gain is kept per sounding buzzer; gain ramps avoid
// clicks when voltage, mute state, or circuit membership changes.

const clamp01 = (value) => Math.min(1, Math.max(0, value));

export const ACTIVE_BUZZER_HZ = 2400;
export const MAX_BUZZER_GAIN = 0.15;
export const MIN_AUDIBLE_VOLTS = 0.1;

export const buzzerAudioConfig = (component) => {
  const value = String(component?.value ?? '');
  const ratedMatch = value.match(/(\d+(?:\.\d+)?)\s*v\b/i);
  return {
    ref: component?.ref,
    // Preserve the historical behavior for blank/legacy values: only an
    // explicit passive/piezo label disables the built-in active tone.
    mode: /\b(?:passive|piezo)\b/i.test(value) ? 'passive' : 'active',
    ratedVolts: ratedMatch ? Math.max(Number(ratedMatch[1]), MIN_AUDIBLE_VOLTS) : 5,
  };
};

export const createSimAudio = () => {
  let context = null;
  let muted = false;
  const voices = new Map(); // ref -> { oscillator, gain }

  const now = () => context?.currentTime ?? 0;
  const rampGain = (gain, value, timeConstant = 0.02) => {
    gain.gain.setTargetAtTime(value, now(), timeConstant);
  };
  const silenceAndStop = ({ oscillator, gain }) => {
    try {
      rampGain(gain, 0, 0.01);
      oscillator.stop(now() + 0.05);
    } catch { /* already stopped */ }
  };
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
    // Must be called synchronously from a click/tap. Calling resume even for a
    // new context handles browsers that construct it in the suspended state.
    start() {
      try {
        if (!context) {
          const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
          if (!AudioContext) return false;
          context = new AudioContext();
        }
        if (context.state === 'suspended') context.resume?.().catch?.(() => {});
        return true;
      } catch {
        return false; // audio is optional; electrical simulation still runs
      }
    },

    // observables: Map<ref, obs>; buzzers: {ref, mode, ratedVolts} descriptors.
    update(observables, buzzers = []) {
      if (!context) return;
      const currentRefs = new Set(buzzers.map((buzzer) => buzzer.ref));
      for (const [ref, voice] of voices) {
        if (!currentRefs.has(ref)) {
          silenceAndStop(voice);
          voices.delete(ref);
        }
      }

      for (const buzzer of buzzers) {
        const observable = observables?.get?.(buzzer.ref);
        const volts = Math.abs(Number(observable?.volts) || 0);
        const detectedHz = Number(observable?.freqHz);
        const frequency = Number.isFinite(detectedHz) && detectedHz > 0
          ? detectedHz
          : buzzer.mode === 'active' ? ACTIVE_BUZZER_HZ : null;
        const shouldSound = frequency != null && volts >= MIN_AUDIBLE_VOLTS;
        const existing = voices.get(buzzer.ref);
        if (!shouldSound) {
          if (existing) rampGain(existing.gain, 0);
          continue;
        }

        const voice = existing ?? voiceFor(buzzer.ref);
        voice.oscillator.frequency.setValueAtTime(frequency, now());
        const level = muted ? 0 : clamp01(volts / (buzzer.ratedVolts || 5)) * MAX_BUZZER_GAIN;
        rampGain(voice.gain, level);
      }
    },

    setMuted(value) {
      muted = Boolean(value);
      if (muted) {
        for (const { gain } of voices.values()) rampGain(gain, 0, 0.01);
      }
    },

    stop() {
      for (const voice of voices.values()) silenceAndStop(voice);
      voices.clear();
      context?.close?.().catch?.(() => {});
      context = null;
    },
  };
};
