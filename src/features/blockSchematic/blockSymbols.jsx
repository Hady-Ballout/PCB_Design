// Presentational SVG glyphs for the block-schematic cards, keyed by component
// `kind`. Kept self-contained inside the blockSchematic chunk (rather than
// importing the schematic-canvas symbols) so this feature stays decoupled.
// All art is stroke-only via `currentColor`, so the CSS colour drives it.

function symbolPaths(kind) {
  switch (kind) {
    case 'resistor':
    case 'load':
      return <path d="M2 12h10 l2 -6 l4 12 l4 -12 l4 12 l4 -12 l2 6 h14" />;
    case 'capacitor':
      return <path d="M2 12h20 M22 5v14 M28 5v14 M28 12h18" />;
    case 'inductor':
      return <path d="M2 12h10 c2 -7 6 -7 8 0 c2 -7 6 -7 8 0 c2 -7 6 -7 8 0 h10" />;
    case 'diode':
      return (
        <>
          <path d="M2 12h16 M32 12h14 M18 6v12l14 -6z M32 6v12" />
        </>
      );
    case 'led':
      return (
        <>
          <path d="M2 12h16 M32 12h14 M18 6v12l14 -6z M32 6v12" />
          <path d="M32 7l6 -5 M38 2h-4 M38 2v4" />
          <path d="M35 10l6 -5 M41 5h-4 M41 5v4" />
        </>
      );
    case 'bjt_npn':
      return (
        <>
          <circle cx="24" cy="12" r="10" />
          <path d="M2 12h13 M15 6v12 M15 9L29 4 M15 15L28 19" />
          <path d="M28 19l-4 -1 M28 19l-1 -4" />
        </>
      );
    case 'bjt_pnp':
      return (
        <>
          <circle cx="24" cy="12" r="10" />
          <path d="M2 12h13 M15 6v12 M15 9L29 4 M15 15L28 19" />
          <path d="M15 15l4 1 M15 15l1 4" />
        </>
      );
    case 'mosfet_n':
      return (
        <>
          <path d="M2 12h6 M8 6v12 M12 6v12 M12 9h10 M22 9v-6 M12 15h10 M22 15v6" />
          <path d="M18 10.5L14 12L18 13.5" />
        </>
      );
    case 'mosfet_p':
      return (
        <>
          <path d="M2 12h6 M8 6v12 M12 6v12 M12 9h10 M22 9v-6 M12 15h10 M22 15v6" />
          <path d="M14 10.5L18 12L14 13.5" />
        </>
      );
    case 'opamp':
      return (
        <>
          <path d="M14 4L14 20L34 12Z M4 8h10 M4 16h10 M34 12h10" />
          <path d="M17 8h3 M18.5 6.5v3 M17 16h3" />
        </>
      );
    case 'regulator':
      return <path d="M12 4h24v16h-24z M4 9h8 M4 15h8 M36 12h8" />;
    case 'voltage_source':
      return (
        <>
          <circle cx="24" cy="12" r="10" />
          <path d="M2 12h12 M34 12h12 M18 12h4 M20 10v4 M26 12h4" />
        </>
      );
    case 'signal_source':
      return (
        <>
          <circle cx="24" cy="12" r="10" />
          <path d="M2 12h12 M34 12h12 M17 12Q20.5 5 24 12T31 12" />
        </>
      );
    default:
      return <rect x="8" y="6" width="32" height="12" rx="3" />;
  }
}

export function BlockSymbol({ kind, label }) {
  return (
    <svg
      className="block-node-symbol"
      viewBox="0 0 48 24"
      role="img"
      aria-label={label}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbolPaths(kind)}
    </svg>
  );
}
