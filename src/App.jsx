import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toDiagramSvg } from './lib/pcbGenerator.js';
import { AuthProvider, useAuth, HomePage, LoginPage, SignupPage, VerifyPage } from './auth.jsx';
import './auth.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

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
  const colors = ['#23533a', '#275f85', '#9a5b20', '#7b3f7a'];
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
const symbolDefaults = {
  resistor: { kind: 'resistor', symbolType: 'resistor', width: 130, height: 58, orientation: 'horizontal', value: '1k', prefix: 'R', nodes: 2 },
  capacitor: { kind: 'capacitor', symbolType: 'capacitor', width: 98, height: 112, orientation: 'vertical', value: '100nF', prefix: 'C', nodes: 2 },
  led: { kind: 'led', symbolType: 'led', width: 98, height: 112, orientation: 'vertical', value: 'red', prefix: 'DLED', nodes: 2 },
  source: { kind: 'voltage_source', symbolType: 'voltage_source', width: 98, height: 112, orientation: 'vertical', value: '5V', prefix: 'V', nodes: 2 },
  bjt: { kind: 'bjt_npn', symbolType: 'bjt_npn', width: 118, height: 100, orientation: 'horizontal', value: '2N2222', prefix: 'Q', nodes: 3 },
  opamp: { kind: 'opamp', symbolType: 'opamp', width: 150, height: 110, orientation: 'horizontal', value: 'LM358', prefix: 'XU', nodes: 5 },
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
  connections: net.connections.map((connection) => ({ ...connection, x: connection.x + dx, y: connection.y + dy })),
});

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
  const sameKindCount = diagram.components.filter((component) => component.kind === defaults.kind).length + 1;
  const column = diagram.components.length % 3;
  const row = Math.floor(diagram.components.length / 3);
  const nodes = Array.from({ length: defaults.nodes }, (_, index) => `${defaults.prefix}${sameKindCount}_${index + 1}`);
  const component = {
    ref: `${defaults.prefix}${sameKindCount}`,
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
  if (wire.manual) {
    const from = terminalPoint(diagram, wire.from);
    const to = terminalPoint(diagram, wire.to);
    if (wire.offset) {
      return [
        from,
        { x: (from.x + to.x) / 2 + wire.offset.x, y: (from.y + to.y) / 2 + wire.offset.y },
        to,
      ];
    }
    return [from, to];
  }

  const component = diagram.components.find((item) => item.ref === wire.ref);
  const pin = component?.pins.find((item) => item.pinIndex === wire.pin);
  const net = diagram.nets.find((item) => item.name === wire.node);
  if (!pin || !net) return wire.points;
  const offset = wire.offset || { x: 0, y: 0 };
  return [
    { x: pin.x, y: pin.y },
    { x: pin.x + offset.x, y: net.y + offset.y },
    { x: net.x, y: net.y },
  ];
};

