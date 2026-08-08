// Vitest setup, applied to every test file.
//
// The jsdom environment as resolved here (jsdom 29) exposes `localStorage` as a
// bare object with no getItem/setItem/clear, so any component that persists a
// preference explodes on first touch — that is what killed the whole breadboard
// interaction suite in `beforeEach`. Install a minimal spec-shaped Storage when
// the environment's own is unusable, and leave a working one alone.
const isUsableStorage = (candidate) => Boolean(
  candidate
  && typeof candidate.getItem === 'function'
  && typeof candidate.setItem === 'function'
  && typeof candidate.clear === 'function',
);

const createMemoryStorage = () => {
  const entries = new Map();
  return {
    get length() { return entries.size; },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => (entries.has(String(key)) ? entries.get(String(key)) : null),
    setItem: (key, value) => { entries.set(String(key), String(value)); },
    removeItem: (key) => { entries.delete(String(key)); },
    clear: () => { entries.clear(); },
  };
};

// Node-environment test files have no window; only patch what exists.
for (const target of [globalThis, globalThis.window].filter(Boolean)) {
  if (isUsableStorage(target.localStorage)) continue;
  Object.defineProperty(target, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
