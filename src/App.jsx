import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildConversationContext,
  chatTitleFromPrompt,
  createChat,
  loadChatStore,
  migrateChatDiagram,
  saveChatStore,
} from './lib/chatStore.js';
import {
  circuitElectricalSignature,
  circuitFromDiagram,
  parseCircuitJson,
  parseKiCadNetlist,
  parseSpiceNetlist,
  synchronizeResult,
} from './core/circuitSync.js';
import { toDiagramSvg } from './core/pcbGenerator.js';
import { changedLineIndexes } from './core/lineDiff.js';
import {
  findNearestLegalPlacement,
  layoutCircuitDiagram,
  rerouteAffectedNets,
  routeDiagramWire,
} from './core/schematicLayout.js';
import { AuthProvider, useAuth, HomePage, LoginPage, SignupPage, VerifyPage } from './auth.jsx';
import './auth.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

const AUTH_PAGES = new Set(['login', 'signup']);
const PUBLIC_PAGES = new Set(['home', 'login', 'signup', 'verify']);

const pageFromHash = () => {
  const hash = window.location.hash;
  if (hash.startsWith('#verify')) return 'verify';
  if (hash === '#login') return 'login';
  if (hash === '#signup') return 'signup';
  if (hash === '#waveform') return 'waveform';
  return 'workspace';
};

const downloadText = (filename, text, mime = 'text/plain') => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const formatAxisValue = (value) => {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1_000 || Math.abs(value) < 0.01) return value.toExponential(2);
  return Number(value.toFixed(3)).toString();
};

const messageId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const formatChatTime = (timestamp) => {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const EDITOR_VIEW_LABELS = {
  spice: 'Spice',
  json: 'JSON',
  canvas: 'Canvas',
};

const ADD_COMPONENT_TOOLS = [
  { type: 'resistor', label: 'Add resistor' },
  { type: 'capacitor', label: 'Add capacitor' },
  { type: 'source', label: 'Add voltage source' },
  { type: 'led', label: 'Add LED' },
  { type: 'bjt', label: 'Add BJT' },
  { type: 'opamp', label: 'Add op amp' },
  { type: 'ground', label: 'Add ground' },
];

function ComponentToolIcon({ type }) {
  if (type === 'resistor') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M4 16H16L20 8L28 24L36 8L44 24L48 16H60" />
      </svg>
    );
  }
  if (type === 'capacitor') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M4 16H25M39 16H60M25 6V26M39 6V26" />
      </svg>
    );
  }
  if (type === 'source') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M4 16H18M46 16H60" />
        <circle cx="32" cy="16" r="14" />
        <path d="M32 8V14M32 18V24M27 11H37M27 21H37" />
      </svg>
    );
  }
  if (type === 'led') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M4 16H20M44 16H60M20 6L44 16L20 26Z" />
        <path d="M44 7V25M43 5L51 1M48 10L56 6" />
      </svg>
    );
  }
  if (type === 'bjt') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M10 16H26M26 7V25M26 10L50 4M26 22L50 28M44 24L50 28L48 21" />
      </svg>
    );
  }
  if (type === 'ground') {
    return (
      <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
        <path d="M32 4V13M14 13H50M20 20H44M26 27H38" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false">
      <path d="M8 16H22M42 16H58M22 5L22 27L46 16Z" />
      <path d="M14 9H20M17 6V12M14 23H20" />
    </svg>
  );
}

const EDITOR_SPLIT_STORAGE_KEY = 'prompt-to-pcb-editor-split-v1';

const clampEditorSplit = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};

const loadEditorSplit = () => {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(EDITOR_SPLIT_STORAGE_KEY) || 'null');
    return {
      columns: clampEditorSplit(saved?.columns, 25, 75, 50),
      rows: clampEditorSplit(saved?.rows, 32, 72, 58),
    };
  } catch {
    return { columns: 50, rows: 58 };
  }
};

const readGenerationStream = async (response, onEvent) => {
  if (!response.body) throw new Error('Generation response could not be streamed.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let completed = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      const error = new Error(event.error || 'Circuit generation failed.');
      error.code = event.code;
      throw error;
    }
    onEvent(event);
    if (event.type === 'complete') completed = event.data;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffered.trim()) consumeLine(buffered);
  if (!completed) throw new Error('Generation ended before the final circuit was returned.');
  return completed;
};

const markSpiceAsProvisional = (spice, correcting = false) => {
  const label = correcting
    ? '* Unconfirmed AI preview - correcting an invalid model response'
    : '* Unconfirmed AI preview - generation is still in progress';
  return `${label}\n${String(spice || '')}`;
};

