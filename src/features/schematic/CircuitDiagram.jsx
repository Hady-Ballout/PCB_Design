import { useEffect, useRef, useState } from 'react';
import { rerouteAffectedNets } from '../../core/schematicLayout.js';
import { BridgeSymbol, DiagramSymbol, GroundSymbol, PortSymbol } from './symbols.jsx';
import {
  diagramPath,
  isUnconnectedTerminal,
  moveWireEndpoint,
  moveWirePath,
  movedComponent,
  movedNet,
  svgPointer,
  terminalPoint,
  wireId,
  wirePoints,
} from './geometry.js';

export function CircuitDiagram({ diagram, onChange, tool, selected, onSelect, pendingTerminal, onPendingTerminal }) {
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
    if (drag.type === 'component' || drag.type === 'netLabel') {
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
          // BJTs already carry C/B/E letters; numbering those pins too just
          // stacks glyphs. Numbers stay on op amps and generic multi-pin parts.
          const showsPinNumbers = component.pinCount > 2
            && component.symbolType !== 'bjt_npn'
            && component.symbolType !== 'bjt_pnp';
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
                {!isGroundComponent && showsPinNumbers && (
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
