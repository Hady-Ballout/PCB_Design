// Shared frontend configuration.
// Single source of truth for the API base URL (previously duplicated in
// src/App.jsx and src/features/auth/auth.jsx).
export const API_BASE = import.meta.env.VITE_API_URL || '';
