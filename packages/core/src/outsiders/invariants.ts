/**
 * The rules every outsider's plan must satisfy: the rules a resident's plan
 * satisfies, for the time the outsider is in town, and those of their own.
 * Returns one line per broken rule; an empty list means the plan is sound.
 */
import type { City } from '../city/records.ts';
import { distance, distanceToPolyline, piecesCross, pointInPolygon, strictlyInside } from '../layout/geometry.ts';
import type { Layout, Lot, StreetPosition } from '../layout/records.ts';
import { SECONDS_PER_DAY, startOfDay } from '../life/calendar.ts';
import { type WorkingHours, createWorkingHours } from '../life/hours.ts';
import type { Activity, DayPlan, Wander } from '../life/records.ts';
import { tripDuration } from '../life/walking.ts';
import { type SettingPack, outsiderStopsOf, placeFlagsOf } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { type Outsiders, sleepingPlacesAt } from './outsiders.ts';

const MOST_PROBLEMS_LISTED = 10;
/** Points are compared to the nearest millimetre. */
const CLOSE = 1e-3;

export interface OutsiderChecker {
  /** One line per rule a plan breaks. */
  check(plan: DayPlan): string[];
  /** One line if an outsider is not in the same place at the end of one day and the start of the next. */
  checkContinuity(earlier: DayPlan, later: DayPlan): string[];
}

type Place = { building: string } | { street: StreetPosition };
const startOf = (activity: Activity): Place => {
  if (activity.kind === 'travel') return activity.fromBuildingId !== undefined ? { building: activity.fromBuildingId } : { street: activity.fromStreet as StreetPosition };
  if (activity.kind === 'street') return { street: { segmentId: activity.segmentId, point: activity.wander.points[0] as Point } };
  return { building: activity.buildingId };
};
const endOf = (activity: Activity): Place => {
  if (activity.kind === 'travel') return activity.toBuildingId !== undefined ? { building: activity.toBuildingId } : { street: activity.toStreet as StreetPosition };
  if (activity.kind === 'street') return { street: { segmentId: activity.segmentId, point: activity.wander.points[activity.wander.points.length - 1] as Point } };
  return { building: activity.buildingId };
};
const samePlace = (a: Place, b: Place): boolean => {
  if ('building' in a || 'building' in b) return 'building' in a && 'building' in b && a.building === b.building;
  return a.street.segmentId === b.street.segmentId && distance(a.street.point, b.street.point) <= CLOSE;
};
const name = (place: Place) => ('building' in place ? place.building : `a point on ${place.street.segmentId}`);

