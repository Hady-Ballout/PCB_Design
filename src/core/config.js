// Shared frontend configuration.
// Single source of truth for the API base URL (also read by
// src/features/auth/auth.jsx).
export const API_BASE = import.meta.env.VITE_API_URL || '';
