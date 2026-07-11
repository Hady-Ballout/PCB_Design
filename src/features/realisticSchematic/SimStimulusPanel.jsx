// Stimulus sliders for the selected part while the simulation runs: LDR light
// level, thermistor temperature, and a precision alternative to dragging the
// potentiometer wiper on the board.
const SLIDER_PRESENTATION = {
  light: { icon: '🌙', endIcon: '🔆', format: (value) => `${Math.round(value * 100)}%` },
  tempC: { icon: '❄', endIcon: '🔥', format: (value) => `${Math.round(value)} °C` },
  wiper: { icon: '', endIcon: '', format: (value) => `${Math.round(value * 100)}%` },
};

export function SimStimulusPanel({ controls, onChange }) {
  const sliders = controls.filter((control) => control.type === 'slider');
  if (sliders.length === 0) return null;
  return (
    <div className="rs-stimulus-panel">
      {sliders.map((control) => {
        const presentation = SLIDER_PRESENTATION[control.name] ?? { icon: '', endIcon: '', format: String };
        return (
          <label key={`${control.ref}:${control.name}`} className="rs-stimulus-row">
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
