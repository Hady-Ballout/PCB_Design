// Stimulus sliders for the selected part while the simulation runs: LDR light
// level, thermistor temperature, and a precision alternative to dragging the
// potentiometer wiper on the board.
const SLIDER_PRESENTATION = {
  light: { icon: '🌙', endIcon: '🔆', format: (value) => `${Math.round(value * 100)}%` },
  tempC: { icon: '❄', endIcon: '🔥', format: (value) => `${Math.round(value)} °C` },
  wiper: { icon: '', endIcon: '', format: (value) => `${Math.round(value * 100)}%` },
};

export function SimStimulusPanel({ controls, onChange }) {
  const interactive = controls.filter((control) => ['slider', 'stepper', 'button'].includes(control.type));
  if (interactive.length === 0) return null;
  return (
    <div className="rs-stimulus-panel">
      {interactive.map((control) => {
        const key = `${control.ref}:${control.name}`;
        if (control.type === 'stepper') {
          // Event-style control: each click emits ±1 (encoder detents).
          return (
            <span key={key} className="rs-stimulus-row">
              <span className="rs-stimulus-label">{control.ref} · {control.label ?? control.name}</span>
              <button type="button" onClick={() => onChange(control.ref, control.name, -1)}>◀ CCW</button>
              <button type="button" onClick={() => onChange(control.ref, control.name, 1)}>CW ▶</button>
            </span>
          );
        }
        if (control.type === 'button') {
          return (
            <span key={key} className="rs-stimulus-row">
              <span className="rs-stimulus-label">{control.ref} · {control.label ?? control.name}</span>
              <button type="button" onClick={() => onChange(control.ref, control.name, 1)}>Press</button>
            </span>
          );
        }
        const presentation = SLIDER_PRESENTATION[control.name] ?? { icon: '', endIcon: '', format: String };
        return (
          <label key={key} className="rs-stimulus-row">
            <span className="rs-stimulus-label">
              {control.ref} · {control.label ?? control.name}
            </span>
            {presentation.icon && <span aria-hidden="true">{presentation.icon}</span>}
            <input
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={control.value}
              onChange={(event) => onChange(control.ref, control.name, Number(event.target.value))}
            />
            {presentation.endIcon && <span aria-hidden="true">{presentation.endIcon}</span>}
            <span className="rs-stimulus-value">{presentation.format(Number(control.value))}</span>
          </label>
        );
      })}
    </div>
  );
}
