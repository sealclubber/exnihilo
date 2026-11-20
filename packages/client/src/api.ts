import type { MapGeometry, SettlementBrief, WorldSummary } from '@worldsim/core';

/**
 * Where the server is. Set VITE_API_URL to override; by default the API is
 * expected on port 3001 of the machine this page was loaded from.
 */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ||
  `${location.protocol}//${location.hostname}:3001`;

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`);
  } catch {
    throw new Error(`Cannot reach the server at ${API_URL}. Is it running?`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `The server answered ${response.status} for ${path}`);
  }
  return (await response.json()) as T;
}

export const fetchWorld = () => get<WorldSummary>('/api/world');
export const fetchMap = () => get<MapGeometry>('/api/map');
export const fetchBrief = (id: string) => get<SettlementBrief>(`/api/settlements/${encodeURIComponent(id)}`);
