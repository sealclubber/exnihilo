/**
 * The outsiders of a settlement: who arrives on each day, each party's whole
 * visit, the vagrants, and everyone's plan for a day.
 *
 * Outsiders obey the rule everyone obeys: nothing is stepped and nothing is
 * remembered.
 *
 * - The parties that arrive on a day are a function of the settlement, the
 *   day and a seed. Each kind of traveller has a random stream of its own for
 *   each day, and each party one of its own, so that a kind can be changed or
 *   removed without disturbing the others.
 * - A party's whole visit is derived from the day it arrives: who is in it,
 *   where they came from, where they lodge, what they do, and when and by
 *   which exit they leave. So the people in town on a day are the arrivals of
 *   that day and of the few days before it whose visit has not ended, and can
 *   be worked out for any day without the days before.
 * - The vagrants are a fixed set, and where each sleeps on a night is a
 *   function of the vagrant and the night.
 *
 * This reads the brief, the city, the layout format and the pack. No
 * resident's plan reads anything here.
 */
import { speciesOf } from '../city/generate.ts';
import { nameBaseNames } from '../city/names.ts';
import { type Rng, createRng } from '../city/random.ts';
import type { City } from '../city/records.ts';
import { idNumber } from '../ids.ts';
import { distance, pointAlongPolyline, polygonCentroid, polylineLength, projectOnPolyline } from '../layout/geometry.ts';
import { type PathFinder, createPathFinder } from '../layout/path.ts';
import type { Layout, Segment, StreetPosition } from '../layout/records.ts';
import { SECONDS_PER_DAY, startOfDay, weekdayOf } from '../life/calendar.ts';
import { type WorkingHours, createWorkingHours } from '../life/hours.ts';
import type { Activity, DayPlan, Stay, StreetPurpose, StreetStop, Travel, TripPath, Wander } from '../life/records.ts';
import { tripDuration, walkingSpeed } from '../life/walking.ts';
import { type Ground, type WanderHabit, clipWander, groundOf, makeWander, streetGround } from '../life/wander.ts';
import { type OutsiderVisit, type SettingPack, type SleepingPlace, type Species, type TravellerKind, type VisitStop, outsiderStopsOf, placeFlagsOf, sleepLength } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { deriveSeed } from '../seed.ts';
import { type Draw, arrivalRate, drawOf } from './draw.ts';
import type { Outsider, Party, RouteEnd, Traveller, Vagrant } from './records.ts';

export class OutsidersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutsidersError';
  }
}

export interface OutsidersInputs {
  brief: SettlementBrief;
  city: City;
  layout: Layout;
  pack: SettingPack;
  /** Left out, the city's own seed is used. */
  seed?: number;
  /** The town's path finder and working hours, where the caller has them already. */
  finder?: PathFinder;
  hours?: WorkingHours;
}

export interface Outsiders {
  /** The settlement's draw, which the tourists follow. */
  draw: Draw;
  /** The parties that arrive on a day, kind by kind in the pack's order. */
  arrivals(day: number): Party[];
  /** The parties in town at some moment of a day: that day's arrivals, and those of earlier days whose visit has not ended. */
  partiesInTown(day: number): Party[];
  /** Everyone who is in town at some moment of a day: the travellers, in the order their parties arrived, then the vagrants. */
  inTown(day: number): Outsider[];
  /** The settlement's vagrants: the same every day. */
  vagrants(): Vagrant[];
  /** An outsider by ID; nothing if the ID is no outsider's of this settlement. */
  outsider(id: string): Outsider | undefined;
  /** A party by ID, or the party of a traveller. */
  party(id: string): Party | undefined;
  /** How fast an outsider walks: for a traveller, as fast as the slowest of the party. */
  speedOf(id: string): number;
  /** An outsider's plan for a day: the part of the day they are in town, and empty on a day they are not. */
  plan(id: string, day: number): DayPlan;
  /** The plan of everyone in town on a day, in the order of `inTown`. */
  plansForDay(day: number): DayPlan[];
}

/** Somewhere a walk can begin or end: a building, by its lot's entrance, or a point on a street. */
type Spot = { building: string } | { street: StreetPosition };
/** An outing from where someone is based and back to it. */
interface Block {
  start: number;
  end: number;
  activities: Activity[];
}
/** Whoever a plan is made for: a party or a vagrant. */
interface Who {
  /** The ID that names their random streams. */
  key: string;
  species: string;
  speed: number;
}
interface Reachable {
  id: string;
  away: number;
}

const DAYS_KEPT = 12;
/** How many street points are drawn when looking for where a stroll turns back. */
const STROLL_TRIES = 6;
/** Above this many expected arrivals the number on a day is drawn from a bell curve instead of counted out. */
const LARGE_RATE = 30;

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
/** A day number as it is written in an ID: six digits, with an `m` before them for a day before day 1. */
const dayTag = (day: number) => (day < 0 ? `m${pad(-day, 6)}` : pad(day, 6));

/** A whole number of arrivals drawn around an average. */
function drawCount(rate: number, rng: Rng): number {
  if (!(rate > 0)) return 0;
  if (rate > LARGE_RATE) {
    const bell = Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());
    return Math.max(0, Math.round(rate + Math.sqrt(rate) * bell));
  }
  // Counting how many draws it takes for their product to fall below e^-rate.
  const limit = Math.exp(-rate);
  let count = 0;
  for (let product = rng.next(); product > limit; product *= rng.next()) count++;
  return count;
}

/** A stretch of street where someone with no dwelling may sleep. */
interface Stretch {
  segment: Segment;
  from: number;
  to: number;
}

