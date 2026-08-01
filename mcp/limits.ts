// Guards for the hosted endpoint.
//
// `simulate_circuit` shells out to ngspice, so it is the one tool where a caller
// can spend real CPU. Quotas (server/billing/quota.ts) bound how much work a user
// gets over time; this bounds how much they can have in flight at once, which is
// what actually protects the container from a client that fires simulations in a
// loop faster than they complete.

export class ConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(
      `Only ${limit} simulation can run at a time for your account. `
      + 'Wait for the current one to finish and try again.',
    );
    this.name = 'ConcurrencyLimitError';
  }
}

/** Caps how many tasks one subject may have running simultaneously. */
export class SubjectConcurrencyLimit {
  #inFlight = new Map<string, number>();

  #limit: number;

  constructor(limit = 1) {
    this.#limit = limit;
  }

  async run<T>(subject: string, task: () => Promise<T>): Promise<T> {
    const current = this.#inFlight.get(subject) ?? 0;
    if (current >= this.#limit) throw new ConcurrencyLimitError(this.#limit);

    this.#inFlight.set(subject, current + 1);
    try {
      return await task();
    } finally {
      // Always release, including on throw — otherwise one failed simulation
      // would lock the user out until the process restarts.
      const remaining = (this.#inFlight.get(subject) ?? 1) - 1;
      if (remaining > 0) this.#inFlight.set(subject, remaining);
      else this.#inFlight.delete(subject);
    }
  }

  /** Subjects with work in flight. Zero when idle — the map must not leak keys. */
  get activeSubjects(): number {
    return this.#inFlight.size;
  }
}
