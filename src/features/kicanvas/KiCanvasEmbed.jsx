import React, { useEffect, useRef, useState } from 'react';
import './KiCanvasEmbed.css';

// KiCanvas ships as a self-registering web-component bundle (no npm package),
// vendored at public/vendor/kicanvas.js. Load it once, on first use.
let kicanvasLoader = null;
const loadKiCanvas = () => {
  kicanvasLoader ||= new Promise((resolve, reject) => {
    if (globalThis.customElements?.get('kicanvas-embed')) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/vendor/kicanvas.js';
    script.onload = () => globalThis.customElements.whenDefined('kicanvas-embed').then(resolve, reject);
    script.onerror = () => reject(new Error('Could not load the KiCanvas viewer script (public/vendor/kicanvas.js).'));
    document.head.appendChild(script);
  });
  return kicanvasLoader;
};

// KiCanvas frames the whole worksheet page after every load, which strands a
// board in the corner of a mostly-empty A4 sheet. For board sources we hide
// the drawing-sheet layer and fit the camera to the board outline instead.
// The viewer sits behind open shadow roots but is created asynchronously with
// no bubbling load event, so poll until it exists, then wait for its load.
export async function focusBoardView(embed, { pollMs = 50, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const viewer = embed.shadowRoot
      ?.querySelector('kc-board-app')
      ?.shadowRoot?.querySelector('kc-board-viewer')
      ?.viewer;
    if (viewer) {
      await viewer.loaded;
      viewer.page_opacity = 0;
      viewer.zoom_to_board();
      viewer.draw();
      return true;
    }
    if (!embed.isConnected || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Renders KiCad file content (e.g. a generated .kicad_sch) with KiCanvas.
// The embed is rebuilt whenever the source text changes — KiCanvas does not
// watch its children, so a fresh element is the reliable way to re-render.
// focus="board" crops the view to the board outline with no worksheet sheet.
export function KiCanvasEmbed({ source, focus }) {
  const hostRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!source) return undefined;
    let cancelled = false;
    setError('');
    loadKiCanvas()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const embed = document.createElement('kicanvas-embed');
        embed.setAttribute('controls', 'basic');
        embed.setAttribute('theme', 'witchhazel');
        const sourceElement = document.createElement('kicanvas-source');
        sourceElement.textContent = source;
        embed.appendChild(sourceElement);
        hostRef.current.replaceChildren(embed);
        if (focus === 'board') focusBoardView(embed);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message);
      });
    return () => {
      cancelled = true;
    };
  }, [source, focus]);

  if (error) {
    return (
      <div className="kicanvas-host kicanvas-error" role="alert">
        <strong>KiCanvas failed to load</strong>
        <p>{error}</p>
      </div>
    );
  }
  return <div className="kicanvas-host" ref={hostRef} aria-label="KiCad schematic viewer" />;
}
