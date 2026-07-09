export interface ComponentKindInfo {
  spicePrefix: string;
  pins: number;
  symbolType: string;
  label: string;
  fixedPins?: readonly string[];
  wiringOnly?: boolean;
  mcu?: boolean;
}

export const COMPONENT_KINDS: Record<string, ComponentKindInfo>;
export const ALLOWED_KINDS: string[];
export const SPICE_PREFIX_BY_KIND: Record<string, string>;
export const DEFAULT_PIN_COUNT_BY_KIND: Record<string, number>;
export const SYMBOL_TYPE_BY_KIND: Record<string, string>;
export const FIXED_PIN_NAMES: Record<string, readonly string[]>;
export const WIRING_ONLY_KINDS: Set<string>;
export const MCU_KINDS: Set<string>;
export const MCU_PIN_COUNTS: Record<string, number>;
export const COMPOUND_SPICE_KINDS: Set<string>;
export function kindLabel(kind: string): string;
