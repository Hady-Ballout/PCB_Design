// Read-only realistic breadboard view: auto-places the canonical circuit on a
// solderless breadboard with photo-style SVG parts and jumper wires. Clicking
// a part or wire highlights its electrical neighborhood (dim-others); hover
// previews the same highlight.
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText } from '../../core/download.js';
import { circuitToBreadboard, GROUND_NET } from './breadboardModel.js';
import { describeBreadboard } from './breadboardDescription.js';
import { highlightFor, readoutFor } from './selectionModel.js';
import { Breadboard, HighlightOverlay } from './Breadboard.jsx';
import { BatteryPack, JumperWire, PartDefs, PinLabels, RealisticPart } from './parts.jsx';
import './RealisticSchematic.css';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

const netDisplayName = (net) => (net === GROUND_NET ? 'GND' : net);

export function RealisticSchematic({ circuit }) {
  const model = useMemo(() => circuitToBreadboard(circuit), [circuit]);
  const scrollRef = useRef(null);
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState(null); // {type:'part',ref} | {type:'net',net} | null
  const [hovered, setHovered] = useState(null); // same shape; only previews while nothing is selected
  const [copied, setCopied] = useState(false);

  const effective = selection ?? hovered;
  const highlight = useMemo(() => highlightFor(model, effective), [model, effective]);
  const isPreview = !selection && hovered != null;

  const fitZoom = () => {
    const container = scrollRef.current;
    if (!container) return;
    const scale = Math.min(
      (container.clientWidth - 24) / model.board.width,
      (container.clientHeight - 24) / model.board.height,
    );
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale)));
  };

  // Start fitted to the window; the board width depends on the circuit.
  useEffect(fitZoom, [model.board.width, model.board.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selection can outlive a regenerated circuit; drop it if its target is gone.
  useEffect(() => setSelection(null), [model]);

  useEffect(() => {
    if (!selection) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  // Ctrl+wheel zoom needs a native non-passive listener so preventDefault
  // actually stops the page from zooming.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom((current) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * factor)));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const downloadSvg = () => {
    if (!svgRef.current) return;
    downloadText('breadboard.svg', new XMLSerializer().serializeToString(svgRef.current), 'image/svg+xml');
  };

  // Debug aid: dump a plain-text description of the generated build so it can be
  // pasted into an AI to sanity-check the schematic. Copies to the clipboard;
  // if that is unavailable, falls back to a downloadable .txt.
  const copyDescription = async () => {
    const text = describeBreadboard(circuit, model);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      downloadText('breadboard-description.txt', text);
    }
  };

  const toggleSelection = (next) => {
    setSelection((current) =>
      current && current.type === next.type && (current.ref ?? current.net) === (next.ref ?? next.net)
        ? null
        : next);
  };

  // Shared interactive wrapper props for parts, batteries, and jumpers.
  const interactive = (target, label, lit) => ({
    className: `rs-item ${highlight.active && !lit ? 'rs-dim' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: (event) => {
      event.stopPropagation();
      toggleSelection(target);
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSelection(target);
      }
    },
    onMouseEnter: () => setHovered(target),
    onMouseLeave: () => setHovered(null),
  });

  const selectedPart = selection?.type === 'part'
    ? model.parts.find((part) => part.ref === selection.ref)
    : null;

  return (
    <div className="realistic-schematic">
      <div className="realistic-toolbar">
        <button type="button" onClick={() => setZoom((current) => Math.max(ZOOM_MIN, current / 1.25))}>−</button>
        <button type="button" onClick={() => setZoom((current) => Math.min(ZOOM_MAX, current * 1.25))}>+</button>
        <button type="button" onClick={fitZoom}>Fit</button>
        <span className="realistic-zoom-readout">{Math.round(zoom * 100)}%</span>
        <span className="realistic-readout">{readoutFor(model, selection) ?? 'Click a part or wire'}</span>
        <button
          type="button"
          className="realistic-describe"
          onClick={copyDescription}
          title="Copy a plain-text description of this build to paste into an AI for verification"
        >
          {copied ? 'Copied!' : 'Copy description'}
        </button>
        <button type="button" className="realistic-download" onClick={downloadSvg}>Download SVG</button>
      </div>
      {model.nets.length > 0 && (
        <div className="realistic-legend" role="group" aria-label="Nets">
          {model.nets.map(({ net, color }) => {
            const active = selection?.type === 'net' && selection.net === net;
            return (
              <button
                key={net}
                type="button"
                className={`realistic-legend-chip ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleSelection({ type: 'net', net })}
                onMouseEnter={() => setHovered({ type: 'net', net })}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="realistic-legend-swatch" style={{ background: color }} aria-hidden="true" />
                {netDisplayName(net)}
              </button>
            );
          })}
        </div>
      )}
      {model.warnings.length > 0 && (
        <ul className="realistic-warnings">
          {model.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="realistic-scroll" ref={scrollRef} onClick={() => setSelection(null)}>
        <svg
          ref={svgRef}
          className={isPreview ? 'rs-preview' : ''}
          width={model.board.width * zoom}
          height={model.board.height * zoom}
          viewBox={`0 0 ${model.board.width} ${model.board.height}`}
          role="img"
          aria-label="Realistic breadboard schematic"
          onClick={() => setSelection(null)}
        >
          <PartDefs />
          <Breadboard board={model.board} rails={model.rails} />
          <HighlightOverlay board={model.board} highlight={highlight} />
          {model.parts.map((part) => (
            <g
              key={part.ref}
              {...interactive(
                { type: 'part', ref: part.ref },
                `${part.ref} ${String(part.kind).replaceAll('_', ' ')} ${part.value ?? ''}`.trim(),
                highlight.partRefs.has(part.ref),
              )}
            >
              <title>{readoutFor(model, { type: 'part', ref: part.ref })}</title>
              <RealisticPart part={part} />
            </g>
          ))}
          {model.batteries.map((battery, index) => (
            <g
              key={battery.ref}
              {...interactive(
                { type: 'part', ref: battery.ref },
                `${battery.ref} voltage source ${battery.value ?? ''}`.trim(),
                highlight.partRefs.has(battery.ref) || highlight.batteryRefs.has(battery.ref),
              )}
            >
              <title>{readoutFor(model, { type: 'part', ref: battery.ref })}</title>
              <BatteryPack battery={battery} index={index} />
            </g>
          ))}
          {model.jumpers.map((jumper) => (
            <g
              key={jumper.id}
              {...interactive(
                { type: 'net', net: jumper.net },
                `jumper wire net ${netDisplayName(jumper.net)}`,
                highlight.jumperIds.has(jumper.id),
              )}
            >
              <title>{readoutFor(model, { type: 'net', net: jumper.net })}</title>
              <JumperWire jumper={jumper} />
            </g>
          ))}
          {selectedPart && <PinLabels part={selectedPart} />}
        </svg>
      </div>
    </div>
  );
}
