// Render smoke test for the realistic-schematic SVG part bodies: server-side
// renders the full parts layer for representative circuits so a runtime error
// in any renderer (bad props, missing meta, null holes) fails fast without a
// browser.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { circuitToBreadboard } from './breadboardModel.js';
import { BatteryPack, JumperWire, PartDefs, PinLabels, RealisticPart } from './parts.jsx';

const renderModel = (circuit) => {
  const model = circuitToBreadboard(circuit);
  const markup = renderToStaticMarkup(
    <svg>
      <PartDefs />
      {model.parts.map((part) => (
        <g key={part.ref}>
          <RealisticPart part={part} />
          <PinLabels part={part} />
        </g>
      ))}
      {model.batteries.map((battery, index) => (
        <BatteryPack key={battery.ref} battery={battery} index={index} />
      ))}
      {model.jumpers.map((jumper) => (
        <JumperWire key={jumper.id} jumper={jumper} />
      ))}
    </svg>,
  );
  return { model, markup };
};

describe('realistic part rendering', () => {
  it('renders an off-board Arduino Uno with header labels and pin wires', () => {
    const { markup } = renderModel({
      title: 'Uno blink',
      components: [
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['VCC5', 'NC_U1_2', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'LED', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
        { ref: 'RLED', kind: 'resistor', value: '330', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '330', nodes: ['VCC5', '0'] },
      ],
    });
    expect(markup).toContain('ARDUINO');
    expect(markup).toContain('D13');
    expect(markup).toContain('rsPartUno');
    expect(markup).toContain('ATMEGA328P');
    expect(markup).toContain('rsGoldPad');
  });

  it('renders an off-board Raspberry Pi', () => {
    const { markup } = renderModel({
      title: 'Pi LED',
      components: [
        {
          ref: 'U1',
          kind: 'raspberry_pi',
          value: 'Pi 5',
          nodes: ['NC_U1_1', 'VCC3', '0', 'NC_U1_4', 'NC_U1_5', 'NC_U1_6', 'LED', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10'],
        },
        { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VCC3', '0'] },
      ],
    });
    expect(markup).toContain('Raspberry Pi');
    expect(markup).toContain('GPIO17');
    expect(markup).toContain('rsPartPi');
    expect(markup).toContain('BCM2711');
  });

  it('renders an ESP32 module straddling the trench', () => {
    const { markup } = renderModel({
      title: 'ESP32 LED',
      components: [
        {
          ref: 'U1',
          kind: 'esp32',
          value: 'DevKit V1',
          nodes: ['VCC3', '0', 'NC_U1_3', 'NC_U1_4', 'LED', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
        { ref: 'RLED', kind: 'resistor', value: '220', nodes: ['LED', 'LEDK'] },
        { ref: 'DLED1', kind: 'led', value: 'blue', nodes: ['LEDK', '0'] },
        { ref: 'R2', kind: 'resistor', value: '10k', nodes: ['VCC3', '0'] },
      ],
    });
    expect(markup).toContain('ESP32');
    expect(markup).toContain('U1');
  });

  it('still renders every classic part body alongside an MCU', () => {
    const { markup } = renderModel({
      title: 'Kitchen sink',
      components: [
        { ref: 'V1', kind: 'voltage_source', value: '9V', nodes: ['VCC', '0'] },
        { ref: 'R1', kind: 'resistor', value: '1k', nodes: ['VCC', 'A'] },
        { ref: 'C1', kind: 'capacitor', value: '10uF', nodes: ['A', '0'] },
        { ref: 'L1', kind: 'inductor', value: '10uH', nodes: ['A', 'B'] },
        { ref: 'DLED1', kind: 'led', value: 'red', nodes: ['B', '0'] },
        { ref: 'Q1', kind: 'bjt_npn', value: '2N2222', nodes: ['B', 'A', '0'] },
        { ref: 'XU1', kind: 'opamp', value: 'LM358', nodes: ['A', 'B', 'B', 'VCC', '0'] },
        {
          ref: 'U1',
          kind: 'arduino_uno',
          value: 'Uno R3',
          nodes: ['NC_U1_1', 'NC_U1_2', '0', 'NC_U1_4', 'A', 'NC_U1_6', 'NC_U1_7', 'NC_U1_8', 'NC_U1_9', 'NC_U1_10', 'NC_U1_11', 'NC_U1_12'],
        },
      ],
    });
    ['R1', 'C1', 'L1', 'DLED1', 'Q1', 'XU1', 'ARDUINO'].forEach((label) => {
      expect(markup).toContain(label);
    });
  });
});
