import type {
  BuildingDetail,
  CitySummary,
  District,
  HouseholdDetail,
  HouseholdListItem,
  Layout,
  LayoutPath,
  MapGeometry,
  PackLabels,
  Page,
  SettlementBrief,
  WorldSummary,
} from '@worldsim/core';
import { type HouseholdFilters, listQuery } from './city-format.ts';

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

const settlement = (id: string) => `/api/settlements/${encodeURIComponent(id)}`;

export const fetchWorld = () => get<WorldSummary>('/api/world');
export const fetchMap = () => get<MapGeometry>('/api/map');
export const fetchBrief = (id: string) => get<SettlementBrief>(settlement(id));

let labels: Promise<PackLabels> | undefined;
/** The pack's display names. They change only when the server restarts, so they are fetched once. */
export const fetchPackLabels = () => (labels ??= get<PackLabels>('/api/pack').catch((error) => {
  labels = undefined;
  throw error;
}));

export const fetchCitySummary = (id: string) => get<CitySummary>(`${settlement(id)}/city`);
export const fetchDistricts = (id: string) => get<Page<District>>(`${settlement(id)}/city/districts?limit=500`);
export const fetchHouseholds = (id: string, filters: HouseholdFilters, offset: number, limit: number) =>
  get<Page<HouseholdListItem>>(`${settlement(id)}/city/households?${listQuery(filters, offset, limit)}`);
export const fetchHousehold = (id: string, householdId: string) =>
  get<HouseholdDetail>(`${settlement(id)}/city/households/${encodeURIComponent(householdId)}`);
export const fetchLayout = (id: string) => get<Layout>(`${settlement(id)}/layout`);
export const fetchPath = (id: string, fromLotId: string, toLotId: string) =>
  get<LayoutPath>(`${settlement(id)}/layout/path?from=${encodeURIComponent(fromLotId)}&to=${encodeURIComponent(toLotId)}`);
export const fetchBuilding = (id: string, buildingId: string) =>
  get<BuildingDetail>(`${settlement(id)}/city/buildings/${encodeURIComponent(buildingId)}`);
