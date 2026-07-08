import { useEffect, useState } from 'react';
import { downloadText } from '../../core/download.js';

const formatAxisValue = (value) => {
  if (!Number.isFinite(value)) return '0';
  if (value === 0) return '0';
  if (Math.abs(value) >= 1_000 || Math.abs(value) < 0.01) return value.toExponential(2);
  return Number(value.toFixed(3)).toString();
};

export function WaveformChart({ waveform }) {
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
  // Flat, bold trace colors that hold up on the light paper background.
  const colors = ['#2fb344', '#3b7bff', '#f08c00', '#9d71ff'];
  const scaleX = (x) => margin.left + ((x - xMin) / Math.max(xMax - xMin, Number.EPSILON)) * plotWidth;
  const scaleY = (y) => margin.top + plotHeight - ((y - yMin) / Math.max(yMax - yMin, Number.EPSILON)) * plotHeight;
  const xTicks = [...new Set([xMin, xMin + (xMax - xMin) / 2, xMax])];
  const yTicks = [...new Set([yMinRaw, yMinRaw + (yMaxRaw - yMinRaw) / 2, yMaxRaw])];
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
