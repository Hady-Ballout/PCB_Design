export interface ComponentKindInfo {
  spicePrefix: string;
  pins: number;
  symbolType: string;
  label: string;
  category: string;
  aliases?: readonly string[];
  keywords?: readonly string[];
  preferredValues?: readonly string[];
  fixedPins?: readonly string[];
  wiringOnly?: boolean;
  mcu?: boolean;
}

export interface ComponentCategory {
  id: string;
  title: string;
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
export const COMPONENT_CATEGORIES: readonly ComponentCategory[];
export const KIND_CATEGORY: Record<string, string>;
export const KIND_ALIASES: Record<string, readonly string[]>;
export const KIND_KEYWORDS: Record<string, readonly string[]>;
export const PREFERRED_VALUES: Record<string, readonly string[]>;
export const KINDS_BY_CATEGORY: Record<string, string[]>;
export function kindLabel(kind: string): string;
export function kindSearchText(kind: string): string;
export function kindMatchesQuery(kind: string, query: string): boolean;
