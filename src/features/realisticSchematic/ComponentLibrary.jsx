// Browse-only component library popover for the Realistic Schematic canvas.
// Opened by double-clicking the board (see RealisticSchematic.jsx); anchored at
// the cursor. Lists every kind in the registry (src/core/componentKinds.js) so
// the user can discover what components exist. Selecting an item is a no-op for
// now — the optional `onSelect(kind)` prop is the seam for a future add flow.
import { useEffect, useMemo, useState } from 'react';
import {
  ALLOWED_KINDS,
  COMPONENT_KINDS,
  MCU_KINDS,
  WIRING_ONLY_KINDS,
  kindLabel,
} from '../../core/componentKinds.js';
import { ComponentToolIcon } from '../schematic/symbols.jsx';

// Map a registry `symbolType` onto the ComponentToolIcon vocabulary. Kinds with
// no dedicated glyph fall through to the icon component's default (generic part).
const ICON_TYPE_BY_SYMBOL = {
  resistor: 'resistor',
  capacitor: 'capacitor',
  inductor: 'inductor',
  led: 'led',
  bjt_npn: 'bjt',
  bjt_pnp: 'bjt',
  voltage_source: 'source',
};

const iconType = (kind) => ICON_TYPE_BY_SYMBOL[COMPONENT_KINDS[kind]?.symbolType] || 'generic';

// Browse groups (registry order is preserved within each). Boards are checked
// before wiring-only so an MCU board never falls into "Sensors & modules".
const GROUPS = [
  { id: 'basic', title: 'Basic components', match: (kind) => !MCU_KINDS.has(kind) && !WIRING_ONLY_KINDS.has(kind) },
  { id: 'modules', title: 'Sensors & modules', match: (kind) => WIRING_ONLY_KINDS.has(kind) && !MCU_KINDS.has(kind) },
  { id: 'boards', title: 'Boards', match: (kind) => MCU_KINDS.has(kind) },
];

const POPOVER_WIDTH = 288;
const VIEWPORT_MARGIN = 12;
const MAX_HEIGHT_FRACTION = 0.6;

export function ComponentLibrary({ position, onClose, onSelect }) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (kind) =>
      !needle || kindLabel(kind).toLowerCase().includes(needle) || kind.includes(needle);
    return GROUPS
      .map((group) => ({ ...group, kinds: ALLOWED_KINDS.filter((kind) => group.match(kind) && matches(kind)) }))
      .filter((group) => group.kinds.length > 0);
  }, [query]);

  const total = groups.reduce((sum, group) => sum + group.kinds.length, 0);

  // Clamp the popover into the viewport: flip left/up when it would overflow the
  // right/bottom edge, and never let it slip past the top/left margin.
  const style = useMemo(() => {
    const maxHeight = window.innerHeight * MAX_HEIGHT_FRACTION;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(position.x, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN));
    const top = Math.max(VIEWPORT_MARGIN, Math.min(position.y, window.innerHeight - maxHeight - VIEWPORT_MARGIN));
    return { left, top, width: POPOVER_WIDTH, maxHeight: `${Math.round(maxHeight)}px` };
  }, [position]);

  return (
    <>
      <div className="realistic-library-backdrop" onPointerDown={onClose} aria-hidden="true" />
      <div className="realistic-library" style={style} role="dialog" aria-label="Component library">
        <div className="realistic-library-header">
          <span className="realistic-library-title">Components</span>
          <button
            type="button"
            className="realistic-library-close"
            onClick={onClose}
            aria-label="Close component library"
          >
            ×
          </button>
        </div>
        <input
          type="search"
          className="realistic-library-search"
          placeholder="Search components…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
        />
        <div className="realistic-library-body">
          {total === 0 ? (
            <p className="realistic-library-empty">No components match “{query}”.</p>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="realistic-library-group">
                <h4 className="realistic-library-group-title">{group.title}</h4>
                <div className="realistic-library-grid">
                  {group.kinds.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="realistic-library-item"
                      onClick={() => onSelect?.(kind)}
                      title={kindLabel(kind)}
                    >
                      <span className="realistic-library-item-icon">
                        <ComponentToolIcon type={iconType(kind)} />
                      </span>
                      <span className="realistic-library-item-label">{kindLabel(kind)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}
