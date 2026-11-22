import type {
  BuildingTypes,
  AvatarPerception,
  AvatarReport,
  BuildingDetail,
  CitySummary,
  ClockState,
  HouseholdNow,
  OccupantsNow,
  OutsiderDetail,
  OutsidersToday,
  PersonNow,
  PersonPlan,
  Region,
  TripsWindow,
  District,
  HouseholdDetail,
  HouseholdListItem,
  Layout,
  LayoutPath,
  MapGeometry,
  PackLabels,
  Page,
  SettlementBrief,
  SettlementDraw,
  WorldSummary,
} from '@worldsim/core';
import { type HouseholdFilters, listQuery } from './city-format.ts';

/**
 * Where the server is. Set VITE_API_URL to override; by default the API is
 * expected on port 3001 of the machine this page was loaded from.
 */
export const API_URL: string =
  // An address given as ?api=... wins, so one viewer can be pointed at more than one server.
  new URLSearchParams(location.search).get('api')?.replace(/\/+$/, '') ||
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
export const fetchDraw = (id: string) => get<SettlementDraw>(`${settlement(id)}/draw`);

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
export const fetchBuildingTypes = (id: string) => get<BuildingTypes>(`${settlement(id)}/city/building-types`);
export const fetchLayout = (id: string) => get<Layout>(`${settlement(id)}/layout`);
export const fetchPath = (id: string, fromLotId: string, toLotId: string) =>
  get<LayoutPath>(`${settlement(id)}/layout/path?from=${encodeURIComponent(fromLotId)}&to=${encodeURIComponent(toLotId)}`);
export const fetchBuilding = (id: string, buildingId: string) =>
  get<BuildingDetail>(`${settlement(id)}/city/buildings/${encodeURIComponent(buildingId)}`);

// ---- The clock -------------------------------------------------------------------

export const fetchClock = () => get<ClockState>('/api/clock');

/** Asks the server to change the clock: run, pause, rate or time. */
export async function postClock(action: 'run' | 'pause' | 'rate' | 'time', body: object = {}): Promise<ClockState> {
  const response = await fetch(`${API_URL}/api/clock/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = (await response.json()) as ClockState & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `The server answered ${response.status}`);
  return answer;
}

/**
 * Listens for the clock's changes, calling back with the state on connecting and after every
 * change. Reconnects if the connection drops. Returns a function that stops listening.
 */
export function watchClock(onState: (state: ClockState) => void): () => void {
  return watch('/api/clock/stream', onState);
}

/** Listens to one of the server's streams, reconnecting if the connection drops. Returns a function that stops listening. */
function watch<T>(path: string, onState: (state: T) => void): () => void {
  let socket: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    socket = new WebSocket(`${API_URL.replace(/^http/, 'ws')}${path}`);
    socket.addEventListener('message', (event) => onState(JSON.parse(String(event.data)) as T));
    socket.addEventListener('close', () => {
      if (!stopped) retry = setTimeout(connect, 2000);
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}

// ---- Daily life ---------------------------------------------------------------------

export function fetchTrips(id: string, from: number, to: number, region?: Region): Promise<TripsWindow> {
  const params = new URLSearchParams({ from: String(Math.floor(from)), to: String(Math.ceil(to)) });
  if (region) for (const [name, value] of Object.entries(region)) params.set(name, String(Math.round(value)));
  return get<TripsWindow>(`${settlement(id)}/life/trips?${params}`);
}
export const fetchPersonNow = (id: string, personId: string, time: number) =>
  get<PersonNow>(`${settlement(id)}/life/people/${encodeURIComponent(personId)}/now?time=${time}`);
export const fetchPersonPlan = (id: string, personId: string, day: number) =>
  get<PersonPlan>(`${settlement(id)}/life/people/${encodeURIComponent(personId)}/plan?day=${day}`);
export const fetchOccupants = (id: string, buildingId: string, time: number) =>
  get<OccupantsNow>(`${settlement(id)}/life/buildings/${encodeURIComponent(buildingId)}/occupants?time=${time}`);
export const fetchHouseholdNow = (id: string, householdId: string, time: number) =>
  get<HouseholdNow>(`${settlement(id)}/life/households/${encodeURIComponent(householdId)}/now?time=${time}`);

// ---- Outsiders ---------------------------------------------------------------------

export const fetchOutsiders = (id: string, day: number) => get<OutsidersToday>(`${settlement(id)}/life/outsiders?day=${day}`);
export const fetchOutsider = (id: string, outsiderId: string, time: number) =>
  get<OutsiderDetail>(`${settlement(id)}/life/outsiders/${encodeURIComponent(outsiderId)}?time=${time}`);

// ---- The avatar ------------------------------------------------------------------

export const fetchAvatar = () => get<AvatarReport>('/api/avatar');
export const fetchPerception = () => get<AvatarPerception>('/api/avatar/perception');

export type AvatarAction = 'spawn' | 'walk-to-point' | 'walk-to-building' | 'stop' | 'leave';

/** Asks the server for one of the avatar's actions. A refusal comes back as an error with the server's reason. */
export async function postAvatar(action: AvatarAction, body: object = {}): Promise<AvatarReport> {
  const response = await fetch(`${API_URL}/api/avatar/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = (await response.json()) as AvatarReport & { error?: string };
  if (!response.ok) throw new Error(answer.error ?? `The server answered ${response.status}`);
  return answer;
}

/** Listens for the avatar's changes: its state on connecting, then after every change. */
export function watchAvatar(onState: (report: AvatarReport) => void): () => void {
  return watch('/api/avatar/stream', onState);
}
