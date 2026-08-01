import { describe, expect, it } from 'vitest';
import { circuitSchema, MAX_COMPONENTS } from './schemas.js';
import { ConcurrencyLimitError, SubjectConcurrencyLimit } from './limits.js';

const componentAt = (index: number) => ({
  ref: `R${index}`,
  kind: 'resistor',
  value: '1k',
  nodes: [`N${index}`, '0'],
});

describe('circuit size cap', () => {
  it('accepts a circuit at the limit', () => {
    const components = Array.from({ length: MAX_COMPONENTS }, (_, i) => componentAt(i));

    expect(circuitSchema.safeParse({ title: 'big', components }).success).toBe(true);
  });

  it('rejects a circuit past the limit with a message naming the cap', () => {
    const components = Array.from({ length: MAX_COMPONENTS + 1 }, (_, i) => componentAt(i));

    const result = circuitSchema.safeParse({ title: 'too big', components });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(String(MAX_COMPONENTS));
  });
});

describe('SubjectConcurrencyLimit', () => {
  const pending = () => {
    let release!: () => void;
    const promise = new Promise<string>((resolve) => { release = () => resolve('done'); });
    return { promise, release };
  };

  it('runs a task and returns its value', async () => {
    const limit = new SubjectConcurrencyLimit(1);

    await expect(limit.run('user-1', async () => 'result')).resolves.toBe('result');
  });

  it('rejects a second concurrent task for the same subject', async () => {
    const limit = new SubjectConcurrencyLimit(1);
    const first = pending();
    const running = limit.run('user-1', () => first.promise);

    await expect(limit.run('user-1', async () => 'second'))
      .rejects.toBeInstanceOf(ConcurrencyLimitError);

    first.release();
    await running;
  });

  it('does not let one subject block another', async () => {
    const limit = new SubjectConcurrencyLimit(1);
    const first = pending();
    const running = limit.run('user-1', () => first.promise);

    await expect(limit.run('user-2', async () => 'ok')).resolves.toBe('ok');

    first.release();
    await running;
  });

  it('frees the slot once the task settles', async () => {
    const limit = new SubjectConcurrencyLimit(1);
    const first = pending();
    const running = limit.run('user-1', () => first.promise);
    first.release();
    await running;

    await expect(limit.run('user-1', async () => 'second')).resolves.toBe('second');
  });

  it('frees the slot even when the task throws', async () => {
    const limit = new SubjectConcurrencyLimit(1);
    await expect(limit.run('user-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    await expect(limit.run('user-1', async () => 'after failure')).resolves.toBe('after failure');
  });

  it('stops tracking a subject once it has nothing running', async () => {
    const limit = new SubjectConcurrencyLimit(1);
    await limit.run('user-1', async () => 'x');

    expect(limit.activeSubjects).toBe(0);
  });
});
