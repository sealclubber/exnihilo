/**
 * Shapes of the server's HTTP responses, shared so the client can type them.
 */
import type { Building, District, Household, Person } from './city/records.ts';
import type { DayPlan, Occupant, Trip, Whereabouts } from './life/records.ts';
import type { Calendar } from './pack/schema.ts';
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
  /** How an apprentice's occupation is shown; {occupation} stands for the occupation's name. */
  apprenticeLabel?: string;
  /** The week, the year and the daylight, for showing game time. */
  calendar: Calendar;
  /** The names of the pack's visits, by ID. */
  visits: Record<string, string>;
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
  /**
   * The member a list row shows: the head, or under a category or occupation
   * filter the first member who matches it.
   */
  member: Pick<Person, 'id' | 'role' | 'occupationId' | 'apprentice'> & { name: string };
  districtId: string;
}

export type DistrictRef = Pick<District, 'id' | 'name' | 'kind'>;

export interface HouseholdDetail {
  household: Household;
  members: Person[];
  dwelling: Building;
  district: DistrictRef;
  /**
   * Where each working member works, by building ID: the building's type, and
   * the employing household when the work is done in its home.
   */
  workplaces: Record<string, { type: string; employer?: { householdId: string; familyName: string } }>;
  /** People employed by this household, who work in its home. */
  staff: Person[];
}

export interface BuildingDetail {
  building: Building;
  district: DistrictRef;
  workers: Person[];
  households: HouseholdListItem[];
}

/** The world clock as the server reports it. */
export interface ClockState {
  /** Game seconds since the start of day 1, at the moment of the report. */
  gameTime: number;
  /** Game seconds per real second. */
  rate: number;
  running: boolean;
  /** The rates on offer. */
  rates: number[];
}

/** The trips under way at some point in a window of game time. */
export interface TripsWindow {
  from: number;
  to: number;
  trips: Trip[];
}

/** A person at a moment: who they are and where. */
export interface PersonNow {
  time: number;
  person: Person;
  whereabouts: Whereabouts;
  /** The type of each building the answer names, by building ID. */
  buildings: Record<string, string>;
}

/** A person's plan for a day. */
export interface PersonPlan {
  person: Person;
  plan: DayPlan;
  /** The type of each building the plan names, by building ID. */
  buildings: Record<string, string>;
}

/** Who is inside a building at a moment. */
export interface OccupantsNow {
  time: number;
  buildingId: string;
  occupants: Array<Occupant & { person: Person }>;
}

/** What each member of a household is doing at a moment. */
export interface HouseholdNow {
  time: number;
  householdId: string;
  members: Whereabouts[];
}