function DiagramSymbol({ component }) {
  const { x, y, width, height, symbolType, orientation } = component;
  const left = x - width / 2;
  const right = x + width / 2;
  const top = y - height / 2;
  const bottom = y + height / 2;

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
    setDrag({ type: 'component', ref: component.ref, start: svgPointer(event, diagram), original: component });
  };

  const beginNetDrag = (event, net) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect({ type: 'net', name: net.name });
    if (tool === 'wire') return;
    capturePointer(event);
    setDrag({ type: 'net', name: net.name, start: svgPointer(event, diagram), original: net });
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
        return {
          ...current,
          components: current.components.map((component) =>
            component.ref === activeDrag.ref ? movedComponent(activeDrag.original, dx, dy) : component,
          ),
        };
      }

      return {
        ...current,
        ...(activeDrag.type === 'net'
          ? { nets: current.nets.map((net) => (net.name === activeDrag.name ? movedNet(activeDrag.original, dx, dy) : net)) }
          : {
              wires: current.wires.map((wire) =>
                wireId(wire) === activeDrag.id
                  ? {
                      ...wire,
                      offset: {
                        x: (activeDrag.original.offset?.x || 0) + dx,
                        y: (activeDrag.original.offset?.y || 0) + dy,
                      },
                    }
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
        onPointerLeave={endDrag}
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
        {diagram.wires.map((wire) => (
          <polyline
            key={wireId(wire)}
            className={selected?.type === 'wire' && selected.id === wireId(wire) ? 'diagram-wire selected' : 'diagram-wire'}
            points={diagramPath(wirePoints(diagram, wire))}
            onPointerDown={(event) => beginWireDrag(event, wire)}
          />
        ))}
        {pendingWireStart && wirePointer && (
          <polyline
            className="diagram-wire pending"
            points={diagramPath([pendingWireStart, wirePointer])}
            pointerEvents="none"
          />
        )}
        {diagram.nets.map((net) => (
          <g
            key={net.name}
            className={selected?.type === 'net' && selected.name === net.name ? 'editable-net selected' : 'editable-net'}
            onPointerDown={(event) => beginNetDrag(event, net)}
          >
            <circle className="diagram-node" cx={net.x} cy={net.y} r="4" />
            <rect className="diagram-net" x={net.labelX} y={net.labelY} width={net.labelWidth} height="26" rx="13" />
            <text className="diagram-small" x={net.labelX + net.labelWidth / 2} y={net.labelY + 17} textAnchor="middle">{net.name}</text>
          </g>
        ))}
        {diagram.components.map((component) => (
          <g
            key={component.ref}
            className={selected?.type === 'component' && selected.ref === component.ref ? 'editable-component selected' : 'editable-component'}
            onPointerDown={(event) => beginComponentDrag(event, component)}
          >
            <DiagramSymbol component={component} />
            <text className="diagram-text" x={component.x} y={component.y - component.height / 2 - 12} textAnchor="middle">
              {component.ref}
            </text>
            <text className="diagram-small" x={component.x} y={component.y + component.height / 2 + 20} textAnchor="middle">
              {component.value}
            </text>
            {component.pins.map((pin) => (
              <g key={`${component.ref}-${pin.pinIndex}`} className="diagram-terminal" onPointerDown={(event) => handleTerminalPointerDown(event, component, pin)}>
                <circle className="terminal-hit" cx={pin.x} cy={pin.y} r="14" />
                <circle
                  className={pendingTerminal?.ref === component.ref && pendingTerminal?.pin === pin.pinIndex ? 'terminal-dot selected' : 'terminal-dot'}
                  cx={pin.x}
                  cy={pin.y}
                  r="6"
                />
                <text className="diagram-small" x={pin.x} y={pin.y - 8} textAnchor="middle">
                  {pin.pinIndex}
                </text>
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

function App() {
  const { user, loading, logout } = useAuth();

  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState(null);
  const [editableSpice, setEditableSpice] = useState('');
  const [editableKicadNetlist, setEditableKicadNetlist] = useState('');
  const [editedDiagram, setEditedDiagram] = useState(null);
  const [diagramTool, setDiagramTool] = useState('select');
  const [diagramSelection, setDiagramSelection] = useState(null);
  const [pendingTerminal, setPendingTerminal] = useState(null);
  const [simulationRun, setSimulationRun] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash.startsWith('#verify')) return 'verify';
    if (hash === '#login') return 'login';
    if (hash === '#signup') return 'signup';
    if (hash === '#waveform') return 'waveform';
    if (hash === '#diagram') return 'diagram';
    if (hash === '#workspace') return 'workspace';
    return 'home';
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [error, setError] = useState('');
  const [simulationError, setSimulationError] = useState('');

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('pcb_token')}`,
  });

  useEffect(() => {
    const syncPageFromHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#verify')) { setPage('verify'); return; }
      if (hash === '#login') { setPage('login'); return; }
      if (hash === '#signup') { setPage('signup'); return; }
      if (hash === '#waveform') { setPage('waveform'); return; }
      if (hash === '#diagram') { setPage('diagram'); return; }
      if (hash === '#workspace') { setPage('workspace'); return; }
      setPage('home');
    };

    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  useEffect(() => {
    setEditedDiagram(cloneDiagram(result?.diagram));
    setDiagramSelection(null);
    setPendingTerminal(null);
    setDiagramTool('select');
  }, [result?.diagram]);

  useEffect(() => {
    if (activeTab === 'diagram') setActiveTab('summary');
  }, [activeTab]);

  const manifest = useMemo(
    () =>
      JSON.stringify(
        {
          name: result?.circuit.title,
          sourcePrompt: result?.intent.rawPrompt,
          generatedAt: new Date().toISOString(),
          files: ['generated.cir', 'generated.net', 'generated.svg', 'circuit.json'],
          kicad: 'Import generated.net into KiCad schematic/PCB tools, then assign or adjust footprints before routing.',
          ngspice: result?.simulation.command,
        },
        null,
        2,
      ),
    [result],
  );

  // ── Loading ──
  if (loading) return <div className="loading-screen">Loading...</div>;

  // ── Public pages ──
  if (page === 'home') return <HomePage />;
  if (page === 'login') return <LoginPage />;
  if (page === 'signup') return <SignupPage />;
  if (page === 'verify') return <VerifyPage />;

  // ── Auth guard ──
  if (!user) {
    window.location.hash = 'login';
    return null;
  }

  const generate = async () => {
    setIsGenerating(true);
    setError('');

    try {
      if (!prompt.trim()) throw new Error('Enter a circuit prompt before generating.');

      const response = await fetch(`${API_BASE}/api/generate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Generation failed with HTTP ${response.status}.`);
      if (data.error) throw new Error(data.error);
      setResult(data);
      setEditableSpice(data.spice || '');
      setEditableKicadNetlist(data.kicadNetlist || '');
      setSimulationRun(null);
      setSimulationError('');
      window.location.hash = 'workspace';
      setPage('workspace');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActiveTab('summary');
      setIsGenerating(false);
    }
  };

  const runSimulation = async () => {
    if (!result) return;
    setIsSimulating(true);
    setSimulationError('');

    try {
      const response = await fetch(`${API_BASE}/api/simulate-circuit`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ circuit: result.circuit, spice: editableSpice }),
      });
      const data = await response.json();
      setSimulationRun(data);
      if (!response.ok || !data.ok) {
        throw new Error(data.errors?.join(' ') || data.error || `Simulation failed with HTTP ${response.status}.`);
      }
      window.location.hash = 'waveform';
      setPage('waveform');
    } catch (requestError) {
      setSimulationError(requestError.message);
    } finally {
      setIsSimulating(false);
    }
  };

  const exportAll = () => {
    if (!result) return;
    downloadText('generated.cir', editableSpice);
    downloadText('generated.net', editableKicadNetlist, 'application/xml');
    downloadText('generated.svg', toDiagramSvg(editedDiagram || result.diagram), 'image/svg+xml');
    downloadText('circuit.json', JSON.stringify(result.circuit, null, 2), 'application/json');
    downloadText('README-export.json', manifest, 'application/json');
  };

  const addDiagramComponent = (type) => {
    setEditedDiagram((current) => {
      const base = current || result?.diagram;
      if (!base) return current;
      const next = cloneDiagram(base);
      const component = addedComponent(next, type);
      next.components.push(component);
      setDiagramSelection({ type: 'component', ref: component.ref });
      setPendingTerminal(null);
      setDiagramTool('select');
      return next;
    });
  };

  const deleteDiagramSelection = () => {
    if (!diagramSelection) return;
    setEditedDiagram((current) => {
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
      if (diagramSelection.type === 'net') {
        next.nets = next.nets.filter((net) => net.name !== diagramSelection.name);
        next.wires = next.wires.filter((wire) => wire.node !== diagramSelection.name);
      }
      return next;
    });
    setDiagramSelection(null);
    setPendingTerminal(null);
  };

  const showWorkspace = () => {
    window.location.hash = 'workspace';
    setPage('workspace');
  };

  const showDiagramPage = () => {
    if (!result) return;
    window.location.hash = 'diagram';
    setPage('diagram');
  };

  if (page === 'waveform') {
    return (
      <main className="app-shell waveform-page-shell">
        <section className="waveform-page">
          <header className="waveform-page-header">
            <div>
              <p className="eyebrow">Ngspice waveform</p>
              <h1>{result?.circuit?.title || 'Simulation waveform'}</h1>
            </div>
            <div className="user-bar">
              <span>{user.email}</span>
              <button onClick={logout}>Log out</button>
            </div>
            <button onClick={showWorkspace}>Back to generator</button>
          </header>

          {!simulationRun?.waveform?.series?.length ? (
            <section className="panel-block empty-waveform-page">
              <h2>No waveform data yet</h2>
              <p>Run a successful simulation from the Simulation tab to open the waveform here.</p>
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

  if (page === 'diagram') {
    return (
      <main className="app-shell diagram-page-shell">
        <section className="diagram-workspace-page">
          <header className="diagram-page-header">
            <div>
              <p className="eyebrow">Schematic canvas</p>
              <h1>{result?.circuit?.title || 'No circuit generated yet'}</h1>
            </div>
            <div className="button-row">
              <div className="user-bar">
                <span>{user.email}</span>
                <button onClick={logout}>Log out</button>
              </div>
              <button onClick={showWorkspace}>Back to generator</button>
              <button onClick={() => setEditedDiagram(cloneDiagram(result?.diagram))} disabled={!result}>Reset layout</button>
              <button onClick={() => downloadText('generated.svg', toDiagramSvg(editedDiagram || result.diagram), 'image/svg+xml')} disabled={!result}>
                Download SVG
              </button>
            </div>
          </header>

          {!result ? (
            <section className="panel-block empty-state">
              <p className="eyebrow">Awaiting AI generation</p>
              <h2>No circuit generated yet</h2>
              <p>Generate a circuit first, then open the canvas.</p>
            </section>
          ) : (
            <>
              <div className="diagram-page-toolbar">
                <div className="diagram-editbar" aria-label="Diagram tools">
                  <button className={diagramTool === 'select' ? 'active-tool' : ''} onClick={() => { setDiagramTool('select'); setPendingTerminal(null); }}>Select</button>
                  <button className={diagramTool === 'wire' ? 'active-tool' : ''} onClick={() => { setDiagramTool('wire'); setPendingTerminal(null); }}>Wire</button>
                  <button onClick={() => addDiagramComponent('resistor')}>Add resistor</button>
                  <button onClick={() => addDiagramComponent('capacitor')}>Add capacitor</button>
                  <button onClick={() => addDiagramComponent('source')}>Add source</button>
                  <button onClick={() => addDiagramComponent('led')}>Add LED</button>
                  <button onClick={() => addDiagramComponent('bjt')}>Add BJT</button>
                  <button onClick={() => addDiagramComponent('opamp')}>Add op amp</button>
                  <button onClick={deleteDiagramSelection} disabled={!diagramSelection}>Delete selected</button>
                </div>
              </div>
              <CircuitDiagram
                diagram={editedDiagram || result.diagram}
                onChange={setEditedDiagram}
                tool={diagramTool}
                selected={diagramSelection}
                onSelect={setDiagramSelection}
                pendingTerminal={pendingTerminal}
                onPendingTerminal={setPendingTerminal}
              />
            </>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="side-panel">
          <div>
            <p className="eyebrow">Prompt-to-PCB MVP</p>
            <h1>Generate a simulated schematic package</h1>
          </div>

          <label className="prompt-box">
            <span>Circuit prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={8}
              placeholder="Describe the circuit you want the AI to generate..."
            />
          </label>

          <div className="button-row">
              <button className="primary" onClick={generate} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : 'Generate'}
              </button>
              <button onClick={exportAll} disabled={!result}>Export files</button>
            </div>
            {error && <p className="inline-error">{error}</p>}

          <div className="user-bar" style={{ marginTop: 'auto' }}>
            <span>{user.email}</span>
            <button onClick={logout}>Log out</button>
          </div>
        </aside>

        <section className="main-panel">
          {!result ? (
            <section className="empty-state">
              <p className="eyebrow">Awaiting AI generation</p>
              <h2>No circuit generated yet</h2>
              <p>Enter a prompt and generate a circuit to view validation, simulation metadata, SPICE, and KiCad netlist output.</p>
            </section>
          ) : (
            <>
              <header className="result-header">
                <div>
                  <p className="eyebrow">{result.circuit.type.replaceAll('_', ' ')}</p>
                  <h2>{result.circuit.title}</h2>
                </div>
                <div className="result-actions">
                  <button onClick={showDiagramPage}>Open canvas</button>
                  <div className={`status ${result.validation.ok ? 'ok' : 'error'}`}>
                    {result.validation.ok ? 'Validated' : 'Needs attention'}
                  </div>
                </div>
              </header>

              <div className="source-strip">
                <span>Generator: AI</span>
              </div>

              <nav className="tabs" aria-label="Result views">
                {['summary', 'simulation', 'spice', 'kicad'].map((tab) => (
                  <button
                    key={tab}
                    className={activeTab === tab ? 'active' : ''}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </nav>

              {activeTab === 'summary' && (
                <div className="content-grid">
                  <section className="panel-block">
                    <h3>Components</h3>
                    <div className="component-list">
                      {result.circuit.components.map((part) => (
                        <article key={part.ref} className="component-card">
                          <strong>{part.ref}</strong>
                          <span>{part.kind}</span>
                          <code>{part.value}</code>
                          <small>{part.nodes.join(' -> ')}</small>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="panel-block">
                    <h3>Validation</h3>
                    <ul className="checks">
                      {result.validation.errors.map((item) => <li className="bad" key={item}>{item}</li>)}
                      {result.validation.warnings.map((item) => <li className="warn" key={item}>{item}</li>)}
                      {result.validation.ok && result.validation.warnings.length === 0 && <li className="good">No validation issues found.</li>}
                    </ul>
                    <h3>Notes</h3>
                    <ul className="checks">
                      {result.circuit.notes.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </section>
                </div>
              )}

              {activeTab === 'simulation' && (
                <section className="panel-block">
                  <div className="sim-header">
                    <div>
                      <h3>{result.simulation.engine}</h3>
                      <p>Run Ngspice locally to generate waveform data from the current SPICE deck.</p>
                    </div>
                    <button className="primary" onClick={runSimulation} disabled={isSimulating}>
                      {isSimulating ? 'Simulating...' : 'Run simulation'}
                    </button>
                  </div>
                  {simulationError && <p className="inline-error simulation-message">{simulationError}</p>}
                  {simulationRun?.ok && (
                    <p className="simulation-ok">
                      Simulation completed successfully. <button className="text-button" onClick={() => { window.location.hash = 'waveform'; setPage('waveform'); }}>Open waveform page</button>
                    </p>
                  )}
                  <div className="metrics">
                    {result.simulation.metrics.map((metric) => (
                      <article key={metric.label}>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </article>
                    ))}
                  </div>
                  {simulationRun?.rawOutput && (
                    <details className="sim-log">
                      <summary>Ngspice log</summary>
                      <pre>{simulationRun.rawOutput}</pre>
                    </details>
                  )}
                </section>
              )}

              {activeTab === 'spice' && (
                <section className="panel-block code-panel">
                  <div className="editor-header">
                    <div>
                      <h3>SPICE deck</h3>
                      <p>Edits here are used by downloads and by the Simulation tab.</p>
                    </div>
                    <div className="button-row">
                      <button onClick={() => setEditableSpice(result.spice)}>Reset SPICE</button>
                      <button onClick={() => downloadText('generated.cir', editableSpice)}>Download SPICE</button>
                    </div>
                  </div>
                  <textarea
                    className="code-editor"
                    value={editableSpice}
                    onChange={(event) => {
                      setEditableSpice(event.target.value);
                      setSimulationRun(null);
                      setSimulationError('');
                    }}
                    spellCheck="false"
                    rows={24}
                    aria-label="Editable SPICE deck"
                  />
                </section>
              )}

              {activeTab === 'kicad' && (
                <section className="panel-block code-panel">
                  <div className="editor-header">
                    <div>
                      <h3>KiCad netlist</h3>
                      <p>Edits here are included when you download the KiCad netlist or export all files.</p>
                    </div>
                    <div className="button-row">
                      <button onClick={() => setEditableKicadNetlist(result.kicadNetlist)}>Reset KiCad</button>
                      <button onClick={() => downloadText('generated.net', editableKicadNetlist, 'application/xml')}>Download KiCad netlist</button>
                      <button onClick={() => downloadText('README-export.json', manifest, 'application/json')}>Download manifest</button>
                    </div>
                  </div>
                  <textarea
                    className="code-editor"
                    value={editableKicadNetlist}
                    onChange={(event) => setEditableKicadNetlist(event.target.value)}
                    spellCheck="false"
                    rows={24}
                    aria-label="Editable KiCad netlist"
                  />
                </section>
              )}
            </>
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