/**
 * Which of the pack's kinds of sleeping place a street position is: on a lane, by the end of a bridge or by a gate
 * (within `reach` of it, on a segment that is not a bridge), or on a street built on one side only, as at the
 * town's edge.
 */
export function sleepingPlacesAt(layout: Layout, position: StreetPosition, reach: number): SleepingPlace[] {
  return sleepingPlaces(layout).at(position, reach);
}

function sleepingPlaces(layout: Layout) {
  const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
  // The side of its street each lot stands on: the sign of the turn from the street's direction to the lot.
  const sides = new Map<string, Set<number>>();
  for (const lot of layout.lots) {
    const segment = segments.get(lot.entrance.segmentId);
    if (!segment) continue;
    let nearest = Infinity;
    let side = 0;
    const [ex, ey] = lot.entrance.point;
    const [cx, cy] = polygonCentroid(lot.polygon);
    for (let at = 1; at < segment.points.length; at++) {
      const a = segment.points[at - 1] as Point;
      const b = segment.points[at] as Point;
      const away = projectOnPolyline([a, b], lot.entrance.point).distance;
      if (away >= nearest) continue;
      nearest = away;
      side = Math.sign((b[0] - a[0]) * (cy - ey) - (b[1] - a[1]) * (cx - ex));
    }
    if (side !== 0) sides.set(segment.id, (sides.get(segment.id) ?? new Set()).add(side));
  }
  const isEdge = (segment: Segment) => segment.kind !== 'lane' && segment.kind !== 'bridge' && sides.get(segment.id)?.size === 1;
  const endsOfKind = (segment: Segment, kind: 'bridge-end' | 'gate') =>
    segment.kind === 'bridge' ? [] : [segment.fromJunctionId, segment.toJunctionId].flatMap((id) => (junctions.get(id)?.kind === kind ? [junctions.get(id)!.position] : []));
  return {
    at(position: StreetPosition, reach: number): SleepingPlace[] {
      const segment = segments.get(position.segmentId);
      if (!segment) return [];
      const kinds: SleepingPlace[] = [];
      if (segment.kind === 'lane') kinds.push('lane');
      if (endsOfKind(segment, 'bridge-end').some((end) => distance(end, position.point) <= reach + 1e-6)) kinds.push('bridge-end');
      if (isEdge(segment)) kinds.push('edge');
      if (endsOfKind(segment, 'gate').some((end) => distance(end, position.point) <= reach + 1e-6)) kinds.push('gate');
      return kinds;
    },
    /** Every stretch of street of the kinds allowed. */
    stretches(allowed: readonly SleepingPlace[], reach: number): Stretch[] {
      const found: Stretch[] = [];
      for (const segment of layout.segments) {
        const length = polylineLength(segment.points);
        if ((allowed.includes('lane') && segment.kind === 'lane') || (allowed.includes('edge') && isEdge(segment))) found.push({ segment, from: 0, to: length });
        else if (segment.kind !== 'bridge') {
          // By the end of a bridge, or by a gate: the stretch of the street within reach of that junction.
          const by = (id: string) => (junctions.get(id)?.kind === 'bridge-end' && allowed.includes('bridge-end')) || (junctions.get(id)?.kind === 'gate' && allowed.includes('gate'));
          if (by(segment.fromJunctionId)) found.push({ segment, from: 0, to: Math.min(reach, length) });
          if (by(segment.toJunctionId)) found.push({ segment, from: Math.max(0, length - reach), to: length });
        }
      }
      return found;
    },
  };
}

