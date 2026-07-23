import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_BUZZER_HZ,
  MAX_BUZZER_GAIN,
  buzzerAudioConfig,
  createSimAudio,
} from './simAudio.js';

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }

  setTargetAtTime(value, time, timeConstant) {
    this.value = value;
    this.events.push({ type: 'target', value, time, timeConstant });
  }

  setValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'value', value, time });
  }
}

class FakeAudioContext {
  static instances = [];
  static initialState = 'running';

  constructor() {
    this.state = FakeAudioContext.initialState;
    this.currentTime = 2;
    this.destination = {};
    this.oscillators = [];
    this.gains = [];
    this.resume = vi.fn(() => {
      this.state = 'running';
      return Promise.resolve();
    });
    this.close = vi.fn(() => Promise.resolve());
    FakeAudioContext.instances.push(this);
  }

  createOscillator() {
    const oscillator = {
      type: '',
      frequency: new FakeAudioParam(),
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = { gain: new FakeAudioParam(), connect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }
}

const active = { ref: 'BZ1', mode: 'active', ratedVolts: 5 };
const passive = { ref: 'BZ1', mode: 'passive', ratedVolts: 5 };
const observables = (value) => new Map([['BZ1', value]]);

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = 'running';
  globalThis.AudioContext = FakeAudioContext;
});

afterEach(() => {
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  vi.restoreAllMocks();
});

describe('buzzerAudioConfig', () => {
  it('distinguishes explicit passive buzzers and parses their rated voltage', () => {
    expect(buzzerAudioConfig({ ref: 'BZ1', value: '3.3V passive piezo' })).toEqual({
      ref: 'BZ1', mode: 'passive', ratedVolts: 3.3,
    });
    expect(buzzerAudioConfig({ ref: 'BZ2', value: '' })).toEqual({
      ref: 'BZ2', mode: 'active', ratedVolts: 5,
    });
  });
});

describe('createSimAudio', () => {
  it('does not create an AudioContext until start is called', () => {
    const audio = createSimAudio();
    audio.update(observables({ volts: 5 }), [active]);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(audio.start()).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('resumes a context that starts suspended', () => {
    FakeAudioContext.initialState = 'suspended';
    const audio = createSimAudio();
    audio.start();
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledOnce();
  });

  it('sounds an active buzzer on DC at the default frequency and scaled gain', () => {
    const audio = createSimAudio();
    audio.start();
    audio.update(observables({ volts: 2.5, freqHz: null }), [active]);
    const context = FakeAudioContext.instances[0];
    expect(context.oscillators[0].frequency.value).toBe(ACTIVE_BUZZER_HZ);
    expect(context.gains[0].gain.value).toBeCloseTo(MAX_BUZZER_GAIN / 2);
  });

  it('keeps a passive buzzer silent on DC but follows a detected waveform', () => {
    const audio = createSimAudio();
    audio.start();
    audio.update(observables({ volts: 5, freqHz: null }), [passive]);
    const context = FakeAudioContext.instances[0];
    expect(context.oscillators).toHaveLength(0);

    audio.update(observables({ volts: 5, freqHz: 880 }), [passive]);
    expect(context.oscillators[0].frequency.value).toBe(880);
    expect(context.gains[0].gain.value).toBe(MAX_BUZZER_GAIN);
  });

  it('mutes, unmutes on the next update, and removes stale voices', () => {
    const audio = createSimAudio();
    audio.start();
    audio.update(observables({ volts: 5 }), [active]);
    const context = FakeAudioContext.instances[0];
    const voice = context.oscillators[0];
    const gain = context.gains[0].gain;

    audio.setMuted(true);
    expect(gain.value).toBe(0);
    audio.setMuted(false);
    audio.update(observables({ volts: 5 }), [active]);
    expect(gain.value).toBe(MAX_BUZZER_GAIN);

    audio.update(new Map(), []);
    expect(gain.value).toBe(0);
    expect(voice.stop).toHaveBeenCalledWith(2.05);
  });

  it('stops all voices and closes the context', () => {
    const audio = createSimAudio();
    audio.start();
    audio.update(observables({ volts: 5 }), [active]);
    const context = FakeAudioContext.instances[0];
    audio.stop();
    expect(context.oscillators[0].stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
