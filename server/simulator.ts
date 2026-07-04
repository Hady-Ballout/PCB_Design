import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { addMissingSpiceModels } from '../src/core/pcbGenerator.js';
import type { Circuit, SimulationResult, WaveformSeries } from './types.js';

const DEFAULT_TRAN = '.tran 10us 20ms';
const getNgspiceCommand = (): string => process.env.NGSPICE_BINARY || (process.platform === 'win32' ? 'ngspice_con' : 'ngspice');
const getTranCommand = (spice: string): string => {
  const match = String(spice || '').match(/^\s*\.tran\s+(.+)$/im);
  return match ? `tran ${match[1].trim()}` : DEFAULT_TRAN.replace(/^\./, '');
};

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runProcess = (command: string, args: string[], options: Record<string, unknown> = {}): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code: number | null) => {
      resolve({ code, stdout, stderr });
    });
  });

export const chooseWaveformNodes = (circuit: Circuit | null | undefined): string[] => {
  const nodes = [...new Set((circuit?.components ?? []).flatMap((part) => part.nodes ?? []))]
    .map(String)
    .filter((node) => node && node !== '0');

  const preferred = nodes.filter((node) => /(^|_)(v?out|out|load|fb|ctrl|vin)(_|$)/i.test(node));
  return [...new Set([...preferred, ...nodes])].slice(0, 4);
};

export const buildSimulationDeck = (spice: string, nodes: string[], circuit: Circuit | null = null): string => {
  const withRequiredModels = addMissingSpiceModels(spice, circuit);
  const withoutEnd = withRequiredModels
    .replace(/\.control[\s\S]*?\.endc/gi, '')
    .replace(/^\s*\.end\s*$/gim, '')
    .trim();
  const plotVectors = nodes.map((node) => `v(${node})`).join(' ');
  const tranCommand = getTranCommand(withoutEnd);

  return [
    withoutEnd,
    '.control',
    'set wr_singlescale',
    'set wr_vecnames',
    tranCommand,
    `wrdata waveform.dat ${plotVectors}`,
    'quit',
    '.endc',
    '.end',
  ]
    .filter(Boolean)
    .join('\n');
};

export const parseWaveformData = (raw: string, requestedNodes: string[] = []): WaveformSeries[] => {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const first = lines[0].split(/\s+/);
  const hasHeader = first.some((token) => Number.isNaN(Number(token)));
  const header = hasHeader ? first : [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const numericRows = dataLines
    .map((line) => line.split(/\s+/).map(Number))
    .filter((row) => row.length > 1 && row.every((value) => Number.isFinite(value)));

  if (numericRows.length === 0) return [];

  const valueColumnCount = numericRows[0].length - 1;
  const seriesNames = requestedNodes.length
    ? requestedNodes
    : header.slice(1).map((name) => name.replace(/^v\((.*)\)$/i, '$1'));
  const usableSeriesCount = Math.min(valueColumnCount, Math.max(1, seriesNames.length));

  return Array.from({ length: usableSeriesCount }, (_, index) => ({
    name: seriesNames[index] || `Signal ${index + 1}`,
    points: numericRows.map((row) => ({ x: row[0], y: row[index + 1] })),
  }));
};

export async function runNgspiceSimulation({ circuit, spice }: { circuit: Circuit; spice: string }): Promise<SimulationResult> {
  const nodes = chooseWaveformNodes(circuit);
  if (nodes.length === 0) {
    return {
      ok: false,
      errors: ['No non-ground nodes are available to plot.'],
      warnings: [],
      rawOutput: '',
      waveform: { xLabel: 'Time (s)', yLabel: 'Voltage (V)', series: [] },
    };
  }

  const workingDir = await mkdtemp(join(tmpdir(), 'prompt-to-pcb-'));
  const deckPath = join(workingDir, 'simulation.cir');
  const waveformPath = join(workingDir, 'waveform.dat');
  let rawOutput = '';

  try {
    await writeFile(deckPath, buildSimulationDeck(spice, nodes, circuit), 'utf8');
    const command = getNgspiceCommand();
    const result = await runProcess(command, ['-b', deckPath], { cwd: workingDir });
    rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');

    if (result.code !== 0) {
      const missing = /ENOENT|not found|not recognized/i.test(rawOutput);
      return {
        ok: false,
        errors: [missing ? `Ngspice was not found. Install Ngspice and make sure ${command} is available on PATH.` : 'Ngspice failed to simulate this circuit.'],
        warnings: [],
        rawOutput,
        waveform: { xLabel: 'Time (s)', yLabel: 'Voltage (V)', series: [] },
      };
    }

    let waveformRaw = '';
    try {
      waveformRaw = await readFile(waveformPath, 'utf8');
    } catch {
      return {
        ok: false,
        errors: ['Ngspice completed, but did not create waveform.dat. Check the Ngspice log for the circuit or vector error.'],
        warnings: [],
        rawOutput,
        waveform: { xLabel: 'Time (s)', yLabel: 'Voltage (V)', series: [] },
      };
    }

    const series = parseWaveformData(waveformRaw, nodes);
    return {
      ok: series.length > 0,
      errors: series.length > 0 ? [] : ['Ngspice completed, but no waveform data was produced.'],
      warnings: [],
      rawOutput,
      waveform: {
        xLabel: 'Time (s)',
        yLabel: 'Voltage (V)',
        series,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [(error as Error).message],
      warnings: [],
      rawOutput,
      waveform: { xLabel: 'Time (s)', yLabel: 'Voltage (V)', series: [] },
    };
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}
