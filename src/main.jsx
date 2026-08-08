import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import { ErrorBoundary } from './app/ErrorBoundary.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
