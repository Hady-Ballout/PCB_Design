// Component library popover for the Realistic Schematic canvas. Opened by
// double-clicking the board (see RealisticSchematic.jsx); anchored at the
// cursor. Lists every kind in the registry (src/core/componentKinds.js) so the
// user can discover what components exist. Picking an item calls `onSelect(kind)`
// to add that part to the board and closes the popover; when `onSelect` is
// omitted (read-only view) the popover is browse-only and items are inert.
import { useEffect, useMemo, useState } from 'react';
import {
  COMPONENT_CATEGORIES,
  KINDS_BY_CATEGORY,
  kindLabel,
  kindMatchesQuery,
} from '../../core/componentKinds.js';
import { PartThumbnail } from './parts.jsx';

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

  // One section per category (registry order preserved within each). Search
  // matches on label, slug, aliases, and keywords via kindMatchesQuery, so
  // "op-amp", "pot", or "ldr" find their kind even when the label differs.
  const groups = useMemo(() => {
    return COMPONENT_CATEGORIES
      .map((category) => ({
        id: category.id,
        title: category.title,
        kinds: KINDS_BY_CATEGORY[category.id].filter((kind) => kindMatchesQuery(kind, query)),
      }))
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
                      disabled={!onSelect}
                      title={onSelect ? `Add ${kindLabel(kind)}` : kindLabel(kind)}
                    >
                      <span className="realistic-library-item-icon">
                        <PartThumbnail kind={kind} />
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
