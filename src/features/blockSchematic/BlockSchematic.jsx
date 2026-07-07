import { useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { circuitToFlow, pinHandleId, GROUND_NODE_ID, GROUND_PIN_INDEX } from './blockSchematicModel.js';
import { BusEdge } from './BusEdge.jsx';
import { BlockSymbol } from './blockSymbols.jsx';
import './BlockSchematic.css';

function ComponentBlockNode({ data }) {
  return (
    <div className="block-node">
      <header className="block-node-header">
        <BlockSymbol kind={data.kind} label={data.title} />
        <span className="block-node-sub">
          {data.ref}
          {data.value ? ` · ${data.value}` : ''}
        </span>
      </header>
      <ul className="block-node-pins">
        {data.pins.map((pin) => (
          <li
            className={`block-node-pin ${pin.connected ? '' : 'unconnected'}`}
            key={pin.pinIndex}
          >
            <span className="block-node-pin-label">{pin.label}</span>
            <span className="block-node-pin-dot" aria-hidden="true" />
            <Handle
              type="source"
              position={Position.Right}
              id={pinHandleId(data.ref, pin.pinIndex, 's')}
              className="block-node-handle"
            />
            <Handle
              type="target"
              position={Position.Right}
              id={pinHandleId(data.ref, pin.pinIndex, 't')}
              className="block-node-handle"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroundSymbolNode() {
  return (
    <div className="ground-node">
      <svg className="ground-node-symbol" viewBox="0 0 32 26" aria-hidden="true">
        <line x1="16" y1="0" x2="16" y2="9" />
        <line x1="5" y1="9" x2="27" y2="9" />
        <line x1="9" y1="15" x2="23" y2="15" />
        <line x1="13" y1="21" x2="19" y2="21" />
      </svg>
      <span className="ground-node-label">GND</span>
      <Handle
        type="target"
        position={Position.Top}
        id={pinHandleId(GROUND_NODE_ID, GROUND_PIN_INDEX, 't')}
        className="ground-node-handle"
      />
      <Handle
        type="source"
        position={Position.Top}
        id={pinHandleId(GROUND_NODE_ID, GROUND_PIN_INDEX, 's')}
        className="ground-node-handle"
      />
    </div>
  );
}

const nodeTypes = { componentBlock: ComponentBlockNode, groundSymbol: GroundSymbolNode };
const edgeTypes = { bus: BusEdge };

export function BlockSchematic({ circuit }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    const flow = circuitToFlow(circuit);
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [circuit, setNodes, setEdges]);

  return (
    <div className={`block-schematic ${hasSelection ? 'has-selection' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={({ edges: selectedEdges }) => setHasSelection(selectedEdges.length > 0)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: false }}
        nodesConnectable={false}
        elevateEdgesOnSelect
      >
        <Background variant="dots" gap={20} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
