// Presentational SVG symbol renderers for the schematic canvas.

export function ComponentToolIcon({ type }) {
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

export function DiagramSymbol({ component }) {
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
      // Scale the zigzag to the body height so short vertical resistors don't
      // draw the scribble past their own outline.
      const lead = Math.min(18, height * 0.16);
      const zigTop = top + lead;
      const zigBottom = bottom - lead;
      const step = (zigBottom - zigTop) / 5;
      return (
        <polyline
          className="diagram-symbol"
          points={`${x},${top} ${x},${zigTop} ${x - 18},${zigTop + step} ${x + 18},${zigTop + step * 2} ${x - 18},${zigTop + step * 3} ${x + 18},${zigTop + step * 4} ${x},${zigBottom} ${x},${bottom}`}
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

  if (symbolType === 'mcu') {
    const bodyLeft = left + 22;
    const bodyRight = right - 22;
    const label = MCU_SYMBOL_LABELS[component.kind] || component.kind.replaceAll('_', ' ').toUpperCase();
    const pinNames = MCU_SYMBOL_PINS[component.kind] || [];
    return (
      <>
        <rect className="diagram-fill" x={bodyLeft} y={top} width={bodyRight - bodyLeft} height={height} rx="8" />
        {(component.pins || []).map((pin) => {
          const onLeft = pin.pinIndex % 2 === 1;
          const edgeX = onLeft ? bodyLeft : bodyRight;
          return (
            <g key={pin.pinIndex}>
              <line className="diagram-symbol" x1={pin.x} y1={pin.y} x2={edgeX} y2={pin.y} />
              <text
                className="diagram-small"
                fontSize="9"
                x={onLeft ? bodyLeft + 5 : bodyRight - 5}
                y={pin.y + 3}
                textAnchor={onLeft ? 'start' : 'end'}
              >
                {pinNames[pin.pinIndex - 1] || pin.pinIndex}
              </text>
            </g>
          );
        })}
        <text className="diagram-small" x={x} y={y + 4} textAnchor="middle">{label}</text>
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

// Positional pin names for the canvas MCU symbol. Duplicated per chunk like the
// other per-kind maps; keep in sync with MCU_PINS in the realistic view.
const MCU_SYMBOL_LABELS = {
  arduino_uno: 'ARDUINO UNO',
  raspberry_pi: 'RASPBERRY PI',
  esp32: 'ESP32',
};
const MCU_SYMBOL_PINS = {
  arduino_uno: ['5V', '3V3', 'GND', 'VIN', 'D2', 'D3', 'D5', 'D9', 'D13', 'A0', 'A1', 'A2'],
  raspberry_pi: ['5V', '3V3', 'GND', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO17', 'GPIO18', 'GPIO27', 'GPIO22'],
  esp32: ['3V3', 'GND', 'VIN', 'EN', 'GPIO2', 'GPIO4', 'GPIO5', 'GPIO13', 'GPIO18', 'GPIO19', 'GPIO21', 'GPIO22'],
};

export function GroundSymbol({ x, y }) {
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

export function PortSymbol({ port }) {
  const width = port.labelWidth || 58;
  const height = 24;
  const side = ['left', 'right', 'top', 'bottom'].includes(port.side) ? port.side : 'left';
  // Place the pill and stub on the same side the pin faces so top/bottom ports
  // aren't drawn with a horizontal stub pointing at nothing.
  let rectX;
  let rectY;
  let lineEnd;
  if (side === 'right') {
    rectX = port.x + 10;
    rectY = port.y - height / 2;
    lineEnd = { x: port.x + 10, y: port.y };
  } else if (side === 'top') {
    rectX = port.x - width / 2;
    rectY = port.y - height - 10;
    lineEnd = { x: port.x, y: port.y - 10 };
  } else if (side === 'bottom') {
    rectX = port.x - width / 2;
    rectY = port.y + 10;
    lineEnd = { x: port.x, y: port.y + 10 };
  } else {
    rectX = port.x - width - 10;
    rectY = port.y - height / 2;
    lineEnd = { x: port.x - 10, y: port.y };
  }
  return (
    <g className="diagram-port" pointerEvents="none" aria-label={`${port.label} port`}>
      <circle className="diagram-node" cx={port.x} cy={port.y} r="4" />
      <line className="diagram-symbol" x1={port.x} y1={port.y} x2={lineEnd.x} y2={lineEnd.y} />
      <rect className="diagram-net" x={rectX} y={rectY} width={width} height={height} rx="4" />
      <text className="diagram-small" x={rectX + width / 2} y={rectY + 16} textAnchor="middle">{port.label}</text>
    </g>
  );
}

export function BridgeSymbol({ bridge }) {
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
