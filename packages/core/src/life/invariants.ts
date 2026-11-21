/**
 * The rules every day plan must satisfy. Returns one line per broken rule; an
 * empty list means the plan is sound.
 */
import type { City } from '../city/records.ts';
import { distance, distanceToPolyline, piecesCross, pointInPolygon, strictlyInside } from '../layout/geometry.ts';
import type { Layout, Lot, StreetPosition } from '../layout/records.ts';
import { type Round, type SettingPack, type Species, HOME, allOccupations, placeFlagsOf, shiftLength, stopsOf } from '../pack/schema.ts';
import type { Point } from '../schema.ts';
import { SECONDS_PER_DAY, startOfDay } from './calendar.ts';
import { createWorkingHours } from './hours.ts';
import { tripDuration, walkingSpeed } from './life.ts';
import type { Activity, DayPlan, Wander } from './records.ts';

const MOST_PROBLEMS_LISTED = 10;
/** Points are compared to the nearest millimetre. */
const CLOSE = 1e-3;

export interface PlanChecker {
  /** One line per rule a plan breaks. */
  check(plan: DayPlan): string[];
  /** One line if a person is not in the same place at the end of one day and the start of the next. */
  checkContinuity(earlier: DayPlan, later: DayPlan): string[];
}

/** Where someone is at one end of an activity: in a building, or at a point on a street. */
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
const describe = (activity: Activity) =>
  activity.kind === 'travel' ? `walking to ${name(endOf(activity))}` : activity.kind === 'street' ? `on the street at ${activity.segmentId}` : `${activity.kind} in ${activity.buildingId}`;