export function createOutsiderChecker(inputs: { city: City; layout: Layout; pack: SettingPack; outsiders: Outsiders; seed?: number; hours?: WorkingHours }): OutsiderChecker {
  const { city, layout, pack, outsiders } = inputs;
  const hours = inputs.hours ?? createWorkingHours(inputs);
  const rules = pack.travellers;
  const buildings = new Map(city.buildings.map((building) => [building.id, building]));
  const dwellings = new Set(pack.dwellings.map((type) => type.id));
  const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
  const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
  const exits = new Map(layout.exits.map((exit) => [exit.id, exit]));
  const visits = new Map((rules?.visits ?? []).map((visit) => [visit.id, visit]));
  const kinds = new Map((rules?.kinds ?? []).map((kind) => [kind.id, kind]));
  const openAir = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir).map((building) => building.id));
  const streetReach = pack.visits.streetReach ?? 0;
  /** Nobody outside moves faster than the quickest pace any species has. */
  const pace = Math.max(0, ...Object.values(pack.species).map((species) => species.life.outside?.pace ?? 0));
  /** Whether the town has any street of a kind the pack lets a vagrant sleep on; without one they sleep anywhere. */
  const allowed = rules?.vagrants?.sleepsAt ?? [];
  let hasAllowed: boolean | undefined;
  const townHasAllowed = () =>
    (hasAllowed ??= layout.segments.some((segment) => [segment.points[0] as Point, segment.points[segment.points.length - 1] as Point].some((point) => sleepingPlacesAt(layout, { segmentId: segment.id, point }, streetReach).some((kind) => allowed.includes(kind)))));

  return {
    check(plan) {
      const problems: string[] = [];
      const problem = (text: string) => {
        if (problems.length < MOST_PROBLEMS_LISTED) problems.push(`${plan.personId}, day ${plan.day}: ${text}`);
      };
      const outsider = outsiders.outsider(plan.personId);
      if (!outsider) return [`${plan.personId} is not an outsider of this settlement`];
      if (plan.outsider !== true) problem('the plan is not marked as an outsider\'s');
      const speed = outsiders.speedOf(plan.personId);
      const dayStart = startOfDay(plan.day);
      const dayEnd = dayStart + SECONDS_PER_DAY;
      const { activities } = plan;
      const made = outsider.group === 'traveller' ? (kinds.get(outsider.kindId)?.visits ?? []) : (rules?.vagrants?.visits ?? []);
      const makes = (visitId: string | undefined) => made.some((entry) => entry.visit === visitId);

      // ---- When they are in town at all.
      let from = dayStart;
      let to = dayEnd;
      if (outsider.group === 'traveller') {
        const { arrival, departure } = outsider;
        from = Math.max(dayStart, arrival.time);
        to = Math.min(dayEnd, departure.time);
        const inTown = arrival.time < dayEnd && (departure.time > dayStart || arrival.time >= dayStart);
        if (!inTown) return activities.length === 0 ? problems : [`${plan.personId}, day ${plan.day}: has a plan on a day they are not in town`];
        if (activities.length === 0) return [`${plan.personId}, day ${plan.day}: is in town but has no plan`];
        /** An exit as a place: its junction, on a segment that ends there. */
        const atExit = (place: Place, exitId: string) => {
          const exit = exits.get(exitId);
          const junction = exit && junctions.get(exit.junctionId);
          if (!exit || !junction || junction.kind !== 'exit') return false;
          if (!('street' in place)) return false;
          const segment = segments.get(place.street.segmentId);
          return segment !== undefined && (segment.fromJunctionId === junction.id || segment.toJunctionId === junction.id) && distance(place.street.point, junction.position) <= CLOSE;
        };
        const first = activities[0] as Activity;
        const last = activities[activities.length - 1] as Activity;
        if (arrival.time >= dayStart && (first.kind !== 'travel' || first.departAt !== arrival.time || !atExit(startOf(first), arrival.exitId))) problem(`does not enter by ${arrival.exitId} at ${arrival.time}`);
        if (departure.time <= dayEnd && (last.kind !== 'travel' || last.arriveAt !== departure.time || !atExit(endOf(last), departure.exitId))) problem(`does not leave by ${departure.exitId} at ${departure.time}`);
        if (departure.time < arrival.time) problem('leaves before arriving');
      }
      if (activities.length === 0) return [`${plan.personId}, day ${plan.day}: the plan is empty`];
      if ((activities[0] as Activity).start !== from) problem(`the plan starts at ${(activities[0] as Activity).start}, not at ${from}`);
      if ((activities[activities.length - 1] as Activity).end !== to) problem(`the plan ends at ${(activities[activities.length - 1] as Activity).end}, not at ${to}`);

      /** A wander covers exactly its stay, is no faster than the pace, and keeps to its ground. */
      const checkWander = (at: number, activity: Activity, wander: Wander, where: string, on: (point: Point) => boolean, through: (a: Point, b: Point) => boolean) => {
        const { times, points } = wander;
        if (times.length !== points.length || times.length < 2) return problem(`activity ${at + 1} has a wander without a time for each point`);
        if (times[0] !== activity.start || times[times.length - 1] !== activity.end) problem(`activity ${at + 1} has a wander from ${times[0]} to ${times[times.length - 1]}, not covering the stay from ${activity.start} to ${activity.end}`);
        for (let leg = 0; leg < points.length; leg++) {
          const point = points[leg] as Point;
          if (!on(point)) return problem(`activity ${at + 1} wanders to a point that is not on ${where}`);
          if (leg === 0) continue;
          const before = points[leg - 1] as Point;
          const elapsed = (times[leg] as number) - (times[leg - 1] as number);
          const moved = distance(before, point);
          if (elapsed < 0) problem(`activity ${at + 1} has a wander whose times go back`);
          if (moved > pace * elapsed + CLOSE) return problem(`activity ${at + 1} wanders ${moved.toFixed(2)} m in ${elapsed} s, faster than the pace of ${pace} m/s`);
          if (moved > 0 && through(before, point)) return problem(`activity ${at + 1} wanders off ${where}`);
        }
      };
      const checkStreetWander = (at: number, activity: Activity, wander: Wander, segmentId: string, centre?: Point) => {
        const segment = segments.get(segmentId);
        if (!segment) return problem(`activity ${at + 1} is on ${segmentId}, which does not exist`);
        const origin = centre ?? (wander.points[0] as Point);
        const within = centre ? streetReach : 2 * streetReach;
        const on = (point: Point) => distanceToPolyline(point, segment.points) <= CLOSE && distance(point, origin) <= within + CLOSE;
        checkWander(at, activity, wander, `${segmentId}, within ${within} m`, on, (a, b) => !on([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
      };
      const checkGroundWander = (at: number, activity: Activity, wander: Wander, lot: Lot) => {
        const onGround = (point: Point) => pointInPolygon(point, lot.polygon) && !lot.footprints.some((footprint) => strictlyInside(point, footprint));
        const through = (a: Point, b: Point) =>
          !onGround([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) || [lot.polygon, ...lot.footprints].some((outline) => outline.some((corner, index) => piecesCross(a, b, corner, outline[(index + 1) % outline.length] as Point)));
        checkWander(at, activity, wander, `the open ground of ${lot.buildingId}'s lot`, onGround, through);
      };

      activities.forEach((activity, at) => {
        const previous = activities[at - 1];
        if (activity.end < activity.start) problem(`activity ${at + 1} ends before it starts`);
        if (previous && activity.start !== previous.end) problem(`activity ${at + 1} starts at ${activity.start} but the one before ends at ${previous.end}`);
        if (previous && !samePlace(endOf(previous), startOf(activity))) problem(`activity ${at + 1} begins in ${name(startOf(activity))} but the one before ended in ${name(endOf(previous))}`);
        if (previous?.kind === 'travel' && activity.kind === 'travel') problem(`activity ${at + 1} is a second walk with no stop between`);
        if (activity.kind !== 'sleep' && activity.kind !== 'home' && 'round' in activity && activity.round) problem(`activity ${at + 1} is part of a round, but an outsider has no work`);

        if (activity.kind === 'travel') {
          const begins = startOf(activity);
          const ends = endOf(activity);
          const pointOf = (place: Place): Point | undefined => {
            if ('building' in place) {
              if (!buildings.has(place.building)) problem(`activity ${at + 1} names ${place.building}, which does not exist`);
              return lots.get(place.building)?.entrance.point;
            }
            const segment = segments.get(place.street.segmentId);
            if (!segment) problem(`activity ${at + 1} names ${place.street.segmentId}, which does not exist`);
            else if (distanceToPolyline(place.street.point, segment.points) > CLOSE) problem(`activity ${at + 1} has an end that is not on ${place.street.segmentId}`);
            return segment ? place.street.point : undefined;
          };
          if ('building' in begins && 'building' in ends && begins.building === ends.building) problem(`activity ${at + 1} is a walk from ${begins.building} to itself`);
          if (activity.arriveAt - activity.departAt !== tripDuration(activity.path.length, speed)) {
            problem(`activity ${at + 1} is a walk of ${activity.path.length.toFixed(1)} m taking ${activity.arriveAt - activity.departAt} s, not the ${tripDuration(activity.path.length, speed)} s that ${speed} m/s gives`);
          }
          if (activity.start < activity.departAt || activity.end > activity.arriveAt) problem(`activity ${at + 1} runs outside its own trip`);
          // The walk is on the street graph: its path runs from one end to the other along segments that exist.
          const first = activity.path.points[0];
          const last = activity.path.points[activity.path.points.length - 1];
          const out = pointOf(begins);
          const into = pointOf(ends);
          if (!first || !last || !out || !into || distance(first, out) > CLOSE || distance(last, into) > CLOSE) problem(`activity ${at + 1} has a path that does not run from ${name(begins)} to ${name(ends)}`);
          if (activity.path.segmentIds.length === 0 || activity.path.segmentIds.some((id) => !segments.has(id))) problem(`activity ${at + 1} walks a segment that does not exist`);
          if (Math.abs(activity.path.walked.reduce((sum, part) => sum + part, 0) - activity.path.length) > CLOSE) problem(`activity ${at + 1} has a path whose parts do not add up to its length`);
          return;
        }
        if (activity.end === activity.start) problem(`activity ${at + 1} is a stay of no length`);

        if (activity.kind === 'street') {
          if (activity.purpose === 'work') return problem(`activity ${at + 1} is work, but an outsider has none`);
          if (activity.purpose === 'visit') {
            const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
            if (!visit?.stroll) problem(`activity ${at + 1} is a pause on a street for the visit "${activity.visitId}", which is not a stroll`);
            else if (!makes(visit.id)) problem(`activity ${at + 1} is a "${visit.id}" stroll, which this outsider does not make`);
            checkStreetWander(at, activity, activity.wander, activity.segmentId);
            return;
          }
          // Asleep or awake at the place where they sleep: a vagrant, standing still, at a place of a kind the pack allows.
          if (outsider.group !== 'vagrant') return problem(`activity ${at + 1} is ${activity.purpose} on a street, but a traveller lodges or passes through`);
          if (activity.visitId !== undefined) problem(`activity ${at + 1} is ${activity.purpose} but names a visit`);
          const spot = activity.wander.points[0] as Point;
          if (activity.wander.points.some((point) => distance(point, spot) > CLOSE)) problem(`activity ${at + 1} is ${activity.purpose} on a street but does not stand still`);
          if (activity.wander.times[0] !== activity.start || activity.wander.times[activity.wander.times.length - 1] !== activity.end) problem(`activity ${at + 1} has a wander that does not cover the stay`);
          const segment = segments.get(activity.segmentId);
          if (!segment || distanceToPolyline(spot, segment.points) > CLOSE) problem(`activity ${at + 1} is not at a point of ${activity.segmentId}`);
          else if (townHasAllowed() && !sleepingPlacesAt(layout, { segmentId: activity.segmentId, point: spot }, streetReach).some((kind) => allowed.includes(kind))) {
            problem(`activity ${at + 1} is ${activity.purpose} on ${activity.segmentId}, which is not a place of a kind the pack allows (${allowed.join(', ')})`);
          }
          return;
        }

        const building = buildings.get(activity.buildingId);
        if (!building) return problem(`activity ${at + 1} is in ${activity.buildingId}, which does not exist`);
        if (activity.kind === 'work') return problem(`activity ${at + 1} is work, but an outsider has none`);
        if (activity.kind === 'sleep' || activity.kind === 'home') {
          if (outsider.group !== 'traveller' || outsider.lodgingId !== activity.buildingId) problem(`activity ${at + 1} is ${activity.kind} in ${activity.buildingId}, which is not where they lodge`);
          if (activity.visitId !== undefined) problem(`activity ${at + 1} is ${activity.kind} but names a visit`);
          if (activity.outside || activity.wander || activity.onStreet) problem(`activity ${at + 1} is ${activity.kind} but is marked outside`);
          return;
        }
        // A visit: one this outsider makes, to a building of a type it allows, open on arrival and left by closing time.
        const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
        if (!visit) return problem(`activity ${at + 1} is a visit of the kind "${activity.visitId}", which the pack's travellers file does not define`);
        if (!makes(visit.id)) problem(`activity ${at + 1} is a "${visit.id}" visit, which this outsider does not make`);
        const types = visit.stroll ? (visit.stroll.favour ?? []) : outsiderStopsOf(visit).flatMap((stop) => stop.destinations);
        if (!types.includes(building.type)) problem(`activity ${at + 1} is a "${visit.id}" visit to a ${building.type}, which that visit does not allow`);
        if (pack.visits.openingHours) {
          const closes = hours.openUntil(activity.buildingId, activity.start);
          if (closes === undefined) problem(`activity ${at + 1} is a "${visit.id}" visit to ${activity.buildingId}, which is closed at ${activity.start}`);
          else if (activity.end > closes) problem(`activity ${at + 1} is a "${visit.id}" visit to ${activity.buildingId} that runs past its closing at ${closes}`);
        }
        const shouldBeOutside = openAir.has(activity.buildingId) || visit.outside === true;
        if ((activity.outside === true) !== shouldBeOutside) problem(`activity ${at + 1} is ${activity.outside ? 'outside' : 'inside'} at ${activity.buildingId}, but should be ${shouldBeOutside ? 'outside' : 'inside'}`);
        const shouldBeInFront = shouldBeOutside && visit.where === 'street';
        if ((activity.onStreet === true) !== shouldBeInFront) problem(`activity ${at + 1} is ${activity.onStreet ? 'out on the street' : 'on the lot'} at ${activity.buildingId}, but should be ${shouldBeInFront ? 'out on the street' : 'on the lot'}`);
        if ((activity.wander !== undefined) !== (activity.outside === true)) problem(`activity ${at + 1} must have a wander exactly when it is outside`);
        const lot = lots.get(activity.buildingId);
        if (activity.wander && lot) {
          if (activity.onStreet) checkStreetWander(at, activity, activity.wander, lot.entrance.segmentId, lot.entrance.point);
          else checkGroundWander(at, activity, activity.wander, lot);
        }
        // Someone with no dwelling is never indoors, and never at a dwelling at all.
        if (outsider.group === 'vagrant' && (!activity.onStreet || dwellings.has(building.type))) problem(`activity ${at + 1} has a vagrant ${activity.onStreet ? 'at' : 'inside'} ${activity.buildingId}, a ${building.type}`);
      });
      return problems;
    },

    checkContinuity(earlier, later) {
      const last = earlier.activities[earlier.activities.length - 1];
      const first = later.activities[0];
      const boundary = startOfDay(later.day);
      if (!last || !first) {
        // A day with no plan beside one with a plan: the traveller arrived after the boundary, or had left by it.
        const outsider = outsiders.outsider(earlier.personId);
        if (!outsider || outsider.group !== 'traveller') return [`${earlier.personId}: a plan is empty`];
        if (first && outsider.arrival.time < boundary) return [`${earlier.personId}: arrived at ${outsider.arrival.time} but has no plan before day ${later.day}`];
        if (last && outsider.departure.time > boundary) return [`${earlier.personId}: leaves at ${outsider.departure.time} but has no plan on day ${later.day}`];
        return [];
      }
      let same: boolean;
      if (last.kind === 'travel' && first.kind === 'travel') same = last.departAt === first.departAt && samePlace(endOf(last), endOf(first));
      else if (last.kind === 'travel') same = last.arriveAt === boundary && samePlace(endOf(last), startOf(first));
      else if (first.kind === 'travel') same = first.departAt === boundary && samePlace(endOf(last), startOf(first));
      else {
        const leftAt = last.wander?.points[last.wander.points.length - 1];
        const foundAt = first.wander?.points[0];
        same = last.end === boundary && first.start === boundary && samePlace(endOf(last), startOf(first)) && (leftAt === undefined) === (foundAt === undefined) && (leftAt === undefined || distance(leftAt, foundAt as Point) <= CLOSE);
      }
      return same ? [] : [`${earlier.personId}: day ${earlier.day} ends in ${name(endOf(last))} but day ${later.day} starts in ${name(startOf(first))}`];
    },
  };
}
