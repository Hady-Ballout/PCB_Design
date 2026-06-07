import React, { useEffect, useMemo, useState } from 'react';

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

function App() {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState(null);
  const [editableSpice, setEditableSpice] = useState('');
  const [editableKicadNetlist, setEditableKicadNetlist] = useState('');
  const [simulationRun, setSimulationRun] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [error, setError] = useState('');
  const [simulationError, setSimulationError] = useState('');

  const manifest = useMemo(
    () =>
      JSON.stringify(
        {
          name: result?.circuit.title,
          sourcePrompt: result?.intent.rawPrompt,
          generatedAt: new Date().toISOString(),
          files: ['generated.cir', 'generated.net', 'circuit.json'],
          kicad: 'Import generated.net into KiCad schematic/PCB tools, then assign or adjust footprints before routing.',
          ngspice: result?.simulation.command,
        },
        null,
        2,
      ),
    [result],
  );

  const generate = async () => {
    setIsGenerating(true);
    setError('');

    try {
      if (!prompt.trim()) throw new Error('Enter a circuit prompt before generating.');

      const response = await fetch('/api/generate-circuit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const response = await fetch('/api/simulate-circuit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circuit: result.circuit, spice: editableSpice }),
      });
      const data = await response.json();
      setSimulationRun(data);
      if (!response.ok || !data.ok) {
        throw new Error(data.errors?.join(' ') || data.error || `Simulation failed with HTTP ${response.status}.`);
      }
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
    downloadText('circuit.json', JSON.stringify(result.circuit, null, 2), 'application/json');
    downloadText('README-export.json', manifest, 'application/json');
  };

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
                <div className={`status ${result.validation.ok ? 'ok' : 'error'}`}>
                  {result.validation.ok ? 'Validated' : 'Needs attention'}
                </div>
              </header>

              <div className="source-strip">
                <span>Generator: Ollama AI</span>
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
                  {simulationRun?.ok && <p className="simulation-ok">Simulation completed successfully.</p>}
                  <div className="metrics">
                    {result.simulation.metrics.map((metric) => (
                      <article key={metric.label}>
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </article>
                    ))}
                  </div>
                  {simulationRun?.waveform?.series?.length > 0 && <WaveformChart waveform={simulationRun.waveform} />}
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

export default App;