export function createOutsiders(inputs: OutsidersInputs): Outsiders {
  const { brief, city, layout, pack } = inputs;
  const seed = inputs.seed ?? city.summary.seed;
  const seedText = String(seed);
  const number = idNumber(brief.id);
  const rules = pack.travellers;
  const kinds = rules?.kinds ?? [];
  const finder = inputs.finder ?? createPathFinder(layout);
  const hours = inputs.hours ?? createWorkingHours({ city, pack, seed });
  const checksHours = pack.visits.openingHours === true;
  const streetReach = pack.visits.streetReach ?? 0;
  const { calendar } = pack;
  const townSpecies = speciesOf(brief, pack);
  const names = nameBaseNames(brief);
  const visitById = new Map((rules?.visits ?? []).map((visit) => [visit.id, visit]));
  const stream = (name: string, key: string) => createRng(deriveSeed(seedText, `outsiders-${name}`, key));

  // ---- Lookups, made once -------------------------------------------------------
  const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const segmentById = new Map(layout.segments.map((segment) => [segment.id, segment]));
  const buildingsOfType = new Map<string, string[]>();
  for (const building of city.buildings) {
    if (!lotOf.has(building.id)) continue;
    const list = buildingsOfType.get(building.type);
    if (list) list.push(building.id);
    else buildingsOfType.set(building.type, [building.id]);
  }
  const openAir = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir).map((building) => building.id));
  const habits = new Map<string, WanderHabit | undefined>(
    Object.entries(pack.species).map(([speciesId, species]) => {
      const outside = species.life.outside;
      return [speciesId, outside && { pace: outside.pace, pause: { min: outside.pauseMinutes.min * 60, max: outside.pauseMinutes.max * 60 } }];
    }),
  );

  // The exits, as places on the street graph: each exit's junction, on the segment that ends there.
  interface Way {
    exitId: string;
    position: StreetPosition;
    end: RouteEnd;
    kind: RouteEnd['routeKind'];
  }
  const junctionById = new Map(layout.junctions.map((junction) => [junction.id, junction]));
  const ways: Way[] = layout.exits.flatMap((exit) => {
    const junction = junctionById.get(exit.junctionId);
    const segment = layout.segments.find((entry) => entry.fromJunctionId === exit.junctionId || entry.toJunctionId === exit.junctionId);
    if (!junction || !segment) return [];
    // The brief says where the route leads from here.
    const route = brief.routes.find((entry) => entry.routeId === exit.routeId && entry.bearing === exit.bearing);
    const end: RouteEnd = { routeId: exit.routeId, ...(exit.name !== undefined && { routeName: exit.name }), routeKind: exit.kind, ...(route?.leadsTo && { settlement: route.leadsTo }) };
    return [{ exitId: exit.id, position: { segmentId: segment.id, point: junction.position }, end, kind: exit.kind }];
  });

  // ---- Walks, stays and wanders ---------------------------------------------------
  const positionOf = (spot: Spot): StreetPosition => {
    if ('street' in spot) return spot.street;
    const lot = lotOf.get(spot.building);
    if (!lot) throw new OutsidersError(`${spot.building} has no lot in the layout`);
    return lot.entrance;
  };
  const paths = new Map<string, TripPath>();
  const pathBetween = (from: Spot, to: Spot): TripPath => {
    if ('building' in from && 'building' in to) {
      const key = `${from.building}>${to.building}`;
      let path = paths.get(key);
      if (!path) {
        const { segmentIds, walked, length, points } = finder.path((lotOf.get(from.building) as Layout['lots'][number]).id, (lotOf.get(to.building) as Layout['lots'][number]).id);
        paths.set(key, (path = { segmentIds, walked, length, points }));
      }
      return path;
    }
    return finder.between(positionOf(from), positionOf(to));
  };
  const hop = (from: Spot, to: Spot, departAt: number, speed: number): Travel => {
    const path = pathBetween(from, to);
    const arriveAt = departAt + tripDuration(path.length, speed);
    return {
      kind: 'travel',
      start: departAt,
      end: arriveAt,
      ...('building' in from ? { fromBuildingId: from.building } : { fromStreet: from.street }),
      ...('building' in to ? { toBuildingId: to.building } : { toStreet: to.street }),
      departAt,
      arriveAt,
      path,
    };
  };
  const grounds = new Map<string, Ground>();
  const groundWander = (who: Who, buildingId: string, start: number, end: number): Wander => {
    let ground = grounds.get(buildingId);
    if (!ground) grounds.set(buildingId, (ground = groundOf(lotOf.get(buildingId) as Layout['lots'][number])));
    return makeWander(ground, stream('outside', `${who.key}:${buildingId}:${start}`), start, end, habits.get(who.species));
  };
  const streetWander = (who: Who, segmentId: string, centre: Point, start: number, end: number, from?: Point): Wander => {
    const segment = segmentById.get(segmentId);
    if (!segment) throw new OutsidersError(`there is no segment with the ID "${segmentId}"`);
    return makeWander(streetGround(segment.points, centre, streetReach), stream('street', `${who.key}:${segmentId}:${start}`), start, end, habits.get(who.species), from);
  };
  /** Time spent at a building on a visit: outside where the building is open-air or the visit says so, as for a resident. */
  const spend = (who: Who, start: number, end: number, buildingId: string, visit: OutsiderVisit): Stay => {
    const outside = (openAir.has(buildingId) || visit.outside === true) && end > start;
    const lot = outside && visit.where === 'street' ? lotOf.get(buildingId) : undefined;
    return {
      kind: 'visit',
      start,
      end,
      buildingId,
      visitId: visit.id,
      ...(outside && { outside: true as const, wander: lot ? streetWander(who, lot.entrance.segmentId, lot.entrance.point, start, end) : groundWander(who, buildingId, start, end) }),
      ...(lot && { onStreet: true as const }),
    };
  };
  /** A pause at a point on a street, reached on foot, moving about a short stretch of it. */
  const pauseAt = (who: Who, street: StreetPosition, start: number, end: number, visit: OutsiderVisit): StreetStop => ({
    kind: 'street',
    start,
    end,
    segmentId: street.segmentId,
    wander: streetWander(who, street.segmentId, street.point, start, end, street.point),
    purpose: 'visit',
    visitId: visit.id,
  });
  /** Being at one point of a street without moving: asleep there, or awake. */
  const stayPut = (street: StreetPosition, start: number, end: number, purpose: StreetPurpose): StreetStop => ({
    kind: 'street',
    start,
    end,
    segmentId: street.segmentId,
    wander: { times: [start, end], points: [street.point, street.point] },
    purpose,
  });
  const spotAfter = (activity: Stay | StreetStop): Spot =>
    activity.kind === 'street' ? { street: { segmentId: activity.segmentId, point: activity.wander.points[activity.wander.points.length - 1] as Point } } : { building: activity.buildingId };

  /** The streets of the town with the running total of their lengths, for drawing a point by length. */
  let streets: { upTo: number[] } | undefined;
  const streetPoint = (rng: Rng): StreetPosition | undefined => {
    if (!streets) {
      let total = 0;
      streets = { upTo: layout.segments.map((segment) => (total += polylineLength(segment.points))) };
    }
    const { upTo } = streets;
    const total = upTo[upTo.length - 1];
    if (total === undefined || total <= 0) return undefined;
    const along = rng.next() * total;
    let at = upTo.findIndex((reached) => reached >= along);
    if (at === -1) at = upTo.length - 1;
    const segment = layout.segments[at] as Segment;
    return { segmentId: segment.id, point: pointAlongPolyline(segment.points, along - (at === 0 ? 0 : (upTo[at - 1] as number))) };
  };

  // ---- Visits ---------------------------------------------------------------------
  const closing = (buildingId: string, at: number) => (checksHours ? hours.openUntil(buildingId, at) : Infinity);
  const reachable = new Map<string, Reachable[]>();
  /** The buildings a stop can go to from somewhere, nearest first. */
  const destinations = (visit: OutsiderVisit, at: number, from: Spot): Reachable[] => {
    const key = 'building' in from ? `${visit.id}#${at}|${from.building}` : undefined;
    const known = key === undefined ? undefined : reachable.get(key);
    if (known) return known;
    const origin = positionOf(from).point;
    const list = (outsiderStopsOf(visit)[at] as VisitStop).destinations
      .flatMap((type) => buildingsOfType.get(type) ?? [])
      .filter((id) => !('building' in from) || id !== from.building)
      .map((id) => ({ id, away: distance(origin, (lotOf.get(id) as Layout['lots'][number]).entrance.point) }))
      .sort((a, b) => a.away - b.away || (a.id < b.id ? -1 : 1));
    if (key !== undefined) reachable.set(key, list);
    return list;
  };
  /**
   * Chooses where a stop goes, or nothing if there is nowhere: the place must be open when they would arrive,
   * and stay open for the stop's shortest duration. Nearer places are favoured, as they are for residents.
   */
  const choose = (visit: OutsiderVisit, at: number, from: Spot, rng: Rng, arrival: (to: string, exact: boolean, away: number) => number): { to: string; arriveAt: number; closes: number } | undefined => {
    const stop = outsiderStopsOf(visit)[at] as VisitStop;
    let list = destinations(visit, at, from);
    const shortest = stop.durationMinutes.min * 60;
    if (checksHours) list = list.filter((entry) => closing(entry.id, arrival(entry.id, false, entry.away)) !== undefined);
    while (list.length > 0) {
      const picked = stop.nearest ? 0 : Math.min(list.length - 1, Math.floor(list.length * rng.next() ** pack.visits.nearness));
      const { id: to, away } = list[picked] as Reachable;
      const arriveAt = arrival(to, true, away);
      const closes = closing(to, arriveAt);
      if (closes !== undefined && closes - arriveAt >= shortest) return { to, arriveAt, closes };
      list = list.filter((_, index) => index !== picked);
    }
    return undefined;
  };
  const stayLength = (stop: VisitStop, rng: Rng) => Math.round((stop.durationMinutes.min + rng.next() * (stop.durationMinutes.max - stop.durationMinutes.min)) * 60);
  /** An errand from a base and back to it: its stops in order, the first reached at `begin`. */
  const errand = (who: Who, visit: OutsiderVisit, begin: number, base: Spot, rng: Rng): Block | undefined => {
    const made: Activity[] = [];
    let here = base;
    let now = begin;
    outsiderStopsOf(visit).forEach((stop, at) => {
      if (stop.chance !== undefined && !rng.chance(stop.chance)) return;
      const wanted = stayLength(stop, rng);
      const first = made.length === 0;
      const origin = here;
      const leaving = now;
      const chosen = choose(visit, at, origin, rng, first ? () => begin : (to, exact, away) => leaving + tripDuration(exact ? pathBetween(origin, { building: to }).length : away, who.speed));
      if (!chosen) return;
      const to: Spot = { building: chosen.to };
      // The first walk is timed to arrive at the moment chosen; the rest set out when the stop before ends.
      made.push(hop(origin, to, first ? begin - tripDuration(pathBetween(origin, to).length, who.speed) : now, who.speed));
      const until = Math.min(chosen.arriveAt + wanted, chosen.closes);
      made.push(spend(who, chosen.arriveAt, until, chosen.to, visit));
      here = to;
      now = until;
    });
    if (made.length === 0) return undefined;
    made.push(hop(here, base, now, who.speed));
    return { start: (made[0] as Activity).start, end: (made[made.length - 1] as Activity).end, activities: made };
  };
  /** A stroll from a base: by way of a place it favours if one is near enough and open, otherwise a point on a street; a pause; and back. */
  const strollOut = (who: Who, visit: OutsiderVisit, begin: number, base: Spot, rng: Rng): Block | undefined => {
    const stroll = visit.stroll as NonNullable<OutsiderVisit['stroll']>;
    const walking = (stroll.minutes.min + rng.next() * (stroll.minutes.max - stroll.minutes.min)) * 60;
    const pause = Math.max(1, Math.round((stroll.pauseMinutes.min + rng.next() * (stroll.pauseMinutes.max - stroll.pauseMinutes.min)) * 60));
    const reach = (walking * who.speed) / 2;
    const origin = positionOf(base).point;
    const places = (stroll.favour ?? [])
      .flatMap((type) => buildingsOfType.get(type) ?? [])
      .filter((id) => (!('building' in base) || id !== base.building) && distance(origin, (lotOf.get(id) as Layout['lots'][number]).entrance.point) <= reach);
    let target: Spot | undefined;
    if (places.length > 0) target = { building: places[Math.floor(rng.next() * places.length)] as string };
    else {
      let nearest = Infinity;
      for (let attempt = 0; attempt < STROLL_TRIES; attempt++) {
        const street = streetPoint(rng);
        if (!street) break;
        const off = Math.abs(distance(origin, street.point) - (reach * 2) / 3);
        if (off < nearest) {
          nearest = off;
          target = { street };
        }
      }
    }
    if (!target) return undefined;
    const out = hop(base, target, begin, who.speed);
    let until = out.arriveAt + pause;
    if ('building' in target) {
      const closes = closing(target.building, out.arriveAt);
      if (closes === undefined) return undefined;
      until = Math.min(until, closes);
    }
    if (until <= out.arriveAt) return undefined;
    const stop = 'building' in target ? spend(who, out.arriveAt, until, target.building, visit) : pauseAt(who, target.street, out.arriveAt, until, visit);
    const back = hop(spotAfter(stop), base, until, who.speed);
    return { start: begin, end: back.arriveAt, activities: [out, stop, back] };
  };
  /**
   * The outings of one day from a base, each at a time of its own in its visit's window, between two moments.
   * One that would begin too early, end too late or touch another does not happen: there is always a spell at
   * the base before an outing and after it, so that no walk follows another without a stop.
   */
  const outings = (who: Who, list: TravellerKind['visits'], dayBase: number, base: Spot, from: number, to: number, rng: Rng): Block[] => {
    const blocks: Block[] = [];
    for (const entry of list) {
      const visit = visitById.get(entry.visit);
      if (!visit || !rng.chance(entry.chance)) continue;
      const times = entry.times ? entry.times.min + Math.floor(rng.next() * (entry.times.max - entry.times.min + 1)) : 1;
      for (let time = 0; time < times; time++) {
        const begin = dayBase + visit.when.from + Math.floor(rng.next() * (visit.when.to - visit.when.from));
        const block = visit.stroll ? strollOut(who, visit, begin, base, rng) : errand(who, visit, begin, base, rng);
        if (!block || block.start <= from || block.end >= to) continue;
        if (blocks.some((other) => block.start <= other.end && block.end >= other.start)) continue;
        blocks.push(block);
      }
    }
    return blocks.sort((a, b) => a.start - b.start);
  };

  // ---- Travellers -----------------------------------------------------------------
  interface PartyDraft {
    party: Party;
    members: Traveller[];
    speed: number;
    /** Everything the party does, from entering to leaving. */
    timeline: Activity[];
  }
  const sleepHabit = (species: Species, rng: Rng) => Math.round((rng.next() * 2 - 1) * species.life.variation.personalMinutes * 60);

  const makeParty = (kind: TravellerKind, day: number, index: number): PartyDraft => {
    const partyId = `party-${number}-${dayTag(day)}-${kind.id}-${pad(index + 1, 3)}`;
    const rng = stream('party', partyId);
    // By which exit: the kind's own weights for the kinds of route, or any exit if it has none for those here.
    const weights = ways.map((way) => kind.arrivals.perExit?.[way.kind] ?? 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let entry = ways[Math.floor(rng.next() * ways.length)] as Way;
    if (total > 0) {
      let target = rng.next() * total;
      entry = ways[ways.length - 1] as Way;
      for (const [at, weight] of weights.entries()) {
        target -= weight;
        if (target < 0) {
          entry = ways[at] as Way;
          break;
        }
      }
    }
    const size = rng.int(kind.partySize.min, kind.partySize.max);
    let nights = rng.int(kind.nights.min, kind.nights.max);
    // They lodge at a building of one of the types the kind names: a type the town has, then one of its buildings.
    const types = (kind.lodging ?? []).filter((type) => (buildingsOfType.get(type) ?? []).length > 0);
    const type = types[Math.floor(rng.next() * types.length)];
    const candidates = type === undefined ? [] : (buildingsOfType.get(type) as string[]);
    const lodging = nights > 0 ? candidates[Math.floor(rng.next() * candidates.length)] : undefined;
    if (lodging === undefined) nights = 0;
    const others = ways.filter((way) => way !== entry);
    const leave = kind.leaves === 'same' || others.length === 0 ? entry : kind.leaves === 'other' ? (others[Math.floor(rng.next() * others.length)] as Way) : (ways[Math.floor(rng.next() * ways.length)] as Way);
    const arriveAt = startOfDay(day) + kind.arrivalHours.from + Math.floor(rng.next() * (kind.arrivalHours.to - kind.arrivalHours.from));
    // Who they are. Their species is that of the culture they come from, where the brief names it.
    const speciesId = (entry.end.settlement && pack.cultures.cultures[entry.end.settlement.culture]) ?? townSpecies;
    const species = pack.species[speciesId] as Species;
    const people = Array.from({ length: size }, (_, member) => {
      const sex = rng.chance(kind.maleShare) ? ('male' as const) : ('female' as const);
      return { id: `traveller-${number}-${dayTag(day)}-${kind.id}-${pad(index + 1, 3)}-${pad(member + 1, 2)}`, givenName: names.givenName(rng, sex), familyName: names.familyName(rng), age: rng.int(kind.ages.min, kind.ages.max), sex, species: speciesId };
    });
    const speed = Math.min(...people.map((person) => walkingSpeed(person, pack)));
    const who: Who = { key: partyId, species: speciesId, speed };
    const habit = sleepHabit(species, rng);

    const timeline: Activity[] = [];
    const push = (activity: Activity) => {
      // A stay of no length is left out; a walk of no length is kept, as it still joins two places.
      if (activity.kind === 'travel' || activity.end > activity.start) timeline.push(activity);
    };
    const gate: Spot = { street: entry.position };
    const wayOut: Spot = { street: leave.position };
    if (lodging === undefined) {
      // On the way through: the kind's visits one after another, each walked to from the last, and out.
      let here: Spot = gate;
      let now = arriveAt;
      let made = 0;
      const attempt = (list: TravellerKind['visits'][number], sure: boolean) => {
        const visit = visitById.get(list.visit);
        if (!visit || visit.stroll || (!sure && !rng.chance(list.chance))) return;
        outsiderStopsOf(visit).forEach((stop, at) => {
          if (!sure && stop.chance !== undefined && !rng.chance(stop.chance)) return;
          const wanted = stayLength(stop, rng);
          const origin = here;
          const leaving = now;
          const chosen = choose(visit, at, origin, rng, (to, exact, away) => leaving + tripDuration(exact ? pathBetween(origin, { building: to }).length : away, speed));
          if (!chosen) return;
          push(hop(origin, { building: chosen.to }, now, speed));
          const until = Math.min(chosen.arriveAt + wanted, chosen.closes);
          push(spend(who, chosen.arriveAt, until, chosen.to, visit));
          here = { building: chosen.to };
          now = until;
          made++;
        });
      };
      for (const entryOf of kind.visits) attempt(entryOf, false);
      // Someone who leaves the way they came had something to stop for: the first visit that can be made.
      if (made === 0 && leave === entry) for (const entryOf of kind.visits) if (made === 0) attempt(entryOf, true);
      push(hop(here, wayOut, now, speed));
    } else {
      const base: Spot = { building: lodging };
      const at = (kindOf: 'sleep' | 'home', start: number, end: number) => push({ kind: kindOf, start, end, buildingId: lodging });
      const walkIn = hop(gate, base, arriveAt, speed);
      push(walkIn);
      let now = walkIn.arriveAt;
      const daily = species.life.variation.dailyMinutes * 60;
      for (let night = 0; night <= nights; night++) {
        const today = day + night;
        const dayBase = startOfDay(today);
        const dayRng = stream('day', `${partyId}:${today}`);
        const vary = () => Math.round((dayRng.next() * 2 - 1) * daily);
        const wake = dayBase + species.life.sleep.to + habit + vary();
        const bed = dayBase + species.life.sleep.to + habit + (SECONDS_PER_DAY - sleepLength(species)) + vary();
        if (night > 0) {
          const up = Math.max(wake, now);
          at('sleep', now, up);
          now = up;
        }
        if (night === nights) {
          // The last day: up, whatever there is time for before setting out, and out by the exit.
          const setOut = Math.max(now + species.life.minutesBeforeLeaving * 60, dayBase + kind.departureHours.from + Math.floor(dayRng.next() * (kind.departureHours.to - kind.departureHours.from)));
          for (const block of outings(who, kind.visits, dayBase, base, now, setOut, dayRng)) {
            at('home', now, block.start);
            for (const activity of block.activities) push(activity);
            now = block.end;
          }
          at('home', now, setOut);
          const walkOut = hop(base, wayOut, setOut, speed);
          push(walkOut);
          now = walkOut.arriveAt;
          break;
        }
        const until = Math.max(bed, now);
        for (const block of outings(who, kind.visits, dayBase, base, now, until, dayRng)) {
          at('home', now, block.start);
          for (const activity of block.activities) push(activity);
          now = block.end;
        }
        at('home', now, until);
        now = until;
      }
    }
    const last = timeline[timeline.length - 1] as Activity;
    const arrival = { time: arriveAt, exitId: entry.exitId };
    const departure = { time: last.end, exitId: leave.exitId };
    const members: Traveller[] = people.map((person) => ({
      group: 'traveller',
      id: person.id,
      kindId: kind.id,
      partyId,
      givenName: person.givenName,
      familyName: person.familyName,
      age: person.age,
      sex: person.sex,
      species: person.species,
      origin: entry.end,
      destination: leave.end,
      arrival,
      departure,
      ...(lodging !== undefined && { lodgingId: lodging }),
    }));
    const party: Party = { id: partyId, kindId: kind.id, arrivalDay: day, nights, memberIds: members.map((member) => member.id), origin: entry.end, destination: leave.end, arrival, departure, ...(lodging !== undefined && { lodgingId: lodging }) };
    return { party, members, speed, timeline };
  };

  const keep = <T>(map: Map<number, T>, day: number, value: T): T => {
    map.delete(day);
    map.set(day, value);
    while (map.size > DAYS_KEPT) map.delete(map.keys().next().value as number);
    return value;
  };
  const arrivalsByDay = new Map<number, PartyDraft[]>();
  const arrivalsOn = (day: number): PartyDraft[] => {
    const known = arrivalsByDay.get(day);
    if (known) return known;
    const drafts: PartyDraft[] = [];
    if (ways.length > 0) {
      for (const kind of kinds) {
        const rate = arrivalRate(kind, brief, pack, weekdayOf(day, calendar));
        const count = drawCount(rate, stream('arrivals', `${kind.id}:${day}`));
        for (let index = 0; index < count; index++) drafts.push(makeParty(kind, day, index));
      }
    }
    return keep(arrivalsByDay, day, drafts);
  };
  /** A visit lasts at most the longest stay of any kind, and the day it ends on. */
  const longest = kinds.reduce((most, kind) => Math.max(most, kind.nights.max), 0) + 1;
  const inTownByDay = new Map<number, PartyDraft[]>();
  const partiesOn = (day: number): PartyDraft[] => {
    const known = inTownByDay.get(day);
    if (known) return known;
    const from = startOfDay(day);
    const to = from + SECONDS_PER_DAY;
    const found: PartyDraft[] = [];
    for (let arrived = day - longest; arrived <= day; arrived++) {
      for (const draft of arrivalsOn(arrived)) {
        const { arrival, departure } = draft.party;
        if (arrival.time < to && (departure.time > from || arrival.time >= from)) found.push(draft);
      }
    }
    return keep(inTownByDay, day, found);
  };
  const partyDraft = (id: string): PartyDraft | undefined => {
    const match = /^(?:party|traveller)-(\d+)-(m?)(\d{6})-/.exec(id);
    if (!match || Number(match[1]) !== number) return undefined;
    const day = (match[2] === 'm' ? -1 : 1) * Number(match[3]);
    return arrivalsOn(day).find((draft) => draft.party.id === id || draft.party.memberIds.includes(id));
  };

  // ---- Vagrants -------------------------------------------------------------------
  interface VagrantDraft {
    vagrant: Vagrant;
    who: Who;
    habit: number;
    /** Where the personal day starts, in seconds from the start of the calendar day of the same number. */
    anchor: number;
    haunts: StreetPosition[];
    /** For how many nights running a place is kept, and where in that run night 0 falls. */
    run: number;
    offset: number;
  }
  const vagrantRules = rules?.vagrants;
  let vagrantDrafts: VagrantDraft[] | undefined;
  const allVagrants = (): VagrantDraft[] => {
    if (vagrantDrafts) return vagrantDrafts;
    vagrantDrafts = [];
    if (!vagrantRules || brief.population < vagrantRules.minPopulation || layout.segments.length === 0) return vagrantDrafts;
    const count = Math.round(brief.population * vagrantRules.share);
    // Where one may sleep: the stretches of street of the kinds the pack allows, or any street if the town has none.
    let stretches = sleepingPlaces(layout).stretches(vagrantRules.sleepsAt, streetReach);
    if (stretches.length === 0) stretches = layout.segments.map((segment) => ({ segment, from: 0, to: polylineLength(segment.points) }));
    let total = 0;
    const upTo = stretches.map((stretch) => (total += Math.max(stretch.to - stretch.from, 1e-6)));
    const place = (rng: Rng): StreetPosition => {
      const along = rng.next() * total;
      let at = upTo.findIndex((reached) => reached >= along);
      if (at === -1) at = upTo.length - 1;
      const stretch = stretches[at] as Stretch;
      return { segmentId: stretch.segment.id, point: pointAlongPolyline(stretch.segment.points, stretch.from + rng.next() * (stretch.to - stretch.from)) };
    };
    const species = pack.species[townSpecies] as Species;
    for (let index = 0; index < count; index++) {
      const id = `vagrant-${number}-${pad(index + 1, 6)}`;
      const rng = stream('vagrant', id);
      const sex = rng.chance(vagrantRules.maleShare) ? ('male' as const) : ('female' as const);
      const vagrant: Vagrant = { group: 'vagrant', id, givenName: names.givenName(rng, sex), familyName: names.familyName(rng), age: rng.int(vagrantRules.ages.min, vagrantRules.ages.max), sex, species: townSpecies };
      const habit = sleepHabit(species, rng);
      const run = rng.int(vagrantRules.spotDays.min, vagrantRules.spotDays.max);
      vagrantDrafts.push({
        vagrant,
        who: { key: id, species: townSpecies, speed: walkingSpeed(vagrant, pack) },
        habit,
        anchor: species.life.sleep.to + habit - Math.round(sleepLength(species) / 2),
        haunts: Array.from({ length: vagrantRules.haunts }, () => place(rng)),
        run,
        offset: rng.int(0, run - 1),
      });
    }
    return vagrantDrafts;
  };
  /** Where a vagrant sleeps on the night that begins on the evening of a day: one of their haunts, kept for a run of nights. */
  const sleepsAt = (draft: VagrantDraft, night: number): StreetPosition => {
    const run = Math.floor((night + draft.offset) / draft.run);
    return draft.haunts[Math.floor(stream('haunt', `${draft.vagrant.id}:${run}`).next() * draft.haunts.length)] as StreetPosition;
  };
  /** A vagrant's day from the middle of one sleep to the middle of the next: asleep where last night was spent, and at the end asleep where tonight is. */
  const vagrantDay = (draft: VagrantDraft, day: number): Activity[] => {
    const species = pack.species[draft.who.species] as Species;
    const rng = stream('day', `${draft.vagrant.id}:${day}`);
    const base = startOfDay(day);
    const dayStart = base + draft.anchor;
    const dayEnd = dayStart + SECONDS_PER_DAY;
    const daily = species.life.variation.dailyMinutes * 60;
    const vary = () => Math.round((rng.next() * 2 - 1) * daily);
    const wake = Math.min(Math.max(base + species.life.sleep.to + draft.habit + vary(), dayStart), dayEnd);
    let bed = Math.min(Math.max(base + species.life.sleep.to + draft.habit + (SECONDS_PER_DAY - sleepLength(species)) + vary(), wake), dayEnd);
    const before = sleepsAt(draft, day - 1);
    const tonight = sleepsAt(draft, day);
    const activities: Activity[] = [];
    const push = (activity: Activity) => {
      if (activity.kind === 'travel' || activity.end > activity.start) activities.push(activity);
    };
    push(stayPut(before, dayStart, wake, 'sleep'));
    let now = wake;
    if (before.segmentId !== tonight.segmentId || distance(before.point, tonight.point) > 0) {
      // Moving on: once up, a walk to the place where tonight will be spent.
      const setOut = Math.min(wake + species.life.minutesBeforeLeaving * 60, bed);
      const move = hop({ street: before }, { street: tonight }, setOut, draft.who.speed);
      push(stayPut(before, wake, setOut, 'home'));
      push(move);
      now = move.arriveAt;
      bed = Math.max(bed, now);
    }
    const here = tonight;
    for (const block of outings(draft.who, vagrantRules?.visits ?? [], base, { street: here }, now, bed, rng)) {
      push(stayPut(here, now, block.start, 'home'));
      for (const activity of block.activities) push(activity);
      now = block.end;
    }
    push(stayPut(here, now, bed, 'home'));
    push(stayPut(here, bed, dayEnd, 'sleep'));
    return activities;
  };
  const vagrantDays = new Map<number, Map<string, Activity[]>>();
  const vagrantDayOf = (draft: VagrantDraft, day: number): Activity[] => {
    const days = vagrantDays.get(day) ?? keep(vagrantDays, day, new Map<string, Activity[]>());
    let activities = days.get(draft.vagrant.id);
    if (!activities) days.set(draft.vagrant.id, (activities = vagrantDay(draft, day)));
    return activities;
  };

  // ---- Plans ----------------------------------------------------------------------
  /** The part of a run of activities that falls in a day, cut at midnight as a resident's is. */
  const slice = (sources: Activity[][], day: number): Activity[] => {
    const from = startOfDay(day);
    const to = from + SECONDS_PER_DAY;
    const activities: Activity[] = [];
    for (const source of sources) {
      for (const activity of source) {
        if (activity.end < from || activity.start > to) continue;
        const start = Math.max(activity.start, from);
        const end = Math.min(activity.end, to);
        // Only what lies within the day is kept; a walk of no length belongs to the day it starts.
        if (end <= start && !(activity.kind === 'travel' && activity.start === activity.end && activity.start >= from && activity.start < to)) continue;
        const previous = activities[activities.length - 1];
        if (previous && previous.kind === 'street' && activity.kind === 'street' && previous.purpose === activity.purpose && previous.end === start && (previous.purpose === 'sleep' || previous.purpose === 'home') && previous.segmentId === activity.segmentId) {
          // Staying put either side of a seam is one activity.
          previous.end = end;
          previous.wander = { times: [previous.start, end], points: [previous.wander.points[0] as Point, previous.wander.points[0] as Point] };
        } else if (previous && previous.kind !== 'travel' && previous.kind !== 'street' && activity.kind === previous.kind && activity.buildingId === previous.buildingId && previous.visitId === activity.visitId && !activity.wander && previous.end === start) {
          previous.end = end;
        } else {
          const wander = activity.kind !== 'travel' && activity.wander && (start !== activity.start || end !== activity.end) ? { wander: clipWander(activity.wander, start, end) } : undefined;
          activities.push({ ...activity, start, end, ...wander });
        }
      }
    }
    return activities;
  };
  const vagrantPlan = (draft: VagrantDraft, day: number): Activity[] => {
    // The calendar day lies across the personal day of the same number and, unless they coincide, one neighbour.
    const days = draft.anchor > 0 ? [day - 1, day] : draft.anchor < 0 ? [day, day + 1] : [day];
    return slice(days.map((source) => vagrantDayOf(draft, source)), day);
  };
  const plansByDay = new Map<number, DayPlan[]>();
  const plansForDay = (day: number): DayPlan[] => {
    const known = plansByDay.get(day);
    if (known) return known;
    const plans: DayPlan[] = [];
    for (const draft of partiesOn(day)) {
      // A party moves together: its members share one plan.
      const activities = slice([draft.timeline], day);
      for (const member of draft.members) plans.push({ personId: member.id, outsider: true, day, activities });
    }
    for (const draft of allVagrants()) plans.push({ personId: draft.vagrant.id, outsider: true, day, activities: vagrantPlan(draft, day) });
    return keep(plansByDay, day, plans);
  };
  const vagrantById = (id: string) => allVagrants().find((draft) => draft.vagrant.id === id);

  return {
    draw: drawOf(brief, pack),
    arrivals: (day) => arrivalsOn(day).map((draft) => draft.party),
    partiesInTown: (day) => partiesOn(day).map((draft) => draft.party),
    inTown: (day) => [...partiesOn(day).flatMap((draft) => draft.members), ...allVagrants().map((draft) => draft.vagrant)],
    vagrants: () => allVagrants().map((draft) => draft.vagrant),
    outsider(id) {
      if (id.startsWith('vagrant-')) return vagrantById(id)?.vagrant;
      return partyDraft(id)?.members.find((member) => member.id === id);
    },
    party: (id) => partyDraft(id)?.party,
    speedOf(id) {
      const speed = id.startsWith('vagrant-') ? vagrantById(id)?.who.speed : partyDraft(id)?.speed;
      if (speed === undefined) throw new OutsidersError(`there is no outsider with the ID "${id}"`);
      return speed;
    },
    plan(id, day) {
      const known = plansByDay.get(day)?.find((plan) => plan.personId === id);
      if (known) return known;
      if (id.startsWith('vagrant-')) {
        const draft = vagrantById(id);
        if (!draft) throw new OutsidersError(`there is no outsider with the ID "${id}"`);
        return { personId: id, outsider: true, day, activities: vagrantPlan(draft, day) };
      }
      const draft = partyDraft(id);
      if (!draft || !draft.party.memberIds.includes(id)) throw new OutsidersError(`there is no outsider with the ID "${id}"`);
      return { personId: id, outsider: true, day, activities: slice([draft.timeline], day) };
    },
    plansForDay,
  };
}
