import type { Circuit, Component } from '../types.js';

export interface ComponentChange {
  ref: string;
  before: Component;
  after: Component;
  fields: Array<'kind' | 'value' | 'nodes'>;
}

export interface CircuitDiff {
  isNewBuild: boolean;
  added: Component[];
  removed: Component[];
  changed: ComponentChange[];
  unchangedRefs: string[];
}

const MAX_BUCKET_ENTRIES = 12;
const DESCRIPTION_LIMIT = 2500;

const refKey = (component: Component): string => String(component.ref || '').toUpperCase();

// Footprint deltas are ignored on purpose: reconcileCircuitRevision backfills
// footprints after the pipeline, so they are noise at diff time.
const normalizeValue = (value: unknown): string => String(value || '').trim().toUpperCase();
const nodeSignature = (component: Component): string =>
  (Array.isArray(component.nodes) ? component.nodes : []).join('|');

const components = (circuit: Circuit | null | undefined): Component[] =>
  Array.isArray(circuit?.components) ? circuit!.components : [];

export function diffCircuits(previous: Circuit | null | undefined, next: Circuit): CircuitDiff {
  const nextComponents = components(next);
  const previousComponents = components(previous);
  if (!previousComponents.length) {
    return { isNewBuild: true, added: nextComponents, removed: [], changed: [], unchangedRefs: [] };
  }

  const previousByRef = new Map(previousComponents.map((component) => [refKey(component), component]));
  const nextRefs = new Set(nextComponents.map(refKey));

  const added: Component[] = [];
  const changed: ComponentChange[] = [];
  const unchangedRefs: string[] = [];
  for (const component of nextComponents) {
    const before = previousByRef.get(refKey(component));
    if (!before) {
      added.push(component);
      continue;
    }
    const fields: ComponentChange['fields'] = [];
    if (String(before.kind) !== String(component.kind)) fields.push('kind');
    if (normalizeValue(before.value) !== normalizeValue(component.value)) fields.push('value');
    if (nodeSignature(before) !== nodeSignature(component)) fields.push('nodes');
    if (fields.length) {
      changed.push({ ref: refKey(component), before, after: component, fields });
    } else {
      unchangedRefs.push(refKey(component));
    }
  }
  const removed = previousComponents.filter((component) => !nextRefs.has(refKey(component)));

  return { isNewBuild: false, added, removed, changed, unchangedRefs };
}

const describeAdded = (component: Component): string =>
  `${refKey(component)} (${component.kind} ${component.value}, nodes ${(component.nodes || []).join('-')})`;

const describeChange = (change: ComponentChange): string => {
  const parts = change.fields.map((field) => {
    if (field === 'nodes') return `nodes ${(change.before.nodes || []).join('-')} -> ${(change.after.nodes || []).join('-')}`;
    return `${field} ${change.before[field]} -> ${change.after[field]}`;
  });
  return `${change.ref} ${parts.join(', ')}`;
};

const capped = (entries: string[]): string => {
  const shown = entries.slice(0, MAX_BUCKET_ENTRIES);
  const remainder = entries.length - shown.length;
  return remainder > 0 ? `${shown.join('; ')} ... and ${remainder} more` : shown.join('; ');
};

export function describeCircuitDiff(diff: CircuitDiff): string {
  if (diff.isNewBuild) {
    return 'This is a brand-new design; there was no previous circuit.';
  }
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    return 'The design is unchanged from the previous turn.';
  }

  const sentences: string[] = [];
  if (diff.added.length) sentences.push(`Added: ${capped(diff.added.map(describeAdded))}.`);
  if (diff.changed.length) sentences.push(`Changed: ${capped(diff.changed.map(describeChange))}.`);
  if (diff.removed.length) sentences.push(`Removed: ${capped(diff.removed.map(refKey))}.`);
  if (diff.unchangedRefs.length) {
    const noun = diff.unchangedRefs.length === 1 ? 'component' : 'components';
    sentences.push(`Unchanged: ${diff.unchangedRefs.length} ${noun} (${capped(diff.unchangedRefs)}) — untouched.`);
  }
  return sentences.join(' ').slice(0, DESCRIPTION_LIMIT);
}
