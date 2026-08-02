import React, { useMemo, useRef, useState } from 'react';
import { placedSilkStrokes } from '../../core/gerberExport.js';
import {
  addWaypoint,
  autoRoutedManual,
  beginStroke,
  clientToBoard,
  commitStroke,
  currentLayer,
  deleteStroke,
  dropLastWaypoint,
  finishStroke,
  nextStrokeId,
  progressSummary,
  ratsnestFor,
  routeCorner,
  strokeEnd,
  toggleStrokeLayer,
} from './pcbEditorModel.js';
import './pcbEditor.css';

const LAYER_COLORS = { top: '#e05252', bottom: '#4f74e3' };
const MARGIN = 3; // mm of dark canvas around the board

/**
 * The interactive Board view: hover a pad to see its whole net, click to lock
 * it, click waypoints to draw the trace, finish on any highlighted pad. The
 * board arrives placed but unrouted; Auto-route hands the whole job to the
 * maze router. All copper edits flow up through `onRoutingChange` as a stored
 * manualRouting value — the caller rebuilds the layout, so DRC markers, the
 * ratsnest and the progress line always describe the board as it is.
 */
export function PcbBoardEditor({ layout, onRoutingChange }) {
  const svgRef = useRef(null);
  const panRef = useRef(null);
  const [view, setView] = useState({ tx: 0, ty: 0, s: 1 });
  const [hoverNet, setHoverNet] = useState(null);
  const [stroke, setStroke] = useState(null);
  const [preview, setPreview] = useState(null);
  const [selectedStroke, setSelectedStroke] = useState(null);
  const [startLayer, setStartLayer] = useState('top');

  const viewBox = {
    x: -MARGIN,
    y: -MARGIN,
    width: layout.board.width + 2 * MARGIN,
    height: layout.board.height + 2 * MARGIN,
  };

  const routing = {
    placement: layout.placement,
    traces: layout.traces,
    vias: layout.vias,
  };
  const ratsnest = useMemo(() => ratsnestFor(layout), [layout]);
  // The real footprint silkscreen — the same polylines the silk Gerber gets —
  // so a DIP looks like a DIP here, not a cluster of pads.
  const silk = useMemo(
    () => layout.components.map((component) => placedSilkStrokes(component)),
    [layout.components],
  );
  const activeNet = stroke?.net || hoverNet;

  const boardPoint = (event) => {
    const raw = clientToBoard(svgRef.current, event.clientX, event.clientY, viewBox);
    return { x: (raw.x - view.tx) / view.s, y: (raw.y - view.ty) / view.s };
  };

  const commit = (value) => onRoutingChange({ ...value, placement: layout.placement });

  const cancelStroke = () => {
    setStroke(null);
    setPreview(null);
  };

  const handlePadClick = (pad, event) => {
    event.stopPropagation();
    if (!pad.connected) return;
    if (!stroke) {
      setSelectedStroke(null);
      setStroke(beginStroke(nextStrokeId(routing), pad.net, { x: pad.x, y: pad.y }, startLayer));
      setPreview(null);
      return;
    }
    if (pad.net !== stroke.net) return;
    commit(commitStroke(routing, layout.placement, finishStroke(stroke, { x: pad.x, y: pad.y })));
    cancelStroke();
  };

  const handleCanvasClick = (event) => {
    if (!stroke) {
      setSelectedStroke(null);
      return;
    }
    setStroke(addWaypoint(stroke, routeCorner(strokeEnd(stroke), boardPoint(event))));
  };

  const handleMove = (event) => {
    const drag = panRef.current;
    if (drag) {
      const dx = event.clientX - drag.clientX;
      const dy = event.clientY - drag.clientY;
      if (drag.moved || Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        const scale = (svgRef.current?.getBoundingClientRect?.()?.width || viewBox.width)
          / viewBox.width;
        setView((current) => ({
          ...current,
          tx: drag.tx + dx / scale,
          ty: drag.ty + dy / scale,
        }));
      }
      return;
    }
    if (stroke) setPreview(routeCorner(strokeEnd(stroke), boardPoint(event)));
  };

  const handlePointerDown = (event) => {
    if (stroke || event.button !== 0) return;
    panRef.current = {
      clientX: event.clientX, clientY: event.clientY, tx: view.tx, ty: view.ty, moved: false,
    };
  };

  const handlePointerUp = (event) => {
    const drag = panRef.current;
    panRef.current = null;
    // A drag that actually panned must not also register as a waypoint click.
    if (drag?.moved) event.stopPropagation();
  };

  const handleWheel = (event) => {
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
    setView((current) => {
      const next = Math.min(10, Math.max(0.4, current.s * factor));
      const at = clientToBoard(svgRef.current, event.clientX, event.clientY, viewBox);
      // Keep the board point under the cursor fixed while the scale changes.
      return {
        s: next,
        tx: at.x - ((at.x - current.tx) / current.s) * next,
        ty: at.y - ((at.y - current.ty) / current.s) * next,
      };
    });
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      cancelStroke();
      setSelectedStroke(null);
    } else if (event.key === 'Backspace' && stroke) {
      event.preventDefault();
      setStroke(dropLastWaypoint(stroke));
    } else if ((event.key === 'v' || event.key === 'V') && stroke) {
      setStroke(toggleStrokeLayer(stroke));
    } else if (event.key === 'Delete' && selectedStroke) {
      commit(deleteStroke(routing, selectedStroke));
      setSelectedStroke(null);
    }
  };

  const handleAutoRoute = () => {
    cancelStroke();
    setSelectedStroke(null);
    commit(autoRoutedManual(layout));
  };

  const handleClear = () => {
    cancelStroke();
    setSelectedStroke(null);
    commit({ placement: layout.placement, traces: [], vias: [] });
  };

  const activeLayer = stroke ? currentLayer(stroke) : startLayer;
  const toggleLayer = () => {
    if (stroke) setStroke(toggleStrokeLayer(stroke));
    else setStartLayer((layer) => (layer === 'top' ? 'bottom' : 'top'));
  };

  const dimmed = (net) => activeNet != null && net !== activeNet;
  const strokePoints = stroke
    ? [...stroke.points, ...(preview ? [{ ...preview, layer: currentLayer(stroke) }] : [])]
    : [];

  return (
    <div
      className="pcb-editor"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="application"
      aria-label="Manual board routing editor"
    >
      <div className="pcb-editor-toolbar">
        <button
          type="button"
          className="pcb-layer-toggle"
          onClick={toggleLayer}
          style={{ color: LAYER_COLORS[activeLayer] }}
          title={stroke ? 'Switch layer through a via (V)' : 'Layer new traces start on'}
        >
          {activeLayer === 'top' ? 'Top layer' : 'Bottom layer'}
        </button>
        <button
          type="button"
          onClick={handleAutoRoute}
          title="Route every net with the auto-router (replaces drawn traces)"
        >
          Auto-route
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={!layout.traces.length && !layout.vias.length}
          title="Remove every trace and via"
        >
          Clear
        </button>
        <span className="pcb-editor-progress" aria-live="polite">{progressSummary(layout)}</span>
        <span className="pcb-editor-hint">
          {stroke
            ? 'Click corners · finish on a highlighted pad · V via · Backspace undo · Esc cancel'
            : 'Hover a pad to see its net · click to start a trace · click a trace + Delete to remove'}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="pcb-editor-canvas"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        onClick={handleCanvasClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handleMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        data-testid="pcb-editor-svg"
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>
          <rect
            x={0}
            y={0}
            width={layout.board.width}
            height={layout.board.height}
            className="pcb-board-body"
          />
          {(layout.pour?.polygons || []).map((polygon, index) => (
            <polygon
              key={`pour-${index}`}
              points={polygon.map((point) => `${point.x},${point.y}`).join(' ')}
              className="pcb-pour"
            />
          ))}
          {ratsnest.map((line, index) => (
            <line
              key={`rat-${index}`}
              x1={line.from.x}
              y1={line.from.y}
              x2={line.to.x}
              y2={line.to.y}
              className={`pcb-ratsnest ${dimmed(line.net) ? 'pcb-dimmed' : ''}`}
            />
          ))}
          {layout.traces.map((trace, index) => (
            <line
              key={`trace-${index}`}
              x1={trace.from.x}
              y1={trace.from.y}
              x2={trace.to.x}
              y2={trace.to.y}
              stroke={LAYER_COLORS[trace.layer] || LAYER_COLORS.top}
              strokeWidth={trace.width}
              strokeLinecap="round"
              className={[
                'pcb-trace',
                dimmed(trace.net) ? 'pcb-dimmed' : '',
                trace.stroke && trace.stroke === selectedStroke ? 'pcb-selected' : '',
              ].join(' ')}
              data-net={trace.net}
              data-stroke={trace.stroke || ''}
              onClick={(event) => {
                if (stroke) return;
                event.stopPropagation();
                setSelectedStroke(trace.stroke || null);
              }}
            />
          ))}
          {layout.vias.map((via, index) => (
            <g key={`via-${index}`} className={dimmed(via.net) ? 'pcb-dimmed' : ''}>
              <circle cx={via.x} cy={via.y} r={(via.diameter || 1.2) / 2} className="pcb-via" />
              <circle cx={via.x} cy={via.y} r={(via.drill || 0.6) / 2} className="pcb-hole" />
            </g>
          ))}
          {layout.components.map((component, componentIndex) => (
            <g key={`silk-${component.ref}`} className="pcb-silk-group">
              {silk[componentIndex].map((stroke, strokeIndex) => (
                <polyline
                  key={strokeIndex}
                  points={stroke.points.map(([x, y]) => `${x},${y}`).join(' ')}
                  strokeWidth={stroke.width}
                  className="pcb-silk"
                />
              ))}
            </g>
          ))}
          {layout.components.map((component) => (
            <g key={component.ref}>
              <text
                x={component.x}
                y={component.y - component.height / 2 - 0.6}
                className="pcb-silk-ref"
                textAnchor="middle"
              >
                {component.ref}
              </text>
              {component.pads.map((pad) => {
                const highlight = pad.connected && activeNet != null && pad.net === activeNet;
                const classes = [
                  'pcb-pad',
                  highlight ? 'pcb-pad-net' : '',
                  pad.connected ? '' : 'pcb-pad-nc',
                  pad.connected && dimmed(pad.net) ? 'pcb-dimmed' : '',
                ].join(' ');
                const shared = {
                  className: classes,
                  'data-net': pad.connected ? pad.net : '',
                  'data-ref': component.ref,
                  'data-pad': pad.padNumber,
                  onClick: (event) => handlePadClick(pad, event),
                  onPointerEnter: () => { if (!stroke && pad.connected) setHoverNet(pad.net); },
                  onPointerLeave: () => { if (!stroke) setHoverNet(null); },
                };
                const size = pad.size || { w: pad.diameter, h: pad.diameter };
                return (
                  <g key={`${component.ref}:${pad.padNumber}:${pad.pinIndex}`}>
                    {pad.shape === 'circle' ? (
                      <circle cx={pad.x} cy={pad.y} r={Math.max(size.w, size.h) / 2} {...shared} />
                    ) : (
                      <rect
                        x={pad.x - size.w / 2}
                        y={pad.y - size.h / 2}
                        width={size.w}
                        height={size.h}
                        rx={pad.shape === 'oval' ? Math.min(size.w, size.h) / 2 : 0.1}
                        {...shared}
                      />
                    )}
                    {pad.drill ? (
                      <circle cx={pad.x} cy={pad.y} r={pad.drill / 2} className="pcb-hole" />
                    ) : null}
                  </g>
                );
              })}
            </g>
          ))}
          {strokePoints.length > 1 && strokePoints.slice(0, -1).map((point, index) => {
            const next = strokePoints[index + 1];
            return (
              <line
                key={`draft-${index}`}
                x1={point.x}
                y1={point.y}
                x2={next.x}
                y2={next.y}
                stroke={LAYER_COLORS[point.layer]}
                strokeWidth={0.8}
                strokeLinecap="round"
                className="pcb-draft"
                data-testid="pcb-draft-segment"
              />
            );
          })}
          {(stroke?.vias || []).map((via, index) => (
            <circle key={`draft-via-${index}`} cx={via.x} cy={via.y} r={0.6} className="pcb-via pcb-draft" />
          ))}
          {(layout.drc?.violations || []).map((violation, index) => (
            <circle
              key={`drc-${index}`}
              cx={violation.x}
              cy={violation.y}
              r={1.1}
              className="pcb-drc-marker"
              data-testid="pcb-drc-marker"
            >
              <title>
                {`${violation.type}: ${violation.netA}${violation.netB ? ` vs ${violation.netB}` : ''} — ${violation.distance}mm (needs ${violation.required}mm)`}
              </title>
            </circle>
          ))}
        </g>
      </svg>
    </div>
  );
}