export function createPlanChecker(inputs: { city: City; layout: Layout; pack: SettingPack; seed?: number }): PlanChecker {
  const { city, layout, pack } = inputs;
  const hours = createWorkingHours(inputs);
  const personIndex = new Map(city.people.map((person, index) => [person.id, index]));
  const openAir = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir).map((building) => building.id));
  const people = new Map(city.people.map((person) => [person.id, person]));
  const buildings = new Map(city.buildings.map((building) => [building.id, building]));
  const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
  const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
  const visits = new Map(pack.visits.visits.map((visit) => [visit.id, visit]));
  const rounds = new Map(allOccupations(pack).flatMap((occupation) => (occupation.round === undefined ? [] : [[occupation.id, pack.rounds[occupation.round] as Round] as const])));
  const streetReach = pack.visits.streetReach ?? 0;

  return {
    check(plan) {
      const problems: string[] = [];
      const problem = (text: string) => {
        if (problems.length < MOST_PROBLEMS_LISTED) problems.push(`${plan.personId}, day ${plan.day}: ${text}`);
      };
      const person = people.get(plan.personId);
      if (!person) return [`${plan.personId} is not a resident`];
      const home = homes.get(person.householdId);
      const speed = walkingSpeed(person, pack);
      const dayStart = startOfDay(plan.day);
      const dayEnd = dayStart + SECONDS_PER_DAY;
      const { activities } = plan;
      const shift = hours.shiftOf(personIndex.get(plan.personId) as number);
      const round = person.occupationId === undefined ? undefined : rounds.get(person.occupationId);
      const { personalMinutes, dailyMinutes } = (pack.species[person.species] as Species).life.variation;
      /** How far from the shift's own hours a worker's habit and the day's variation can take them. */
      const slack = (personalMinutes + dailyMinutes) * 60;
      const pace = (pack.species[person.species] as Species).life.outside?.pace ?? 0;
      const inShift = (activity: Activity) =>
        shift !== undefined &&
        [plan.day - 1, plan.day].some((day) => activity.start >= startOfDay(day) + shift.start - slack && activity.end <= startOfDay(day) + shift.start + shiftLength(shift) + slack);

      // The plan covers the whole day with no gaps and no overlaps.
      if (activities.length === 0) return [`${plan.personId}, day ${plan.day}: the plan is empty`];
      if ((activities[0] as Activity).start !== dayStart) problem(`the plan starts at ${(activities[0] as Activity).start}, not at midnight`);
      if ((activities[activities.length - 1] as Activity).end !== dayEnd) problem('the plan does not run to midnight');

      /** A wander covers exactly its stay, is no faster than the pack's pace, and keeps to its ground: `on` says whether a point does, `through` whether a move leaves it. */
      const checkWander = (at: number, activity: Activity, wander: Wander, where: string, on: (point: Point) => boolean, through: (from: Point, to: Point) => boolean) => {
        const { times, points } = wander;
        if (times.length !== points.length || times.length < 2) return problem(`activity ${at + 1} has a wander without a time for each point`);
        if (times[0] !== activity.start || times[times.length - 1] !== activity.end) {
          problem(`activity ${at + 1} has a wander from ${times[0]} to ${times[times.length - 1]}, not covering the stay from ${activity.start} to ${activity.end}`);
        }
        for (let leg = 0; leg < points.length; leg++) {
          const point = points[leg] as Point;
          if (!on(point)) return problem(`activity ${at + 1} wanders to a point that is not on ${where}`);
          if (leg === 0) continue;
          const before = points[leg - 1] as Point;
          const elapsed = (times[leg] as number) - (times[leg - 1] as number);
          const moved = distance(before, point);
          if (elapsed < 0) problem(`activity ${at + 1} has a wander whose times go back`);
          if (moved > pace * elapsed + CLOSE) return problem(`activity ${at + 1} wanders ${moved.toFixed(2)} m in ${elapsed} s, faster than the pace of ${pace} m/s`);
          if (moved > 0 && through(before, point)) return problem(`activity ${at + 1} wanders through a footprint or off ${where}`);
        }
      };
      /** A wander on a stretch of street: every point on the segment, within the pack's reach of where it centres. */
      const checkStreetWander = (at: number, activity: Activity, wander: Wander, segmentId: string, centre: Point) => {
        const segment = segments.get(segmentId);
        if (!segment) return problem(`activity ${at + 1} is on ${segmentId}, which does not exist`);
        const on = (point: Point) => distanceToPolyline(point, segment.points) <= CLOSE && distance(point, centre) <= streetReach + CLOSE;
        const middle = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        checkWander(at, activity, wander, `${segmentId}, within ${streetReach} m of where it stops`, on, (a, b) => !on(middle(a, b)));
      };
      const checkGroundWander = (at: number, activity: Activity, wander: Wander, lot: Lot) => {
        const onGround = (point: Point) => pointInPolygon(point, lot.polygon) && !lot.footprints.some((footprint) => strictlyInside(point, footprint));
        const through = (a: Point, b: Point) =>
          !onGround([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) || [lot.polygon, ...lot.footprints].some((outline) => outline.some((corner, index) => piecesCross(a, b, corner, outline[(index + 1) % outline.length] as Point)));
        checkWander(at, activity, wander, `the open ground of ${lot.buildingId}'s lot`, onGround, through);
      };
      /** A round leg or stop lies between two spells of work at the worker's own workplace, as far as this day's plan shows. */
      const checkOnRound = (at: number, activity: Activity) => {
        if (person.workforceState !== 'working' || person.workplaceId === undefined) return problem(`activity ${at + 1} is part of a round, but the person has no work`);
        if (!round) return problem(`activity ${at + 1} is part of a round, but the person's occupation has none`);
        if (!inShift(activity)) problem(`activity ${at + 1} is part of a round outside the hours of the person's shift`);
        const partOfRound = (other: Activity) => other.kind !== 'sleep' && other.kind !== 'home' && 'round' in other && other.round === true;
        for (const step of [-1, 1]) {
          let other = at + step;
          while (activities[other] && partOfRound(activities[other] as Activity)) other += step;
          const beyond = activities[other];
          // Past midnight the rest of the round is in the next day's plan, or the day before's.
          if (!beyond) continue;
          if (beyond.kind !== 'work' || beyond.buildingId !== person.workplaceId) {
            problem(`activity ${at + 1} is part of a round that does not ${step < 0 ? 'start' : 'end'} at the person's workplace ${person.workplaceId}`);
          }
        }
      };
      /** The last stop of a chain reached, by visit, for checking that stops come in order. */
      let chain: { visitId: string; stop: number; at: number } | undefined;

      activities.forEach((activity, at) => {
        const previous = activities[at - 1];
        const next = activities[at + 1];
        if (activity.end < activity.start) problem(`activity ${at + 1} ends before it starts`);
        if (previous && activity.start !== previous.end) {
          problem(`activity ${at + 1} starts at ${activity.start} but the one before ends at ${previous.end}`);
        }
        // Each activity begins where the previous one ended.
        if (previous && !samePlace(endOf(previous), startOf(activity))) problem(`activity ${at + 1} begins in ${name(startOf(activity))} but the one before ended in ${name(endOf(previous))}`);
        if (previous?.kind === 'travel' && activity.kind === 'travel') problem(`activity ${at + 1} is a second walk with no stop between`);

        if (activity.kind === 'travel') {
          const from = startOf(activity);
          const to = endOf(activity);
          if ((activity.fromBuildingId === undefined) === (activity.fromStreet === undefined) || (activity.toBuildingId === undefined) === (activity.toStreet === undefined)) {
            problem(`activity ${at + 1} is a walk whose ends are not each a building or a street position`);
          }
          /** Where on the map an end of the walk is, if it is somewhere that exists. */
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
          if ('building' in from && 'building' in to && from.building === to.building) problem(`activity ${at + 1} is a walk from ${from.building} to itself`);
          // A trip takes its path's length divided by the person's walking speed.
          if (activity.arriveAt - activity.departAt !== tripDuration(activity.path.length, speed)) {
            problem(`activity ${at + 1} is a walk of ${activity.path.length.toFixed(1)} m taking ${activity.arriveAt - activity.departAt} s, not the ${tripDuration(activity.path.length, speed)} s that ${speed} m/s gives`);
          }
          if (activity.start < activity.departAt || activity.end > activity.arriveAt) problem(`activity ${at + 1} runs outside its own trip`);
          // The path runs from one end to the other, along segments that exist.
          const first = activity.path.points[0];
          const last = activity.path.points[activity.path.points.length - 1];
          const out = pointOf(from);
          const into = pointOf(to);
          if (!first || !last || !out || !into || distance(first, out) > CLOSE || distance(last, into) > CLOSE) {
            problem(`activity ${at + 1} has a path that does not run from the entrance of ${name(from)} to that of ${name(to)}`);
          }
          if (activity.path.segmentIds.some((id) => !segments.has(id))) problem(`activity ${at + 1} walks a segment that does not exist`);
          if (Math.abs(activity.path.walked.reduce((sum, part) => sum + part, 0) - activity.path.length) > CLOSE) {
            problem(`activity ${at + 1} has a path whose parts do not add up to its length`);
          }
          if (activity.round) checkOnRound(at, activity);
          return;
        }

        if (activity.kind === 'street') {
          // A stop on a street: a point on the segment it names, and a wander about a short stretch of it.
          checkStreetWander(at, activity, activity.wander, activity.segmentId, activity.wander.points[0] as Point);
          if (activity.end === activity.start) problem(`activity ${at + 1} is a stop of no length`);
          if (activity.purpose === 'work') {
            if (!activity.round) problem(`activity ${at + 1} is work on a street but is not marked as part of a round`);
            else if (round && round.at !== 'street') problem(`activity ${at + 1} is a stop on a street, but the person's round stops at buildings`);
            checkOnRound(at, activity);
            if (activity.visitId !== undefined) problem(`activity ${at + 1} is work but names a visit`);
          } else {
            const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
            if (!visit?.stroll) problem(`activity ${at + 1} is a pause on a street for the visit "${activity.visitId}", which is not a stroll`);
            // A stroll starts and ends at home.
            if (previous && (previous.kind !== 'travel' || previous.fromBuildingId !== home)) problem(`activity ${at + 1} is a pause on a stroll that did not start from home`);
            if (next && (next.kind !== 'travel' || next.toBuildingId !== home)) problem(`activity ${at + 1} is a pause on a stroll that does not go home`);
          }
          return;
        }

        const building = buildings.get(activity.buildingId);
        if (!building) return problem(`activity ${at + 1} is in ${activity.buildingId}, which does not exist`);
        if ((activity.kind === 'sleep' || activity.kind === 'home') && activity.buildingId !== home) {
          problem(`activity ${at + 1} is ${activity.kind} in ${activity.buildingId}, which is not the person's home ${home}`);
        }
        // Work happens only at the person's own workplace or on a round from it, and only for people in the workforce.
        if (activity.kind === 'work') {
          if (person.workforceState !== 'working') problem(`activity ${at + 1} is work, but the person is not in the workforce`);
          else if (activity.round) {
            // A stop on a round: a building of a type the round stops at, within its range.
            if (round && (round.at === 'street' || !round.at.includes(building.type))) problem(`activity ${at + 1} is a stop on a round at a ${building.type}, which the round does not stop at`);
            else if (round?.range === 'district' && building.districtId !== buildings.get(person.workplaceId ?? '')?.districtId) problem(`activity ${at + 1} is a stop on a round outside the workplace's district`);
            checkOnRound(at, activity);
          } else if (activity.buildingId !== person.workplaceId) problem(`activity ${at + 1} is work in ${activity.buildingId}, not the person's workplace ${person.workplaceId}`);
          // Work is done in the hours of the person's own shift, the same shift every day, and not before it starts.
          if (!shift) problem(`activity ${at + 1} is work, but the person has no shift`);
          else if (!inShift(activity)) problem(`activity ${at + 1} is work outside the hours of the person's shift, "${shift.id}"`);
        } else if (activity.round) {
          problem(`activity ${at + 1} is ${activity.kind} but is marked as part of a round`);
        }
        // Every visit goes to a building type that visit allows.
        if (activity.kind === 'visit') {
          const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
          if (!visit) problem(`activity ${at + 1} is a visit of the kind "${activity.visitId}", which the pack does not define`);
          else {
            const atHome = activity.buildingId === home;
            const stops = stopsOf(visit);
            const allows = (types: readonly string[]) => (atHome ? types.includes(HOME) : types.includes(building.type));
            if (visit.stroll) {
              // A stroll by way of a public place: one it favours, walked to from home and left for home.
              if (!(visit.stroll.favour ?? []).includes(building.type)) problem(`activity ${at + 1} is a "${visit.id}" stroll by way of a ${building.type}, which it does not favour`);
              if (previous && (previous.kind !== 'travel' || previous.fromBuildingId !== home)) problem(`activity ${at + 1} is a stop on a stroll that did not start from home`);
              if (next && (next.kind !== 'travel' || next.toBuildingId !== home)) problem(`activity ${at + 1} is a stop on a stroll that does not go home`);
            } else if (!stops.some((stop) => allows(stop.destinations))) {
              problem(`activity ${at + 1} is a "${visit.id}" visit to ${atHome ? "the person's own home" : `a ${building.type}`}, which that visit does not allow`);
            } else if (stops.length > 1) {
              // A chain's stops are visited in order: this one comes later in the list than the one before it on the same outing.
              const continues = chain !== undefined && chain.visitId === visit.id && chain.at === at - 2 && previous?.kind === 'travel';
              const found = stops.findIndex((stop, index) => (!continues || index > (chain as { stop: number }).stop) && allows(stop.destinations));
              if (found === -1) problem(`activity ${at + 1} is a stop of the "${visit.id}" errand out of its order`);
              chain = { visitId: visit.id, stop: found, at };
            }
            // A visit to the person's own home involves no travel: it is neither walked to nor walked away from.
            if (atHome && (previous?.kind === 'travel' || next?.kind === 'travel') && stops.every((stop) => stop.destinations.every((type) => type === HOME))) {
              problem(`activity ${at + 1} is a "${visit.id}" visit at home with a walk beside it`);
            }
            // The place is open when the visitor arrives, and the visit ends by closing time.
            if (pack.visits.openingHours && !atHome) {
              // A visit that began before midnight arrived when it began, which the earlier day's plan checks.
              const closes = hours.openUntil(activity.buildingId, activity.start);
              if (closes === undefined) problem(`activity ${at + 1} is a "${visit.id}" visit to ${activity.buildingId}, which is closed at ${activity.start}`);
              else if (activity.end > closes) problem(`activity ${at + 1} is a "${visit.id}" visit to ${activity.buildingId} that runs past its closing at ${closes}`);
            }
          }
        } else if (activity.visitId !== undefined) {
          problem(`activity ${at + 1} is ${activity.kind} but names a visit`);
        }
        // A stay is outside exactly when its building type is open-air or its visit is marked outside; sleep and time at home are indoors.
        const visit = activity.kind === 'visit' && activity.visitId !== undefined ? visits.get(activity.visitId) : undefined;
        const shouldBeOutside = (activity.kind === 'work' || activity.kind === 'visit') && (openAir.has(activity.buildingId) || visit?.outside === true);
        if ((activity.outside === true) !== shouldBeOutside) {
          problem(`activity ${at + 1} is ${activity.outside ? 'outside' : 'inside'} at ${activity.buildingId}, but should be ${shouldBeOutside ? 'outside' : 'inside'}`);
        }
        // Out on the street in front of the building exactly when the visit says so.
        const shouldBeInFront = shouldBeOutside && visit?.where === 'street';
        if ((activity.onStreet === true) !== shouldBeInFront) {
          problem(`activity ${at + 1} is ${activity.onStreet ? 'out on the street' : 'on the lot'} at ${activity.buildingId}, but should be ${shouldBeInFront ? 'out on the street' : 'on the lot'}`);
        }
        // An outside stay has a wander, on the lot's open ground or on the street by its entrance.
        if ((activity.wander !== undefined) !== (activity.outside === true)) problem(`activity ${at + 1} must have a wander exactly when it is outside`);
        const lot = lots.get(activity.buildingId);
        if (activity.wander && lot) {
          if (activity.onStreet) checkStreetWander(at, activity, activity.wander, lot.entrance.segmentId, lot.entrance.point);
          else checkGroundWander(at, activity, activity.wander, lot);
        }
        if (activity.end === activity.start) problem(`activity ${at + 1} is a stay of no length`);
      });
      return problems;
    },

    checkContinuity(earlier, later) {
      const last = earlier.activities[earlier.activities.length - 1];
      const first = later.activities[0];
      if (!last || !first) return [`${earlier.personId}: a plan is empty`];
      // The same place either side of midnight: one building, one point on a street, or one walk. A walk that
      // ends or begins exactly at midnight meets the place it ends or begins at.
      const boundary = startOfDay(later.day);
      let same: boolean;
      if (last.kind === 'travel' && first.kind === 'travel') same = last.departAt === first.departAt && samePlace(endOf(last), endOf(first));
      else if (last.kind === 'travel') same = last.arriveAt === boundary && samePlace(endOf(last), startOf(first));
      else if (first.kind === 'travel') same = first.departAt === boundary && samePlace(endOf(last), startOf(first));
      else {
        // Someone outside either side of midnight is at the same point: one wander ends where the next begins.
        const leftAt = last.wander?.points[last.wander.points.length - 1];
        const foundAt = first.wander?.points[0];
        same = samePlace(endOf(last), startOf(first)) && (leftAt === undefined) === (foundAt === undefined) && (leftAt === undefined || distance(leftAt, foundAt as Point) <= CLOSE);
      }
      return same ? [] : [`${earlier.personId}: day ${earlier.day} ends ${describe(last)} but day ${later.day} starts ${describe(first)}`];
    },
  };
}