function WaveformChart({ waveform }) {
  const series = waveform?.series?.filter((item) => item.points?.length) ?? [];
  const namesKey = series.map((item) => item.name).join('|');
  const [selectedNames, setSelectedNames] = useState(() => series.map((item) => item.name));
  const [viewDomain, setViewDomain] = useState(null);
  const [hover, setHover] = useState(null);
  const [dragStart, setDragStart] = useState(null);

  useEffect(() => {
    setSelectedNames(series.map((item) => item.name));
    setViewDomain(null);
    setHover(null);
  }, [namesKey]);

  if (series.length === 0) return null;

  const activeSeries = series.filter((item) => selectedNames.includes(item.name));
  const allPoints = series.flatMap((item) => item.points);
  const allXValues = allPoints.map((point) => point.x);
  const fullXMin = Math.min(...allXValues);
  const fullXMax = Math.max(...allXValues);
  const xMin = viewDomain?.[0] ?? fullXMin;
  const xMax = viewDomain?.[1] ?? fullXMax;
  const visiblePoints = activeSeries
    .flatMap((item) => item.points)
    .filter((point) => point.x >= xMin && point.x <= xMax);
  const ySourcePoints = visiblePoints.length ? visiblePoints : activeSeries.flatMap((item) => item.points);
  const yValues = ySourcePoints.map((point) => point.y);
  const yMinRaw = yValues.length ? Math.min(...yValues) : 0;
  const yMaxRaw = yValues.length ? Math.max(...yValues) : 1;
  const yPadding = Math.max((yMaxRaw - yMinRaw) * 0.08, 0.1);
  const yMin = yMinRaw - yPadding;
  const yMax = yMaxRaw + yPadding;
  const width = 760;
  const height = 320;
  const margin = { top: 18, right: 20, bottom: 42, left: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const colors = ['#49c878', '#5aa7ff', '#ffd56d', '#c792ea'];
  const scaleX = (x) => margin.left + ((x - xMin) / Math.max(xMax - xMin, Number.EPSILON)) * plotWidth;
  const scaleY = (y) => margin.top + plotHeight - ((y - yMin) / Math.max(yMax - yMin, Number.EPSILON)) * plotHeight;
  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax];
  const yTicks = [yMinRaw, yMinRaw + (yMaxRaw - yMinRaw) / 2, yMaxRaw];
  const selectedSet = new Set(selectedNames);
  const zoom = (factor) => {
    const span = xMax - xMin;
    const center = xMin + span / 2;
    const nextSpan = Math.min(fullXMax - fullXMin, Math.max((fullXMax - fullXMin) / 200, span * factor));
    const nextMin = Math.max(fullXMin, Math.min(fullXMax - nextSpan, center - nextSpan / 2));
    setViewDomain([nextMin, nextMin + nextSpan]);
  };
  const pan = (direction) => {
    const span = xMax - xMin;
    const shift = span * 0.25 * direction;
    const nextMin = Math.max(fullXMin, Math.min(fullXMax - span, xMin + shift));
    setViewDomain([nextMin, nextMin + span]);
  };
  const setClampedDomain = (min, max) => {
    const fullSpan = fullXMax - fullXMin;
    const span = Math.min(max - min, fullSpan);
    const nextMin = Math.max(fullXMin, Math.min(fullXMax - span, min));
    setViewDomain([nextMin, nextMin + span]);
  };
  const toggleSeries = (name) => {
    setSelectedNames((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  };
  const handleMouseMove = (event) => {
    if (activeSeries.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const xSvg = ((event.clientX - rect.left) / rect.width) * width;
    if (dragStart) {
      const deltaSvg = xSvg - dragStart.xSvg;
      const deltaTime = (deltaSvg / plotWidth) * dragStart.span;
      setClampedDomain(dragStart.xMin - deltaTime, dragStart.xMax - deltaTime);
      return;
    }
    if (xSvg < margin.left || xSvg > width - margin.right) {
      setHover(null);
      return;
    }
    const xValue = xMin + ((xSvg - margin.left) / plotWidth) * (xMax - xMin);
    const values = activeSeries.map((item) => {
      const nearest = item.points.reduce((best, point) =>
        Math.abs(point.x - xValue) < Math.abs(best.x - xValue) ? point : best,
      item.points[0]);
      return { name: item.name, x: nearest.x, y: nearest.y };
    });
    setHover({ xSvg, xValue, values });
  };
  const beginDrag = (event) => {
    if (activeSeries.length === 0 || xMax - xMin >= fullXMax - fullXMin) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const xSvg = ((event.clientX - rect.left) / rect.width) * width;
    if (xSvg < margin.left || xSvg > width - margin.right) return;
    setHover(null);
    setDragStart({ xSvg, xMin, xMax, span: xMax - xMin });
  };
  const endDrag = () => setDragStart(null);
  const exportVisibleCsv = () => {
    const rows = [['signal', 'time_s', 'voltage_v']];
    activeSeries.forEach((item) => {
      item.points
        .filter((point) => point.x >= xMin && point.x <= xMax)
        .forEach((point) => rows.push([item.name, point.x, point.y]));
    });
    downloadText('waveform-visible.csv', rows.map((row) => row.join(',')).join('\n'), 'text/csv');
  };

  return (
    <div className="waveform-card">
      <div className="waveform-toolbar">
        <div className="waveform-actions" aria-label="Waveform controls">
          <button onClick={() => zoom(0.5)} disabled={activeSeries.length === 0}>Zoom +</button>
          <button onClick={() => zoom(2)} disabled={activeSeries.length === 0}>Zoom -</button>
          <button onClick={() => pan(-1)} disabled={activeSeries.length === 0 || xMin <= fullXMin}>Pan left</button>
          <button onClick={() => pan(1)} disabled={activeSeries.length === 0 || xMax >= fullXMax}>Pan right</button>
          <button onClick={() => setViewDomain(null)}>Reset</button>
          <button onClick={exportVisibleCsv} disabled={activeSeries.length === 0}>Export CSV</button>
        </div>
        <div className="trace-picker" aria-label="Waveform signals">
          {series.map((item, index) => (
            <label key={item.name}>
              <input
                type="checkbox"
                checked={selectedSet.has(item.name)}
                onChange={() => toggleSeries(item.name)}
              />
              <i style={{ background: colors[index % colors.length] }} />
              {item.name}
            </label>
          ))}
        </div>
      </div>

      {activeSeries.length === 0 ? (
        <p className="empty-chart">Select at least one signal to plot.</p>
      ) : (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Simulated waveform plot"
        onMouseMove={handleMouseMove}
        onMouseDown={beginDrag}
        onMouseUp={endDrag}
        onMouseLeave={() => {
          setHover(null);
          endDrag();
        }}
        className={dragStart ? 'dragging' : ''}
      >
        <defs>
          <clipPath id="waveform-clip">
            <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight} className="chart-bg" />
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line x1={margin.left} x2={width - margin.right} y1={scaleY(tick)} y2={scaleY(tick)} className="grid-line" />
            <text x={margin.left - 10} y={scaleY(tick) + 4} textAnchor="end">{formatAxisValue(tick)}</text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line x1={scaleX(tick)} x2={scaleX(tick)} y1={margin.top} y2={height - margin.bottom} className="grid-line" />
            <text x={scaleX(tick)} y={height - 15} textAnchor="middle">{formatAxisValue(tick)}</text>
          </g>
        ))}
        <line x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} className="axis-line" />
        <line x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} className="axis-line" />
        {activeSeries.map((item) => (
          <polyline
            key={item.name}
            fill="none"
            clipPath="url(#waveform-clip)"
            stroke={colors[series.findIndex((source) => source.name === item.name) % colors.length]}
            strokeWidth="2.5"
            points={item.points.map((point) => `${scaleX(point.x)},${scaleY(point.y)}`).join(' ')}
          />
        ))}
        {hover && (
          <g>
            <line x1={hover.xSvg} x2={hover.xSvg} y1={margin.top} y2={height - margin.bottom} className="cursor-line" />
            <rect x={Math.min(hover.xSvg + 10, width - 185)} y={margin.top + 10} width="172" height={30 + hover.values.length * 18} className="cursor-box" />
            <text x={Math.min(hover.xSvg + 20, width - 175)} y={margin.top + 31}>
              t = {formatAxisValue(hover.values[0]?.x ?? hover.xValue)} s
            </text>
            {hover.values.map((item, index) => (
              <text key={item.name} x={Math.min(hover.xSvg + 20, width - 175)} y={margin.top + 51 + index * 18}>
                {item.name}: {formatAxisValue(item.y)} V
              </text>
            ))}
          </g>
        )}
        <text x={margin.left + plotWidth / 2} y={height - 2} textAnchor="middle">{waveform.xLabel}</text>
        <text x="16" y={margin.top + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 16 ${margin.top + plotHeight / 2})`}>
          {waveform.yLabel}
        </text>
      </svg>
      )}
    </div>
  );
}

const diagramPath = (points) => points.map((point) => `${point.x},${point.y}`).join(' ');

const cloneDiagram = (diagram) => (diagram ? structuredClone(diagram) : null);
const wireId = (wire) => wire.id || `${wire.ref}-${wire.pin}-${wire.node}`;
const isUnconnectedTerminal = (node, ref, pin) =>
  /^NC_/i.test(String(node)) || String(node) === `${ref}_${pin}`;
const symbolDefaults = {
  resistor: { kind: 'resistor', symbolType: 'resistor', width: 130, height: 58, orientation: 'horizontal', value: '1k', prefix: 'R', nodes: 2 },
  capacitor: { kind: 'capacitor', symbolType: 'capacitor', width: 98, height: 112, orientation: 'vertical', value: '100nF', prefix: 'C', nodes: 2 },
  led: { kind: 'led', symbolType: 'led', width: 98, height: 112, orientation: 'vertical', value: 'red', prefix: 'DLED', nodes: 2 },
  source: { kind: 'voltage_source', symbolType: 'voltage_source', width: 98, height: 112, orientation: 'vertical', value: '5V', prefix: 'V', nodes: 2 },
  bjt: { kind: 'bjt_npn', symbolType: 'bjt_npn', width: 118, height: 100, orientation: 'horizontal', value: '2N2222', prefix: 'Q', nodes: 3 },
  opamp: { kind: 'opamp', symbolType: 'opamp', width: 150, height: 110, orientation: 'horizontal', value: 'LM358', prefix: 'XU', nodes: 5 },
  ground: { kind: 'ground', symbolType: 'ground', width: 72, height: 62, orientation: 'vertical', value: '0', prefix: 'GND', nodes: 1 },
};

const svgPointer = (event, diagram) => {
  const svg = event.currentTarget.ownerSVGElement || event.currentTarget;
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * diagram.width,
    y: ((event.clientY - rect.top) / rect.height) * diagram.height,
  };
};

const movedComponent = (component, dx, dy) => ({
  ...component,
  x: component.x + dx,
  y: component.y + dy,
  pins: component.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy })),
});

const movedNet = (net, dx, dy) => ({
  ...net,
  x: net.x + dx,
  y: net.y + dy,
  labelX: net.labelX + dx,
  labelY: net.labelY + dy,
  ...(net.connections ? {
    connections: net.connections.map((connection) => ({ ...connection, x: connection.x + dx, y: connection.y + dy })),
  } : {}),
});

const moveWireEndpoint = (wire, endpoint, dx, dy) => {
  if (!wire.points?.length) return wire;
  return {
    ...wire,
    points: wire.points.map((point, index) => {
      const isEndpoint = endpoint === 'start' ? index === 0 : index === wire.points.length - 1;
      return isEndpoint ? { x: point.x + dx, y: point.y + dy } : point;
    }),
  };
};

const moveWirePath = (wire, diagram, dx, dy) => {
  const points = wire.points?.length ? wire.points : wirePoints(diagram, wire);
  if (points.length < 2) return wire;
  const midpoint = points.length === 2
    ? [{ x: (points[0].x + points[1].x) / 2 + dx, y: (points[0].y + points[1].y) / 2 + dy }]
    : points.slice(1, -1).map((point) => ({ x: point.x + dx, y: point.y + dy }));
  return {
    ...wire,
    routingMode: 'manual',
    preferredWaypoints: midpoint,
    points: [points[0], ...midpoint, points.at(-1)],
  };
};

const componentPinPoint = (component, pinIndex) => {
  if (component.symbolType === 'bjt_npn' || component.symbolType === 'bjt_pnp') {
    const collectorY = component.y - component.height / 2 + 18;
    const emitterY = component.y + component.height / 2 - 18;
    if (pinIndex === 1) return { x: component.x + component.width / 2, y: collectorY };
    if (pinIndex === 2) return { x: component.x - component.width / 2, y: component.y };
    if (pinIndex === 3) return { x: component.x + component.width / 2, y: emitterY };
  }

  if (component.symbolType === 'opamp') {
    const left = component.x - component.width / 2;
    const right = component.x + component.width / 2;
    const top = component.y - component.height / 2;
    const bottom = component.y + component.height / 2;
    if (pinIndex === 1) return { x: left, y: component.y + component.height * 0.22 };
    if (pinIndex === 2) return { x: left, y: component.y - component.height * 0.22 };
    if (pinIndex === 3) return { x: right, y: component.y };
    if (pinIndex === 4) return { x: component.x, y: top };
    if (pinIndex === 5) return { x: component.x, y: bottom };
  }

  if (component.symbolType === 'ground') {
    return { x: component.x, y: component.y - component.height / 2 };
  }

  if (component.pinCount <= 2) {
    if (component.orientation === 'vertical') {
      return {
        x: component.x,
        y: pinIndex === 1 ? component.y - component.height / 2 : component.y + component.height / 2,
      };
    }
    return {
      x: pinIndex === 1 ? component.x - component.width / 2 : component.x + component.width / 2,
      y: component.y,
    };
  }

  const side = pinIndex % 2 === 1 ? -1 : 1;
  const row = Math.floor((pinIndex - 1) / 2);
  const rows = Math.ceil(component.pinCount / 2);
  return {
    x: component.x + side * (component.width / 2),
    y: component.y - ((rows - 1) * 14) / 2 + row * 28,
  };
};

const makePins = (component, nodes) =>
  nodes.map((node, index) => ({
    node,
    pinIndex: index + 1,
    ...componentPinPoint(component, index + 1),
  }));

const addedComponent = (diagram, type) => {
  const defaults = symbolDefaults[type];
  const existingRefs = new Set(diagram.components.map((component) => component.ref));
  let nextRefNumber = 1;
  while (existingRefs.has(`${defaults.prefix}${nextRefNumber}`)) nextRefNumber += 1;
  const column = diagram.components.length % 3;
  const row = Math.floor(diagram.components.length / 3);
  const nodes = defaults.kind === 'ground'
    ? ['0']
    : Array.from(
      { length: defaults.nodes },
      (_, index) => `NC_${defaults.prefix}${nextRefNumber}_${index + 1}`,
    );
  const component = {
    ref: `${defaults.prefix}${nextRefNumber}`,
    kind: defaults.kind,
    value: defaults.value,
    nodes,
    symbolType: defaults.symbolType,
    orientation: defaults.orientation,
    x: 150 + column * 210,
    y: 180 + row * 125,
    width: defaults.width,
    height: defaults.height,
    pinCount: defaults.nodes,
    order: diagram.components.length,
  };
  return { ...component, pins: makePins(component, nodes) };
};

const terminalPoint = (diagram, terminal) => {
  const component = diagram.components.find((item) => item.ref === terminal.ref);
  const pin = component?.pins.find((item) => item.pinIndex === terminal.pin);
  return pin || { x: 0, y: 0 };
};

const wirePoints = (diagram, wire) => {
  if (wire.points?.length) return wire.points;
  return routeDiagramWire(diagram, wire);
};

function DiagramSymbol({ component }) {
  const { x, y, width, height, symbolType, orientation } = component;
  const left = x - width / 2;
  const right = x + width / 2;
  const top = y - height / 2;
  const bottom = y + height / 2;

  if (symbolType === 'ground') {
    return (
      <>
        <line className="diagram-symbol" x1={x} y1={top} x2={x} y2={y - 7} />
        <line className="diagram-symbol" x1={x - 22} y1={y - 7} x2={x + 22} y2={y - 7} />
        <line className="diagram-symbol" x1={x - 14} y1={y + 3} x2={x + 14} y2={y + 3} />
        <line className="diagram-symbol" x1={x - 7} y1={y + 13} x2={x + 7} y2={y + 13} />
      </>
    );
  }

  if (orientation === 'vertical') {
    if (symbolType === 'resistor') {
      return (
        <polyline
          className="diagram-symbol"
          points={`${x},${top} ${x},${top + 18} ${x - 18},${top + 28} ${x + 18},${top + 44} ${x - 18},${top + 60} ${x + 18},${top + 76} ${x},${bottom - 18} ${x},${bottom}`}
        />
      );
    }

    if (symbolType === 'capacitor') {
      return (
        <>
          <line className="diagram-symbol" x1={x} y1={top} x2={x} y2={y - 14} />
          <line className="diagram-symbol" x1={x - 24} y1={y - 14} x2={x + 24} y2={y - 14} />
          <line className="diagram-symbol" x1={x - 24} y1={y + 14} x2={x + 24} y2={y + 14} />
          <line className="diagram-symbol" x1={x} y1={y + 14} x2={x} y2={bottom} />
        </>
      );
    }

    if (symbolType === 'diode' || symbolType === 'led') {
      return (
        <>
          <line className="diagram-symbol" x1={x} y1={top} x2={x} y2={y - 20} />
          <polygon className="diagram-fill" points={`${x - 18},${y - 20} ${x + 18},${y - 20} ${x},${y + 12}`} />
          <line className="diagram-symbol" x1={x - 20} y1={y + 14} x2={x + 20} y2={y + 14} />
          <line className="diagram-symbol" x1={x} y1={y + 14} x2={x} y2={bottom} />
          {symbolType === 'led' && (
            <>
              <line className="diagram-symbol thin" x1={x + 18} y1={y - 22} x2={x + 34} y2={y - 38} />
              <line className="diagram-symbol thin" x1={x + 30} y1={y - 16} x2={x + 46} y2={y - 32} />
            </>
          )}
        </>
      );
    }

    if (symbolType === 'voltage_source') {
      return (
        <>
          <line className="diagram-symbol" x1={x} y1={top} x2={x} y2={y - 24} />
          <circle className="diagram-symbol" cx={x} cy={y} r="24" />
          <line className="diagram-symbol" x1={x} y1={y + 24} x2={x} y2={bottom} />
          <text className="diagram-small" x={x} y={y - 8} textAnchor="middle">+</text>
          <text className="diagram-small" x={x} y={y + 16} textAnchor="middle">-</text>
        </>
      );
    }
  }

  if (symbolType === 'resistor') {
    const bodyWidth = Math.min(96, Math.max(70, width - 36));
    const bodyLeft = x - bodyWidth / 2;
    const bodyRight = x + bodyWidth / 2;
    const leadInset = bodyWidth / 6;
    return (
      <>
        <line className="diagram-symbol" x1={left} y1={y} x2={bodyLeft} y2={y} />
        <polyline
          className="diagram-symbol"
          points={`${bodyLeft},${y} ${bodyLeft + leadInset},${top + 16} ${bodyLeft + leadInset * 2},${bottom - 16} ${bodyLeft + leadInset * 3},${top + 16} ${bodyLeft + leadInset * 4},${bottom - 16} ${bodyLeft + leadInset * 5},${y} ${bodyRight},${y}`}
        />
        <line className="diagram-symbol" x1={bodyRight} y1={y} x2={right} y2={y} />
      </>
    );
  }

  if (symbolType === 'capacitor') {
    return (
      <>
        <line className="diagram-symbol" x1={left} y1={y} x2={x - 14} y2={y} />
        <line className="diagram-symbol" x1={x - 14} y1={top + 9} x2={x - 14} y2={bottom - 9} />
        <line className="diagram-symbol" x1={x + 14} y1={top + 9} x2={x + 14} y2={bottom - 9} />
        <line className="diagram-symbol" x1={x + 14} y1={y} x2={right} y2={y} />
      </>
    );
  }

  if (symbolType === 'inductor') {
    return (
      <path
        className="diagram-symbol"
        d={`M ${left} ${y} H ${left + 14} C ${left + 18} ${top + 8}, ${left + 34} ${top + 8}, ${left + 38} ${y} C ${left + 42} ${top + 8}, ${left + 58} ${top + 8}, ${left + 62} ${y} C ${left + 66} ${top + 8}, ${left + 82} ${top + 8}, ${left + 86} ${y} H ${right}`}
      />
    );
  }

  if (symbolType === 'diode' || symbolType === 'led') {
    return (
      <>
        <line className="diagram-symbol" x1={left} y1={y} x2={x - 20} y2={y} />
        <polygon className="diagram-fill" points={`${x - 20},${top + 10} ${x - 20},${bottom - 10} ${x + 12},${y}`} />
        <line className="diagram-symbol" x1={x + 14} y1={top + 8} x2={x + 14} y2={bottom - 8} />
        <line className="diagram-symbol" x1={x + 14} y1={y} x2={right} y2={y} />
        {symbolType === 'led' && (
          <>
            <line className="diagram-symbol thin" x1={x + 18} y1={top + 6} x2={x + 34} y2={top - 10} />
            <line className="diagram-symbol thin" x1={x + 30} y1={top + 12} x2={x + 46} y2={top - 4} />
          </>
        )}
      </>
    );
  }

  if (symbolType === 'voltage_source') {
    return (
      <>
        <line className="diagram-symbol" x1={left} y1={y} x2={x - 24} y2={y} />
        <circle className="diagram-symbol" cx={x} cy={y} r="24" />
        <line className="diagram-symbol" x1={x + 24} y1={y} x2={right} y2={y} />
        <text className="diagram-small" x={x} y={y - 4} textAnchor="middle">+</text>
        <text className="diagram-small" x={x} y={y + 16} textAnchor="middle">-</text>
      </>
    );
  }

  if (symbolType === 'bjt_npn' || symbolType === 'bjt_pnp') {
    const collector = component.pins.find((pin) => pin.pinIndex === 1) || { x: right, y: top + 18 };
    const base = component.pins.find((pin) => pin.pinIndex === 2) || { x: left, y };
    const emitter = component.pins.find((pin) => pin.pinIndex === 3) || { x: right, y: bottom - 18 };
    const radius = Math.min(width, height) / 2 - 12;
    const baseX = x - 16;
    const collectorJoin = { x: x + 10, y: y - 22 };
    const emitterJoin = { x: x + 10, y: y + 22 };
    const arrowPoints = symbolType === 'bjt_npn'
      ? `${emitter.x - 21},${emitter.y - 8} ${emitter.x - 5},${emitter.y} ${emitter.x - 21},${emitter.y + 8}`
      : `${emitter.x - 5},${emitter.y - 8} ${emitter.x - 21},${emitter.y} ${emitter.x - 5},${emitter.y + 8}`;

    return (
      <>
        <circle className="diagram-symbol" cx={x} cy={y} r={radius} />
        <line className="diagram-symbol" x1={base.x} y1={base.y} x2={baseX} y2={base.y} />
        <line className="diagram-symbol" x1={baseX} y1={y - 28} x2={baseX} y2={y + 28} />
        <line className="diagram-symbol" x1={baseX} y1={y - 18} x2={collectorJoin.x} y2={collectorJoin.y} />
        <line className="diagram-symbol" x1={collectorJoin.x} y1={collectorJoin.y} x2={collector.x} y2={collector.y} />
        <line className="diagram-symbol" x1={baseX} y1={y + 18} x2={emitterJoin.x} y2={emitterJoin.y} />
        <line className="diagram-symbol" x1={emitterJoin.x} y1={emitterJoin.y} x2={emitter.x} y2={emitter.y} />
        <polygon points={arrowPoints} fill="#17201a" />
        <text className="diagram-small" x={collector.x - 10} y={collector.y - 8} textAnchor="middle">C</text>
        <text className="diagram-small" x={base.x + 10} y={base.y - 8} textAnchor="middle">B</text>
        <text className="diagram-small" x={emitter.x - 10} y={emitter.y + 18} textAnchor="middle">E</text>
      </>
    );
  }

  if (symbolType === 'opamp') {
    const nonInverting = component.pins.find((pin) => pin.pinIndex === 1) || { x: left, y: y + height * 0.22 };
    const inverting = component.pins.find((pin) => pin.pinIndex === 2) || { x: left, y: y - height * 0.22 };
    const output = component.pins.find((pin) => pin.pinIndex === 3) || { x: right, y };
    const positiveSupply = component.pins.find((pin) => pin.pinIndex === 4) || { x, y: top };
    const negativeSupply = component.pins.find((pin) => pin.pinIndex === 5) || { x, y: bottom };
    const bodyLeft = left + 28;
    const bodyRight = right - 18;
    const bodyTop = top + 12;
    const bodyBottom = bottom - 12;

    return (
      <>
        <line className="diagram-symbol" x1={nonInverting.x} y1={nonInverting.y} x2={bodyLeft} y2={nonInverting.y} />
        <line className="diagram-symbol" x1={inverting.x} y1={inverting.y} x2={bodyLeft} y2={inverting.y} />
        <polygon className="diagram-fill" points={`${bodyLeft},${bodyTop} ${bodyLeft},${bodyBottom} ${bodyRight},${y}`} />
        <line className="diagram-symbol" x1={bodyRight} y1={y} x2={output.x} y2={output.y} />
        <line className="diagram-symbol" x1={positiveSupply.x} y1={positiveSupply.y} x2={positiveSupply.x} y2={bodyTop + 12} />
        <line className="diagram-symbol" x1={negativeSupply.x} y1={negativeSupply.y} x2={negativeSupply.x} y2={bodyBottom - 12} />
        <text className="diagram-small" x={bodyLeft + 18} y={nonInverting.y + 5} textAnchor="middle">+</text>
        <text className="diagram-small" x={bodyLeft + 18} y={inverting.y + 5} textAnchor="middle">-</text>
        <text className="diagram-small" x={positiveSupply.x + 18} y={positiveSupply.y + 14} textAnchor="middle">V+</text>
        <text className="diagram-small" x={negativeSupply.x + 18} y={negativeSupply.y - 6} textAnchor="middle">V-</text>
      </>
    );
  }

  return (
    <>
      <rect className="diagram-symbol" x={left} y={top} width={width} height={height} rx="6" />
      <text className="diagram-small" x={x} y={y + 5} textAnchor="middle">{component.kind.replaceAll('_', ' ')}</text>
    </>
  );
}

function GroundSymbol({ x, y }) {
  return (
    <g className="diagram-ground" aria-label="Ground">
      <circle className="diagram-node" cx={x} cy={y} r="4" />
      <line x1={x} y1={y} x2={x} y2={y + 16} />
      <line x1={x - 18} y1={y + 16} x2={x + 18} y2={y + 16} />
      <line x1={x - 12} y1={y + 22} x2={x + 12} y2={y + 22} />
      <line x1={x - 6} y1={y + 28} x2={x + 6} y2={y + 28} />
    </g>
  );
}

function PortSymbol({ port }) {
  const width = port.labelWidth || 58;
  const height = 24;
  const left = port.side === 'right' ? port.x + 10 : port.x - width - 10;
  const y = port.y - height / 2;
  const lineEnd = port.side === 'right' ? port.x + 10 : port.x - 10;
  return (
    <g className="diagram-port" pointerEvents="none" aria-label={`${port.label} port`}>
      <circle className="diagram-node" cx={port.x} cy={port.y} r="4" />
      <line className="diagram-symbol" x1={port.x} y1={port.y} x2={lineEnd} y2={port.y} />
      <rect className="diagram-net" x={left} y={y} width={width} height={height} rx="4" />
      <text className="diagram-small" x={left + width / 2} y={y + 16} textAnchor="middle">{port.label}</text>
    </g>
  );
}

function BridgeSymbol({ bridge }) {
  const radius = bridge.radius || 7;
  const path = bridge.orientation === 'vertical'
    ? `M ${bridge.x} ${bridge.y - radius} C ${bridge.x + radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y + radius} ${bridge.x} ${bridge.y + radius}`
    : `M ${bridge.x - radius} ${bridge.y} C ${bridge.x - radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y - radius} ${bridge.x + radius} ${bridge.y}`;
  const clear = bridge.orientation === 'vertical'
    ? { x1: bridge.x, y1: bridge.y - radius - 2, x2: bridge.x, y2: bridge.y + radius + 2 }
    : { x1: bridge.x - radius - 2, y1: bridge.y, x2: bridge.x + radius + 2, y2: bridge.y };
  return (
    <g className="diagram-bridge" pointerEvents="none">
      <line className="diagram-bridge-clear" {...clear} />
      <path className="diagram-bridge-arc" d={path} />
    </g>
  );
}

function CircuitDiagram({ diagram, onChange, tool, selected, onSelect, pendingTerminal, onPendingTerminal }) {
  const [drag, setDrag] = useState(null);
  const [wirePointer, setWirePointer] = useState(null);
  const dragFrameRef = useRef(0);
  const pendingDragRef = useRef(null);

  useEffect(
    () => () => {
      if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current);
    },
    [],
  );

  if (!diagram) return null;

  const capturePointer = (event) => {
    event.preventDefault();
    event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
  };

  const releasePointer = (event) => {
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // The pointer may already be released when the browser ends a drag outside the SVG.
    }
  };

  const beginComponentDrag = (event, component) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ type: 'component', ref: component.ref });
    if (tool === 'wire') return;
    capturePointer(event);
    setDrag({
      type: 'component',
      ref: component.ref,
      start: svgPointer(event, diagram),
      original: component,
      originalWires: diagram.wires.filter((wire) =>
        wire.ref === component.ref || wire.from?.ref === component.ref || wire.to?.ref === component.ref,
      ),
    });
  };

  const beginNetDrag = (event, net) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ type: 'netLabel', id: net.id, name: net.name });
    if (tool === 'wire') return;
    capturePointer(event);
    setDrag({
      type: 'netLabel',
      id: net.id,
      start: svgPointer(event, diagram),
      original: net,
      originalWire: diagram.wires.find((wire) => wire.labelId === net.id),
    });
  };

  const beginWireDrag = (event, wire) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ type: 'wire', id: wireId(wire) });
    if (tool === 'wire') return;
    capturePointer(event);
    setDrag({ type: 'wire', id: wireId(wire), start: svgPointer(event, diagram), original: wire });
  };

  const handleTerminalPointerDown = (event, component, pin) => {
    event.preventDefault();
    event.stopPropagation();
    const terminal = { ref: component.ref, pin: pin.pinIndex };
    if (tool !== 'wire') {
      onSelect({ type: 'component', ref: component.ref });
      return;
    }
    if (!pendingTerminal) {
      onPendingTerminal(terminal);
      return;
    }
    if (pendingTerminal.ref === terminal.ref && pendingTerminal.pin === terminal.pin) {
      onPendingTerminal(null);
      return;
    }
    onChange((current) => {
      const base = current || diagram;
      return {
        ...base,
        wires: [
          ...base.wires,
          {
            id: `wire-${Date.now()}`,
            manual: true,
            routingMode: 'manual',
            preferredWaypoints: [],
            points: [],
            from: pendingTerminal,
            to: terminal,
          },
        ],
      };
    });
    onPendingTerminal(null);
    setWirePointer(null);
  };

  const applyDragMove = (activeDrag, point) => {
    const dx = point.x - activeDrag.start.x;
    const dy = point.y - activeDrag.start.y;
    onChange((current) => {
      if (!current) return current;
      if (activeDrag.type === 'component') {
        const moved = movedComponent(activeDrag.original, dx, dy);
        return {
          ...current,
          components: current.components.map((component) =>
            component.ref === activeDrag.ref ? moved : component,
          ),
          wires: current.wires.map((wire) => {
            const originalWire = activeDrag.originalWires.find((item) => wireId(item) === wireId(wire));
            if (!originalWire) return wire;
            if (wire.manual) {
              if (wire.from?.ref === activeDrag.ref) return moveWireEndpoint(originalWire, 'start', dx, dy);
              if (wire.to?.ref === activeDrag.ref) return moveWireEndpoint(originalWire, 'end', dx, dy);
              return wire;
            }
            return wire.ref === activeDrag.ref ? moveWireEndpoint(originalWire, 'start', dx, dy) : wire;
          }),
        };
      }

      return {
        ...current,
        ...(activeDrag.type === 'netLabel'
          ? {
              netLabels: current.netLabels.map((net) =>
                net.id === activeDrag.id ? movedNet(activeDrag.original, dx, dy) : net,
              ),
              wires: current.wires.map((wire) =>
                wire.labelId === activeDrag.id && activeDrag.originalWire
                  ? moveWireEndpoint(activeDrag.originalWire, 'end', dx, dy)
                  : wire,
              ),
            }
          : {
              wires: current.wires.map((wire) =>
                wireId(wire) === activeDrag.id
                  ? moveWirePath(activeDrag.original, current, dx, dy)
                  : wire,
              ),
            }),
      };
    });
  };

  const scheduleDragMove = (activeDrag, point) => {
    pendingDragRef.current = { activeDrag, point };
    if (dragFrameRef.current) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      const pending = pendingDragRef.current;
      pendingDragRef.current = null;
      dragFrameRef.current = 0;
      if (pending) applyDragMove(pending.activeDrag, pending.point);
    });
  };

  const handlePointerMove = (event) => {
    const point = svgPointer(event, diagram);
    if (drag) {
      scheduleDragMove(drag, point);
      return;
    }
    if (tool === 'wire' && pendingTerminal) setWirePointer(point);
  };

  const endDrag = (event) => {
    if (!drag) return;
    if (pendingDragRef.current) {
      applyDragMove(pendingDragRef.current.activeDrag, pendingDragRef.current.point);
      pendingDragRef.current = null;
    }
    if (dragFrameRef.current) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = 0;
    }
    releasePointer(event);
    if (drag.type === 'component') {
      onChange((current) => {
        if (!current) return current;
        try {
          return rerouteAffectedNets(current);
        } catch {
          return current;
        }
      });
    }
    setDrag(null);
  };

  const cancelPendingWire = (event) => {
    event.preventDefault();
    if (tool === 'wire' && pendingTerminal) {
      onPendingTerminal(null);
      setWirePointer(null);
    } else {
      onSelect(null);
    }
  };

  const pendingWireStart = pendingTerminal ? terminalPoint(diagram, pendingTerminal) : null;
  const visibleWires = diagram.wires.filter(
    (wire) => wire.manual || !isUnconnectedTerminal(wire.node, wire.ref, wire.pin),
  );
  const visibleNets = diagram.netLabels || [];
  const visibleGroundLabelIds = new Set(visibleNets.filter((net) => net.name === '0').map((net) => net.id));
  const fallbackGroundSymbols = [
    ...new Map(visibleWires
      .filter((wire) => !wire.manual && wire.node === '0' && !visibleGroundLabelIds.has(wire.labelId))
      .map((wire) => {
        const point = wirePoints(diagram, wire).at(-1);
        return point ? [`${point.x}:${point.y}`, point] : null;
      })
      .filter(Boolean)).values(),
  ];

  return (
    <div className="diagram-card">
      <svg
        viewBox={`0 0 ${diagram.width} ${diagram.height}`}
        role="img"
        aria-label={`${diagram.title} editable circuit diagram`}
        className={[drag ? 'dragging' : '', tool === 'wire' ? 'wire-mode' : ''].filter(Boolean).join(' ')}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <pattern id="diagram-grid-small" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 H 0 V 24" className="diagram-grid-small" />
          </pattern>
          <pattern id="diagram-grid-large" width="120" height="120" patternUnits="userSpaceOnUse">
            <rect width="120" height="120" fill="url(#diagram-grid-small)" />
            <path d="M 120 0 H 0 V 120" className="diagram-grid-large" />
          </pattern>
        </defs>
        <rect className="diagram-bg" width={diagram.width} height={diagram.height} rx="8" onPointerDown={cancelPendingWire} />
        <rect width={diagram.width} height={diagram.height} fill="url(#diagram-grid-large)" pointerEvents="none" />
        {visibleWires.map((wire) => {
          const points = wirePoints(diagram, wire);
          return (
            <polyline
              key={wireId(wire)}
              className={selected?.type === 'wire' && selected.id === wireId(wire) ? 'diagram-wire selected' : 'diagram-wire'}
              points={diagramPath(points)}
              onPointerDown={(event) => beginWireDrag(event, wire)}
            />
          );
        })}
        {(diagram.bridges || []).map((bridge, index) => (
          <BridgeSymbol bridge={bridge} key={`${bridge.wireId}-${bridge.x}-${bridge.y}-${index}`} />
        ))}
        {pendingWireStart && wirePointer && (
          <polyline
            className="diagram-wire pending"
            points={diagramPath([pendingWireStart, wirePointer])}
            pointerEvents="none"
          />
        )}
        {visibleNets.map((net) => (
          <g
            key={net.id}
            className={selected?.type === 'netLabel' && selected.id === net.id ? 'editable-net selected' : 'editable-net'}
            onPointerDown={(event) => beginNetDrag(event, net)}
          >
            {net.name === '0' ? (
              <GroundSymbol x={net.x} y={net.y} />
            ) : (
              <>
                <rect className="diagram-net" x={net.labelX} y={net.labelY} width={net.labelWidth} height="26" rx="13" />
                <text className="diagram-small" x={net.labelX + net.labelWidth / 2} y={net.labelY + 17} textAnchor="middle">{net.name}</text>
              </>
            )}
          </g>
        ))}
        {fallbackGroundSymbols.map((point) => (
          <GroundSymbol key={`fallback-ground-${point.x}-${point.y}`} x={point.x} y={point.y} />
        ))}
        {(diagram.ports || []).map((port) => (
          <PortSymbol key={port.id} port={port} />
        ))}
        {(diagram.junctions || []).map((junction) => (
          <circle
            key={junction.id || `${junction.node}-${junction.x}-${junction.y}`}
            className="diagram-node"
            cx={junction.x}
            cy={junction.y}
            r="4"
            pointerEvents="none"
          />
        ))}
        {diagram.components.map((component) => {
          const refLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'ref');
          const valueLabel = diagram.labels?.find((label) => label.ref === component.ref && label.kind === 'value');
          const isGroundComponent = component.symbolType === 'ground';
          return (
          <g
            key={component.ref}
            className={selected?.type === 'component' && selected.ref === component.ref ? 'editable-component selected' : 'editable-component'}
            onPointerDown={(event) => beginComponentDrag(event, component)}
          >
            <DiagramSymbol component={component} />
            {!isGroundComponent && (
              <>
                <text className="diagram-text" x={refLabel?.x || component.x} y={refLabel?.y || component.y - component.height / 2 - 12} textAnchor="middle">
                  {component.ref}
                </text>
                <text className="diagram-small" x={valueLabel?.x || component.x} y={valueLabel?.y || component.y + component.height / 2 + 20} textAnchor="middle">
                  {component.value}
                </text>
              </>
            )}
            {component.pins.map((pin) => (
              <g key={`${component.ref}-${pin.pinIndex}`} className="diagram-terminal" onPointerDown={(event) => handleTerminalPointerDown(event, component, pin)}>
                <circle className="terminal-hit" cx={pin.x} cy={pin.y} r="14" />
                <circle
                  className={pendingTerminal?.ref === component.ref && pendingTerminal?.pin === pin.pinIndex ? 'terminal-dot selected' : 'terminal-dot'}
                  cx={pin.x}
                  cy={pin.y}
                  r="6"
                />
                {!isGroundComponent && (
                  <text className="diagram-small" x={pin.x} y={pin.y - 8} textAnchor="middle">
                    {pin.pinIndex}
                  </text>
                )}
              </g>
            ))}
          </g>
          );
        })}
      </svg>
    </div>
  );
}

function App() {
  const { user, loading, logout } = useAuth();
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('pcb_token')}`,
  });
  const [chatStore, setChatStore] = useState(loadChatStore);
  const [diagramTool, setDiagramTool] = useState('select');
  const [diagramSelection, setDiagramSelection] = useState(null);
  const [pendingTerminal, setPendingTerminal] = useState(null);
  const [openEditorViews, setOpenEditorViews] = useState(['spice']);
  const [activeEditorView, setActiveEditorView] = useState('spice');
  const [editorSplit, setEditorSplit] = useState(loadEditorSplit);
  const [resizingAxis, setResizingAxis] = useState(null);
  const [chatPanelView, setChatPanelView] = useState('conversation');
  const [page, setPage] = useState(pageFromHash);
  const [generatingChatId, setGeneratingChatId] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const messagesEndRef = useRef(null);
  const spiceEditorRef = useRef(null);
  const resizeDragRef = useRef(null);
  const activeChat = chatStore.chats.find((chat) => chat.id === chatStore.activeChatId) || chatStore.chats[0];
  const prompt = activeChat?.draft || '';
  const result = activeChat?.result || null;
  const editableSpice = activeChat?.editableSpice || '';
  const pendingSpiceChange = activeChat?.pendingSpiceChange || null;
  const editableKicadNetlist = activeChat?.editableKicadNetlist || '';
  const pendingKicadChange = activeChat?.pendingKicadChange || null;
  const editableCircuitJson = activeChat?.editableCircuitJson || '';
  const editedDiagram = activeChat?.editedDiagram || null;
  const simulationRun = activeChat?.simulationRun || null;
  const error = activeChat?.error || '';
  const simulationError = activeChat?.simulationError || '';
  const spiceSyncError = activeChat?.spiceSyncError || '';
  const kicadSyncError = activeChat?.kicadSyncError || '';
  const circuitJsonSyncError = activeChat?.circuitJsonSyncError || '';
  const isGenerating = generatingChatId === activeChat?.id;
  const generationBusy = Boolean(generatingChatId);
  const sortedChats = useMemo(
    () => [...chatStore.chats].sort((a, b) => b.updatedAt - a.updatedAt),
    [chatStore.chats],
  );
  const pendingSpiceChangedLines = useMemo(
    () => pendingSpiceChange
      ? changedLineIndexes(pendingSpiceChange.previous, pendingSpiceChange.proposed)
      : new Set(),
    [pendingSpiceChange],
  );

  const updateChat = (chatId, updater) => {
    setChatStore((current) => ({
      ...current,
      chats: current.chats.map((chat) => (chat.id === chatId ? updater(chat) : chat)),
    }));
  };

  const updateActiveChat = (updater) => updateChat(chatStore.activeChatId, updater);
  const setChatField = (field, value) => {
    updateActiveChat((chat) => ({
      ...chat,
      [field]: typeof value === 'function' ? value(chat[field]) : value,
    }));
  };
  const setPrompt = (value) => setChatField('draft', value);
  const setEditableSpice = (value) => setChatField('editableSpice', value);
  const setEditableCircuitJson = (value) => setChatField('editableCircuitJson', value);
  const setEditedDiagram = (value) => setChatField('editedDiagram', value);
  const setSimulationRun = (value) => setChatField('simulationRun', value);
  const setError = (value) => setChatField('error', value);
  const setSimulationError = (value) => setChatField('simulationError', value);

  const applyDiagramChange = (value) => {
    updateActiveChat((chat) => {
      try {
        const currentDiagram = chat.editedDiagram || chat.result?.diagram;
        const nextDiagram = typeof value === 'function' ? value(currentDiagram) : value;
        if (!chat.result || !nextDiagram) return { ...chat, editedDiagram: nextDiagram };

        const nextCircuit = circuitFromDiagram(nextDiagram, chat.result.circuit);
        if (circuitElectricalSignature(nextCircuit) === circuitElectricalSignature(chat.result.circuit)) {
          return { ...chat, editedDiagram: nextDiagram, error: '' };
        }

        const synchronized = synchronizeResult(chat.result, nextCircuit, nextDiagram);
        return {
          ...chat,
          updatedAt: Date.now(),
          result: synchronized,
          editedDiagram: synchronized.diagram,
          editableSpice: synchronized.spice,
          editableKicadNetlist: synchronized.kicadNetlist,
          editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
          simulationRun: null,
          simulationError: '',
          spiceSyncError: '',
          kicadSyncError: '',
          circuitJsonSyncError: '',
          error: '',
        };
      } catch (layoutError) {
        return { ...chat, error: layoutError.message };
      }
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveChatStore(chatStore);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [chatStore]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(EDITOR_SPLIT_STORAGE_KEY, JSON.stringify(editorSplit));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [editorSplit]);

  useEffect(() => {
    const syncPageFromHash = () => {
      setPage(pageFromHash());
    };

    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  useEffect(() => {
    if (loading) return;

    if (!user && !PUBLIC_PAGES.has(page)) {
      if (window.location.hash !== '#login') {
        window.location.hash = 'login';
      } else {
        setPage('login');
      }
      return;
    }

    if (user && AUTH_PAGES.has(page)) {
      if (window.location.hash) {
        window.location.hash = '';
      } else {
        setPage('workspace');
      }
    }
  }, [loading, user, page]);

  useEffect(() => {
    const active = chatStore.chats.find((c) => c.id === chatStore.activeChatId);
    if (!active) return;
    const migrated = migrateChatDiagram(active);
    if (migrated !== active) {
      setChatStore((prev) => ({
        ...prev,
        chats: prev.chats.map((c) => (c.id === active.id ? migrated : c)),
      }));
    }
  }, [chatStore.activeChatId]);

  useEffect(() => {
    if (result?.diagram && !activeChat?.editedDiagram) {
      setEditedDiagram(cloneDiagram(result.diagram));
    }
  }, [result?.diagram, activeChat?.editedDiagram]);

  useEffect(() => {
    setDiagramSelection(null);
    setPendingTerminal(null);
    setDiagramTool('select');
  }, [chatStore.activeChatId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [chatStore.activeChatId, activeChat?.messages.length, generatingChatId, chatPanelView]);

  useEffect(() => {
    if (!isGenerating || !openEditorViews.includes('spice') || !spiceEditorRef.current) return;
    spiceEditorRef.current.scrollTop = spiceEditorRef.current.scrollHeight;
  }, [editableSpice, isGenerating, openEditorViews]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    if (pendingSpiceChange) return undefined;
    if (editableSpice === result.spice) {
      if (spiceSyncError) setChatField('spiceSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableSpice;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableSpice !== source) return chat;
        const parsed = parseSpiceNetlist(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, spiceSyncError: parsed.errors.join(' ') };

        if (circuitElectricalSignature(parsed.circuit) === circuitElectricalSignature(chat.result.circuit)) {
          return {
            ...chat,
            result: { ...chat.result, spice: source },
            editableCircuitJson: JSON.stringify(chat.result.circuit, null, 2),
            spiceSyncError: '',
          };
        }

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
            { spice: source },
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableKicadNetlist: synchronized.kicadNetlist,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            spiceSyncError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, spiceSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableSpice, isGenerating, result?.spice, pendingSpiceChange]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    if (pendingKicadChange) return undefined;
    if (editableKicadNetlist === result.kicadNetlist) {
      if (kicadSyncError) setChatField('kicadSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableKicadNetlist;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableKicadNetlist !== source) return chat;
        const parsed = parseKiCadNetlist(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, kicadSyncError: parsed.errors.join(' ') };

        if (circuitElectricalSignature(parsed.circuit) === circuitElectricalSignature(chat.result.circuit)) {
          return {
            ...chat,
            result: { ...chat.result, kicadNetlist: source },
            editableCircuitJson: JSON.stringify(chat.result.circuit, null, 2),
            kicadSyncError: '',
          };
        }

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
            { kicadNetlist: source },
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableSpice: synchronized.spice,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, kicadSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableKicadNetlist, isGenerating, result?.kicadNetlist, pendingKicadChange]);

  useEffect(() => {
    if (!result || isGenerating || !activeChat) return undefined;
    const canonicalJson = JSON.stringify(result.circuit, null, 2);
    if (editableCircuitJson === canonicalJson) {
      if (circuitJsonSyncError) setChatField('circuitJsonSyncError', '');
      return undefined;
    }

    const chatId = activeChat.id;
    const source = editableCircuitJson;
    const timer = window.setTimeout(() => {
      updateChat(chatId, (chat) => {
        if (!chat.result || chat.editableCircuitJson !== source) return chat;
        const parsed = parseCircuitJson(source, chat.result.circuit);
        if (!parsed.ok) return { ...chat, circuitJsonSyncError: parsed.errors.join(' ') };

        try {
          const synchronized = synchronizeResult(
            chat.result,
            parsed.circuit,
            chat.editedDiagram || chat.result.diagram,
          );
          return {
            ...chat,
            updatedAt: Date.now(),
            result: synchronized,
            editedDiagram: synchronized.diagram,
            editableSpice: synchronized.spice,
            editableKicadNetlist: synchronized.kicadNetlist,
            editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
            simulationRun: null,
            simulationError: '',
            spiceSyncError: '',
            kicadSyncError: '',
            circuitJsonSyncError: '',
          };
        } catch (layoutError) {
          return { ...chat, circuitJsonSyncError: layoutError.message };
        }
      });
    }, 400);

    return () => window.clearTimeout(timer);
  }, [activeChat?.id, editableCircuitJson, isGenerating, result?.circuit, circuitJsonSyncError]);

  const manifest = useMemo(
    () =>
      JSON.stringify(
        {
          name: result?.circuit.title,
          sourcePrompt: result?.intent.rawPrompt,
          generatedAt: new Date().toISOString(),
          files: ['generated.cir', 'generated.svg', 'circuit.json'],
          ngspice: result?.simulation.command,
        },
        null,
        2,
      ),
    [result],
  );
  const circuitJson = useMemo(
    () => editableCircuitJson || (result?.circuit ? JSON.stringify(result.circuit, null, 2) : ''),
    [editableCircuitJson, result?.circuit],
  );

  const openEditorView = (view) => {
    setOpenEditorViews((current) => (current.includes(view) ? current : [...current, view]));
    setActiveEditorView(view);
  };

  const closeEditorView = (view) => {
    const next = openEditorViews.filter((item) => item !== view);
    setOpenEditorViews(next);
    if (activeEditorView === view) setActiveEditorView(next.at(-1) || null);
  };

  const startEditorResize = (axis, event) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDragRef.current = { axis, container };
    setResizingAxis(axis);
  };

  const moveEditorResize = (event) => {
    const drag = resizeDragRef.current;
    if (!drag || !drag.container) return;
    const bounds = drag.container.getBoundingClientRect();
    const raw = drag.axis === 'columns'
      ? ((event.clientX - bounds.left) / bounds.width) * 100
      : ((event.clientY - bounds.top) / bounds.height) * 100;
    const minimum = drag.axis === 'columns' ? 25 : 32;
    const maximum = drag.axis === 'columns' ? 75 : 72;
    setEditorSplit((current) => ({
      ...current,
      [drag.axis]: Math.min(maximum, Math.max(minimum, raw)),
    }));
  };

  const stopEditorResize = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeDragRef.current = null;
    setResizingAxis(null);
  };

  const generate = async () => {
    const submittedPrompt = prompt.trim();
    if (!submittedPrompt) {
      setError('Enter a circuit prompt before sending.');
      return;
    }

    const chatId = activeChat.id;
    const priorMessages = activeChat.messages;
    const currentDesign = result
      ? {
          circuit: result.circuit,
          spice: editableSpice,
          kicadNetlist: editableKicadNetlist,
        }
      : null;
    const isRevision = Boolean(currentDesign);
    const userMessage = {
      id: messageId(),
      role: 'user',
      content: submittedPrompt,
      createdAt: Date.now(),
    };

    setGeneratingChatId(chatId);
    openEditorView('spice');
    window.location.hash = '';
    setPage('workspace');
    updateChat(chatId, (chat) => ({
      ...chat,
      title: chat.messages.length ? chat.title : chatTitleFromPrompt(submittedPrompt),
      updatedAt: Date.now(),
      draft: '',
      error: '',
      editableSpice: isRevision
        ? chat.editableSpice
        : '* AI is preparing the circuit...\n* Components will appear here as they are generated.',
      editableCircuitJson: isRevision ? chat.editableCircuitJson : '',
      simulationRun: null,
      simulationError: '',
      circuitJsonSyncError: '',
      messages: [...chat.messages, userMessage],
    }));

    try {
      const response = await fetch(`${API_BASE}/api/generate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          prompt: submittedPrompt,
          messages: buildConversationContext(priorMessages),
          currentDesign,
          memory: activeChat.memory,
        }),
      });

      if (!response.ok) {
        const failed = await response.json();
        throw new Error(failed.error || `Generation failed with HTTP ${response.status}.`);
      }
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/x-ndjson')
        ? await readGenerationStream(response, (event) => {
            if (event.type !== 'spice') return;
            updateChat(chatId, (chat) => ({
              ...chat,
              editableSpice: event.provisional
                ? markSpiceAsProvisional(event.spice, event.correcting)
                : event.spice,
              updatedAt: Date.now(),
            }));
          })
        : await response.json();
      if (data.error) throw new Error(data.error);
      const fallbackReply = `${isRevision ? 'Updated' : 'Generated'} ${data.circuit.title} with ${data.circuit.components.length} components. The latest circuit package is open in the workspace.`;
      const assistantMessage = {
        id: messageId(),
        role: 'assistant',
        content: String(data.reply || '').trim() || fallbackReply,
        circuit: data.circuit,
        createdAt: Date.now(),
      };
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: Date.now(),
        messages: [...chat.messages, assistantMessage],
        memory: data.memory || chat.memory,
        result: data,
        editableSpice: data.spice || '',
        pendingSpiceChange: currentDesign && currentDesign.spice !== data.spice
          ? { previous: currentDesign.spice, proposed: data.spice || '' }
          : null,
        editableKicadNetlist: data.kicadNetlist || '',
        pendingKicadChange: currentDesign && currentDesign.kicadNetlist !== data.kicadNetlist
          ? { previous: currentDesign.kicadNetlist, proposed: data.kicadNetlist || '' }
          : null,
        editableCircuitJson: JSON.stringify(data.circuit, null, 2),
        editedDiagram: cloneDiagram(data.diagram),
        simulationRun: null,
        simulationError: '',
        spiceSyncError: '',
        kicadSyncError: '',
        circuitJsonSyncError: '',
        error: '',
      }));
      window.location.hash = '';
      setPage('workspace');
    } catch (requestError) {
      updateChat(chatId, (chat) => ({
        ...chat,
        updatedAt: Date.now(),
        editableSpice: currentDesign ? currentDesign.spice : chat.editableSpice,
        editableCircuitJson: currentDesign
          ? JSON.stringify(currentDesign.circuit, null, 2)
          : chat.editableCircuitJson,
        error: requestError.message,
        messages: [
          ...chat.messages,
          {
            id: messageId(),
            role: 'assistant',
            content: `I could not generate the circuit: ${requestError.message}`,
            createdAt: Date.now(),
          },
        ],
      }));
    } finally {
      setGeneratingChatId(null);
    }
  };

  const runSimulation = async () => {
    if (!result) return;
    const chatId = activeChat.id;
    setIsSimulating(true);
    setSimulationError('');

    try {
      const response = await fetch(`${API_BASE}/api/simulate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ circuit: result.circuit, spice: editableSpice }),
      });
      const data = await response.json();
      updateChat(chatId, (chat) => ({ ...chat, simulationRun: data }));
      if (!response.ok || !data.ok) {
        throw new Error(data.errors?.join(' ') || data.error || `Simulation failed with HTTP ${response.status}.`);
      }
      window.location.hash = 'waveform';
      setPage('waveform');
    } catch (requestError) {
      updateChat(chatId, (chat) => ({ ...chat, simulationError: requestError.message }));
    } finally {
      setIsSimulating(false);
    }
  };

  const exportAll = () => {
    if (!result) return;
    downloadText('generated.cir', editableSpice);
    downloadText('generated.svg', toDiagramSvg(editedDiagram || result.diagram), 'image/svg+xml');
    downloadText('circuit.json', JSON.stringify(result.circuit, null, 2), 'application/json');
    downloadText('README-export.json', manifest, 'application/json');
  };

  const addDiagramComponent = (type) => {
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      const next = cloneDiagram(base);
      const component = addedComponent(next, type);
      next.components.push(component);
      const placement = findNearestLegalPlacement(next, component.ref, component);
      const placedComponent = placement
        ? movedComponent(component, placement.x - component.x, placement.y - component.y)
        : component;
      next.components = next.components.map((item) => item.ref === component.ref ? placedComponent : item);
      next.width = Math.max(next.width, placement?.width || 0);
      next.height = Math.max(next.height, placement?.height || 0, placedComponent.y + placedComponent.height / 2 + 80);
      setDiagramSelection({ type: 'component', ref: component.ref });
      setPendingTerminal(null);
      setDiagramTool('select');
      return next;
    });
  };

  const deleteDiagramSelection = () => {
    if (!diagramSelection) return;
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      const next = cloneDiagram(base);
      if (diagramSelection.type === 'component') {
        next.components = next.components.filter((component) => component.ref !== diagramSelection.ref);
        next.wires = next.wires.filter((wire) => {
          if (wire.manual) return wire.from.ref !== diagramSelection.ref && wire.to.ref !== diagramSelection.ref;
          return wire.ref !== diagramSelection.ref;
        });
      }
      if (diagramSelection.type === 'wire') {
        next.wires = next.wires.filter((wire) => wireId(wire) !== diagramSelection.id);
      }
      if (diagramSelection.type === 'netLabel') {
        next.netLabels = next.netLabels.filter((label) => label.id !== diagramSelection.id);
        next.wires = next.wires.filter((wire) => wire.labelId !== diagramSelection.id);
      }
      return next;
    });
    setDiagramSelection(null);
    setPendingTerminal(null);
  };

  const updateSelectedComponentValue = (value) => {
    if (diagramSelection?.type !== 'component') return;
    applyDiagramChange((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      return {
        ...base,
        components: base.components.map((component) =>
          component.ref === diagramSelection.ref ? { ...component, value } : component,
        ),
      };
    });
  };

  const showWorkspace = () => {
    window.location.hash = '';
    setPage('workspace');
  };

  const openChat = (chatId) => {
    setChatStore((current) => ({ ...current, activeChatId: chatId }));
    setChatPanelView('conversation');
    openEditorView('spice');
    window.location.hash = '';
    setPage('workspace');
  };

  const startNewChat = () => {
    if (activeChat && activeChat.messages.length === 0 && !activeChat.result) {
      openChat(activeChat.id);
      return;
    }
    const chat = createChat();
    setChatStore((current) => ({
      chats: [chat, ...current.chats],
      activeChatId: chat.id,
    }));
    setChatPanelView('conversation');
    openEditorView('spice');
    window.location.hash = '';
    setPage('workspace');
  };

  const handleComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!generationBusy) generate();
    }
  };

  const acceptCircuitRevision = () => {
    updateActiveChat((chat) => ({
      ...chat,
      pendingSpiceChange: null,
      pendingKicadChange: null,
      editableCircuitJson: chat.result?.circuit ? JSON.stringify(chat.result.circuit, null, 2) : chat.editableCircuitJson,
      circuitJsonSyncError: '',
    }));
  };

  const rejectCircuitRevision = () => {
    updateActiveChat((chat) => {
      const previousSpice = chat.pendingSpiceChange?.previous;
      const previousKicad = chat.pendingKicadChange?.previous;
      if (!chat.result || (!previousSpice && !previousKicad)) {
        return { ...chat, pendingSpiceChange: null, pendingKicadChange: null };
      }

      const parsed = previousSpice
        ? parseSpiceNetlist(previousSpice, chat.result.circuit)
        : parseKiCadNetlist(previousKicad, chat.result.circuit);
      if (!parsed.ok) {
        return {
          ...chat,
          editableSpice: previousSpice || chat.editableSpice,
          editableKicadNetlist: previousKicad || chat.editableKicadNetlist,
          editableCircuitJson: chat.result?.circuit ? JSON.stringify(chat.result.circuit, null, 2) : chat.editableCircuitJson,
          pendingSpiceChange: null,
          pendingKicadChange: null,
          circuitJsonSyncError: '',
        };
      }

      const synchronized = synchronizeResult(
        chat.result,
        parsed.circuit,
        chat.editedDiagram || chat.result.diagram,
        {
          ...(previousSpice ? { spice: previousSpice } : {}),
          ...(previousKicad ? { kicadNetlist: previousKicad } : {}),
        },
      );
      return {
        ...chat,
        result: synchronized,
        editableSpice: previousSpice || synchronized.spice,
        editableKicadNetlist: previousKicad || synchronized.kicadNetlist,
        editableCircuitJson: JSON.stringify(synchronized.circuit, null, 2),
        editedDiagram: synchronized.diagram,
        pendingSpiceChange: null,
        pendingKicadChange: null,
        simulationRun: null,
        simulationError: '',
        spiceSyncError: '',
        kicadSyncError: '',
        circuitJsonSyncError: '',
      };
    });
  };

  const renderReviewActions = (label) => (
    <span className="netlist-review-actions" aria-label={`Review AI ${label} changes`}>
      <button
        className="netlist-review-button accept"
        onClick={acceptCircuitRevision}
        type="button"
        aria-label={`Accept ${label} changes`}
        title="Accept changes"
      >
        &#10003;
      </button>
      <button
        className="netlist-review-button reject"
        onClick={rejectCircuitRevision}
        type="button"
        aria-label={`Reject ${label} changes`}
        title="Reject changes"
      >
        &times;
      </button>
    </span>
  );

  const renderChangedCode = (text, changedLines, label) => {
    const lastChangedLine = Math.max(...changedLines);
    return (
      <pre className="code-editor editor-window-code netlist-diff" aria-label={`Pending ${label} changes`}>
        {text.split('\n').map((line, index) => {
          const changed = changedLines.has(index);
          return (
            <span className={`diff-line ${changed ? 'changed' : ''}`} key={`${index}-${line}`}>
              <code>{line || ' '}</code>
              {index === lastChangedLine && renderReviewActions(label)}
            </span>
          );
        })}
      </pre>
    );
  };

  const selectedDiagramComponent = diagramSelection?.type === 'component'
    ? (editedDiagram || result?.diagram)?.components.find((component) => component.ref === diagramSelection.ref)
    : null;
  const selectedEditableComponent = selectedDiagramComponent?.symbolType === 'ground'
    ? null
    : selectedDiagramComponent;

  const renderSpiceView = () => (
    <div className="editor-window-body code-window-body">
      <div className="editor-header">
        <div>
          <h3>SPICE deck</h3>
          <p>
            {isGenerating
              ? 'AI is updating this deck in real time.'
              : result
                ? ''
                : 'The live deck will appear here while the AI generates the circuit.'}
          </p>
        </div>
        <div className="spice-editor-actions">
          <button
            className="play-simulation-button"
            onClick={runSimulation}
            disabled={!result || isSimulating || isGenerating}
            type="button"
            aria-label={isSimulating ? 'Simulation running' : 'Run simulation'}
            title={isSimulating ? 'Simulation running' : 'Run simulation'}
          >
            <span aria-hidden="true">{isSimulating ? '...' : '\u25B6'}</span>
          </button>
          <button onClick={() => setEditableSpice(result?.spice || '')} disabled={!result || isGenerating || Boolean(pendingSpiceChange)}>Reset</button>
          <button onClick={() => downloadText('generated.cir', editableSpice)} disabled={!editableSpice || isGenerating}>Download</button>
        </div>
      </div>
      {pendingSpiceChange
        ? renderChangedCode(editableSpice, pendingSpiceChangedLines, 'SPICE')
        : (
          <textarea
            ref={spiceEditorRef}
            className={`code-editor editor-window-code ${isGenerating ? 'live-code-editor' : ''}`}
            value={editableSpice}
            readOnly={isGenerating}
            onChange={(event) => {
              setEditableSpice(event.target.value);
              setSimulationRun(null);
              setSimulationError('');
            }}
            spellCheck="false"
            rows={24}
            aria-label="Editable SPICE deck"
            placeholder="Generate a circuit to create a SPICE deck."
          />
        )}
      <div className="spice-simulation-results">
        {spiceSyncError && <p className="inline-error simulation-message">Canvas sync paused: {spiceSyncError}</p>}
        {simulationError && <p className="inline-error simulation-message">{simulationError}</p>}
        {simulationRun?.ok && (
          <p className="simulation-ok">
            Simulation completed successfully. <button className="text-button" onClick={() => { window.location.hash = 'waveform'; setPage('waveform'); }}>Open waveform page</button>
          </p>
        )}
        {simulationRun?.rawOutput && (
          <details className="sim-log">
            <summary>Ngspice log</summary>
            <pre>{simulationRun.rawOutput}</pre>
          </details>
        )}
      </div>
    </div>
  );

  const renderCanvasView = () => (
    <div className="editor-window-body canvas-window-body">
      {!result ? (
        <div className="editor-window-empty">
          <strong>No canvas available</strong>
          <p>Generate a circuit to open its editable schematic canvas.</p>
        </div>
      ) : (
        <>
          <div className="canvas-window-toolbar">
            <div className="canvas-tool-stack">
              <div className="diagram-editbar" aria-label="Diagram tools">
                <button className={diagramTool === 'select' ? 'active-tool' : ''} onClick={() => { setDiagramTool('select'); setPendingTerminal(null); }}>Select</button>
                <button className={diagramTool === 'wire' ? 'active-tool' : ''} onClick={() => { setDiagramTool('wire'); setPendingTerminal(null); }}>Wire</button>
                {ADD_COMPONENT_TOOLS.map((tool) => (
                  <button
                    className="component-symbol-button"
                    key={tool.type}
                    onClick={() => addDiagramComponent(tool.type)}
                    title={tool.label}
                    type="button"
                    aria-label={tool.label}
                  >
                    <ComponentToolIcon type={tool.type} />
                  </button>
                ))}
                <button onClick={deleteDiagramSelection} disabled={!diagramSelection}>Delete</button>
              </div>
              {selectedEditableComponent && (
                <label className="component-value-editor">
                  <span>{selectedEditableComponent.ref} value</span>
                  <input
                    type="text"
                    value={selectedEditableComponent.value}
                    onChange={(event) => updateSelectedComponentValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                        setDiagramSelection(null);
                      }
                    }}
                    aria-label={`Value for ${selectedEditableComponent.ref}`}
                    spellCheck="false"
                  />
                </label>
              )}
            </div>
            <div className="button-row">
              <button onClick={() => applyDiagramChange(() => layoutCircuitDiagram(result.circuit))}>Auto-layout</button>
              <button onClick={() => setEditedDiagram(cloneDiagram(result.diagram))}>Reset</button>
              <button onClick={() => downloadText('generated.svg', toDiagramSvg(editedDiagram || result.diagram), 'image/svg+xml')}>Download SVG</button>
            </div>
          </div>
          <CircuitDiagram
            diagram={editedDiagram || result.diagram}
            onChange={applyDiagramChange}
            tool={diagramTool}
            selected={diagramSelection}
            onSelect={setDiagramSelection}
            pendingTerminal={pendingTerminal}
            onPendingTerminal={setPendingTerminal}
          />
        </>
      )}
    </div>
  );

  const renderJsonView = () => (
    <div className="editor-window-body code-window-body">
      <div className="editor-header">
        <div>
          <h3>Circuit JSON</h3>
          <p>{result ? '' : 'Generate a circuit to inspect its structured JSON.'}</p>
        </div>
        <div className="spice-editor-actions">
          <button
            onClick={() => {
              setEditableCircuitJson(result?.circuit ? JSON.stringify(result.circuit, null, 2) : '');
              setChatField('circuitJsonSyncError', '');
            }}
            disabled={!result || isGenerating}
          >
            Reset
          </button>
          <button
            onClick={() => downloadText('circuit.json', circuitJson, 'application/json')}
            disabled={!circuitJson || isGenerating}
          >
            Download
          </button>
        </div>
      </div>
      <textarea
        className={`code-editor editor-window-code ${isGenerating ? 'live-code-editor' : ''}`}
        value={circuitJson}
        readOnly={isGenerating || !result}
        onChange={(event) => {
          setEditableCircuitJson(event.target.value);
          setSimulationRun(null);
          setSimulationError('');
        }}
        spellCheck="false"
        rows={24}
        aria-label="Editable circuit JSON"
        placeholder="Generate a circuit to inspect and edit the JSON."
      />
      {circuitJsonSyncError && <p className="inline-error simulation-message">JSON sync paused: {circuitJsonSyncError}</p>}
    </div>
  );

  const renderEditorWindow = (view) => (
    <article
      className={`editor-window ${activeEditorView === view ? 'active' : ''}`}
      key={view}
      onMouseDown={() => setActiveEditorView(view)}
    >
      <header className="editor-window-titlebar">
        <strong>{EDITOR_VIEW_LABELS[view]}</strong>
        <button
          className="editor-window-close"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => closeEditorView(view)}
          type="button"
          aria-label={`Close ${EDITOR_VIEW_LABELS[view]}`}
          title={`Close ${EDITOR_VIEW_LABELS[view]}`}
        >
          &times;
        </button>
      </header>
      {view === 'spice' && renderSpiceView()}
      {view === 'json' && renderJsonView()}
      {view === 'canvas' && renderCanvasView()}
    </article>
  );

  const adjustEditorSplit = (axis, amount) => {
    const minimum = axis === 'columns' ? 25 : 32;
    const maximum = axis === 'columns' ? 75 : 72;
    setEditorSplit((current) => ({
      ...current,
      [axis]: Math.min(maximum, Math.max(minimum, current[axis] + amount)),
    }));
  };

  const renderResizeHandle = (axis) => (
    <div
      className={`editor-resize-handle ${axis}`}
      role="separator"
      aria-label={`Resize editor windows ${axis === 'columns' ? 'horizontally' : 'vertically'}`}
      aria-orientation={axis === 'columns' ? 'vertical' : 'horizontal'}
      aria-valuemin={axis === 'columns' ? 25 : 32}
      aria-valuemax={axis === 'columns' ? 75 : 72}
      aria-valuenow={Math.round(editorSplit[axis])}
      tabIndex={0}
      onPointerDown={(event) => startEditorResize(axis, event)}
      onPointerMove={moveEditorResize}
      onPointerUp={stopEditorResize}
      onPointerCancel={stopEditorResize}
      onKeyDown={(event) => {
        const decrease = axis === 'columns' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp';
        const increase = axis === 'columns' ? event.key === 'ArrowRight' : event.key === 'ArrowDown';
        if (!decrease && !increase) return;
        event.preventDefault();
        adjustEditorSplit(axis, decrease ? -5 : 5);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );

  const renderEditorLayout = () => {
    if (openEditorViews.length === 1) {
      return <section className="editor-window-layout single">{renderEditorWindow(openEditorViews[0])}</section>;
    }

    if (openEditorViews.length === 2) {
      return (
        <section
          className={`editor-window-layout split-two ${resizingAxis ? `resizing-${resizingAxis}` : ''}`}
          style={{ '--column-split': `${editorSplit.columns}%` }}
        >
          {renderEditorWindow(openEditorViews[0])}
          {renderResizeHandle('columns')}
          {renderEditorWindow(openEditorViews[1])}
        </section>
      );
    }

    return (
      <section
        className={`editor-window-layout split-three ${resizingAxis ? `resizing-${resizingAxis}` : ''}`}
        style={{ '--column-split': `${editorSplit.columns}%`, '--row-split': `${editorSplit.rows}%` }}
      >
        <div className="editor-split-row">
          {renderEditorWindow(openEditorViews[0])}
          {renderResizeHandle('columns')}
          {renderEditorWindow(openEditorViews[1])}
        </div>
        {renderResizeHandle('rows')}
        {renderEditorWindow(openEditorViews[2])}
      </section>
    );
  };

  if (loading) return <div className="loading-screen">Loading...</div>;

  const visiblePage = user && AUTH_PAGES.has(page) ? 'workspace' : page;

  if (!user && !PUBLIC_PAGES.has(visiblePage)) return <LoginPage />;
  if (visiblePage === 'home') return <HomePage />;
  if (visiblePage === 'login') return <LoginPage />;
  if (visiblePage === 'signup') return <SignupPage />;
  if (visiblePage === 'verify') return <VerifyPage />;

  if (visiblePage === 'waveform') {
    return (
      <main className="app-shell waveform-page-shell">
        <section className="waveform-page">
          <header className="waveform-page-header">
            <div>
              <p className="eyebrow">Ngspice waveform</p>
              <h1>{result?.circuit?.title || 'Simulation waveform'}</h1>
            </div>
            <button onClick={showWorkspace}>Back to generator</button>
          </header>

          {!simulationRun?.waveform?.series?.length ? (
            <section className="panel-block empty-waveform-page">
              <h2>No waveform data yet</h2>
              <p>Run a successful simulation from the play button in the Spice tab to open the waveform here.</p>
            </section>
          ) : (
            <section className="panel-block waveform-page-panel">
              <div className="waveform-page-summary">
                <div>
                  <h2>{result?.simulation?.engine || 'Simulation complete'}</h2>
                  <p>{simulationRun.waveform.series.length} plotted signal{simulationRun.waveform.series.length === 1 ? '' : 's'} from the current SPICE deck.</p>
                </div>
                <button onClick={() => downloadText('ngspice-log.txt', simulationRun.rawOutput || '')} disabled={!simulationRun.rawOutput}>
                  Download log
                </button>
              </div>
              <WaveformChart waveform={simulationRun.waveform} />
              {simulationRun.rawOutput && (
                <details className="sim-log">
                  <summary>Ngspice log</summary>
                  <pre>{simulationRun.rawOutput}</pre>
                </details>
              )}
            </section>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="user-bar app-user-bar">
        <span>{user.email}</span>
        <button type="button" onClick={logout}>Log out</button>
      </div>
      <section className="workspace">
        <aside className={`side-panel chat-panel-${chatPanelView}`}>
          {chatPanelView === 'history' ? (
            <>
              <header className="chat-sidebar-header chat-history-header">
                <div>
                  <p className="eyebrow">Prompt-to-PCB MVP</p>
                  <h1>Previous chats</h1>
                </div>
                <button className="new-chat-button" onClick={startNewChat} type="button">
                  + New chat
                </button>
              </header>

              <section className="chat-history chat-history-page" aria-label="Previous chats">
                <div className="chat-section-label">
                  <span>All conversations</span>
                  <span>{chatStore.chats.length}</span>
                </div>
                <div className="chat-history-list">
                  {sortedChats.map((chat) => (
                    <button
                      className={`chat-history-item ${chat.id === activeChat?.id ? 'active' : ''}`}
                      key={chat.id}
                      onClick={() => openChat(chat.id)}
                      type="button"
                    >
                      <span className="chat-history-copy">
                        <strong>{chat.title}</strong>
                        <small>{chat.messages.at(-1)?.content || 'Start a new circuit conversation'}</small>
                      </span>
                      <time>{formatChatTime(chat.updatedAt)}</time>
                    </button>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <>
              <header className="chat-conversation-header">
                <button
                  className="chat-back-button"
                  onClick={() => setChatPanelView('history')}
                  type="button"
                  aria-label="Open previous chats"
                  title="Previous chats"
                >
                  <span aria-hidden="true">&larr;</span>
                </button>
                <div className="chat-conversation-title">
                  <p className="eyebrow">AI circuit assistant</p>
                  <h1>{activeChat?.title}</h1>
                </div>
                <button onClick={exportAll} disabled={!result} type="button">Export</button>
              </header>

              <section className="chat-thread" aria-label="Current conversation">

                <div className="chat-messages" aria-live="polite">
                  {activeChat?.messages.length === 0 && (
                    <div className="chat-welcome">
                      <strong>What would you like to build?</strong>
                      <p>Describe a circuit, then continue refining it with follow-up messages.</p>
                    </div>
                  )}
                  {activeChat?.messages.map((message) => (
                    <article className={`chat-message ${message.role}`} key={message.id}>
                      <div className="chat-message-meta">
                        <strong>{message.role === 'user' ? 'You' : 'AI'}</strong>
                        <time>{formatChatTime(message.createdAt)}</time>
                      </div>
                      <p>{message.content}</p>
                      {message.circuit && (
                        <div className="chat-artifact-chip">
                          <span>{message.circuit.type.replaceAll('_', ' ')}</span>
                          <strong>{message.circuit.title}</strong>
                        </div>
                      )}
                    </article>
                  ))}
                  {isGenerating && (
                    <article className="chat-message assistant pending">
                      <div className="chat-message-meta"><strong>AI</strong></div>
                      <p>Designing the circuit package...</p>
                    </article>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); generate(); }}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    rows={3}
                    placeholder="Message the circuit assistant..."
                    aria-label="Message the circuit assistant"
                  />
                  <div className="chat-composer-footer">
                    <small>Enter to send, Shift+Enter for a new line</small>
                    <button className="primary" type="submit" disabled={generationBusy || !prompt.trim()}>
                      {isGenerating ? 'Sending...' : generationBusy ? 'AI busy...' : 'Send'}
                    </button>
                  </div>
                </form>
                {error && <p className="inline-error chat-error">{error}</p>}
              </section>
            </>
          )}
        </aside>

        <section className="main-panel editor-workbench">
          <header className="result-header workbench-header">
            <div>
              <h2>{isGenerating ? 'Writing SPICE deck' : result?.circuit.title || 'Open an editor window'}</h2>
            </div>
            <div className="result-actions">
              {isGenerating && <div className="status streaming-status">Generating...</div>}
              {!isGenerating && result && (
                <div className={`status ${result.validation.ok ? 'ok' : 'error'}`}>
                  {result.validation.ok ? 'Validated' : 'Needs attention'}
                </div>
              )}
            </div>
          </header>

          <nav className="editor-launchbar" aria-label="Editor windows">
            <span>Open views</span>
            {Object.entries(EDITOR_VIEW_LABELS).map(([view, label]) => {
              const isOpen = openEditorViews.includes(view);
              return (
                <button
                  className={`${isOpen ? 'open' : ''} ${activeEditorView === view ? 'active' : ''}`}
                  key={view}
                  onClick={() => openEditorView(view)}
                  type="button"
                >
                  {isOpen ? label : `+ ${label}`}
                </button>
              );
            })}
          </nav>

          {openEditorViews.length === 0 ? (
            <section className="workbench-empty">
              <h3>All editor windows are closed</h3>
              <p>Open Spice or Canvas from the bar above.</p>
            </section>
          ) : (
            renderEditorLayout()
          )}
        </section>
      </section>
    </main>
  );
}

export default function WrappedApp() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
