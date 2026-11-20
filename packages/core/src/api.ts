/**
 * Shapes of the server's HTTP responses, shared so the client can type them.
 */
import type { Building, District, Household, Person } from './city/records.ts';
import type { CategoryId } from './pack/schema.ts';
import type { ImportReport, Point, RouteKind, SizeGroup, WorldInfo } from './schema.ts';

export interface WorldSummary {
  info: WorldInfo;
  counts: ImportReport['counts'];
}

export interface SettlementListItem {
  id: string;
  name: string;
  position: Point;
  sizeGroup: SizeGroup;
  isCapital: boolean;
  population: number;
  stateId: string;
}

/** Everything the viewer needs to draw the world map. */
export interface MapGeometry {
  width: number;
  height: number;
  cells: Array<{ id: string; polygon: Point[]; isLand: boolean; stateId: string }>;
  states: Array<{ id: string; name: string; colour?: string; isPlaceholder: boolean }>;
  rivers: Array<{ id: string; name: string; points: Point[] }>;
  routes: Array<{ id: string; kind: RouteKind; points: Point[] }>;
  settlements: SettlementListItem[];
}

export interface ApiError {
  error: string;
}

/** Display names for everything a city's records refer to by ID. */
export interface PackLabels {
  name: string;
  version: string;
  categories: Array<{ id: CategoryId; name: string }>;
  /** Lowest tier first. */
  statusTiers: Array<{ id: string; name: string }>;
  occupations: Record<string, { name: string; category: CategoryId }>;
  buildingTypes: Record<string, string>;
  districtKinds: Record<string, string>;
}

/** One page of a longer list. */
export interface Page<T> {
  /** How many records match in all. */
  total: number;
  offset: number;
  limit: number;
  items: T[];
}

/** A household as shown in a list: the record plus what identifies it at a glance. */
export interface HouseholdListItem extends Household {
  size: number;
  headName: string;
  headOccupationId?: string;
  districtId: string;
}

export type DistrictRef = Pick<District, 'id' | 'name' | 'kind'>;

export interface HouseholdDetail {
  household: Household;
  members: Person[];
  dwelling: Building;
  district: DistrictRef;
}

export interface BuildingDetail {
  building: Building;
  district: DistrictRef;
  workers: Person[];
  households: HouseholdListItem[];
}
