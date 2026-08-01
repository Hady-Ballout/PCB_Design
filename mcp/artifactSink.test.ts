import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, fileSink } from './artifactSink.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pcb-mcp-sink-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileSink', () => {
  it('writes to disk and reports a filesystem location', () => {
    const ref = fileSink(dir).put('deck.cir', '* netlist\n');

    expect(ref.kind).toBe('file');
    expect(path.isAbsolute(ref.location)).toBe(true);
    expect(readFileSync(ref.location, 'utf8')).toBe('* netlist\n');
  });
});

describe('ArtifactStore', () => {
  // Injected clock — TTL behaviour is tested by moving time, not by sleeping.
  const clockAt = (start: number) => {
    let current = start;
    return { now: () => current, advance: (ms: number) => { current += ms; } };
  };

  it('hands back a URL rather than a path', () => {
    const store = new ArtifactStore();

    const ref = store.sinkFor('user-1').put('schematic.svg', '<svg/>');

    expect(ref.kind).toBe('url');
    expect(ref.location).toMatch(/^\/api\/mcp\/artifacts\/[A-Za-z0-9_-]+$/);
  });

  it('serves the stored content back to the same subject', () => {
    const store = new ArtifactStore();
    const ref = store.sinkFor('user-1').put('schematic.svg', '<svg/>');
    const id = ref.location.split('/').pop()!;

    expect(store.get(id, 'user-1')).toMatchObject({ filename: 'schematic.svg', content: '<svg/>' });
  });

  it('refuses to serve one subject an artifact belonging to another', () => {
    const store = new ArtifactStore();
    const ref = store.sinkFor('user-1').put('secret.json', '{"private":true}');
    const id = ref.location.split('/').pop()!;

    expect(store.get(id, 'user-2')).toBeUndefined();
  });

  it('forgets an artifact once its TTL elapses', () => {
    const clock = clockAt(1_000_000);
    const store = new ArtifactStore({ ttlMs: 60_000, now: clock.now });
    const id = store.sinkFor('user-1').put('a.csv', 'x').location.split('/').pop()!;

    clock.advance(59_000);
    expect(store.get(id, 'user-1')).toBeDefined();

    clock.advance(2_000);
    expect(store.get(id, 'user-1')).toBeUndefined();
  });

  it('returns nothing for an id it never issued', () => {
    expect(new ArtifactStore().get('made-up-id', 'user-1')).toBeUndefined();
  });

  it('issues a distinct id per artifact', () => {
    const store = new ArtifactStore();
    const sink = store.sinkFor('user-1');

    const first = sink.put('a.svg', '<svg/>').location;
    const second = sink.put('a.svg', '<svg/>').location;

    expect(first).not.toBe(second);
  });

  it('drops expired entries instead of retaining them forever', () => {
    const clock = clockAt(0);
    const store = new ArtifactStore({ ttlMs: 1_000, now: clock.now });
    const sink = store.sinkFor('user-1');
    for (let index = 0; index < 5; index += 1) sink.put(`f${index}.txt`, 'x');
    expect(store.size).toBe(5);

    clock.advance(2_000);
    sink.put('fresh.txt', 'x');

    expect(store.size).toBe(1);
  });
});
