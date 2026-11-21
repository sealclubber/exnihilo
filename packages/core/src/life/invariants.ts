/**
 * The rules every day plan must satisfy. Returns one line per broken rule; an
 * empty list means the plan is sound.
 */
import type { City } from '../city/records.ts';
import { distance, piecesCross, pointInPolygon, strictlyInside } from '../layout/geometry.ts';
import type { Layout } from '../layout/records.ts';
import { type SettingPack, type Species, HOME, placeFlagsOf, shiftLength } from '../pack/schema.ts';
import { SECONDS_PER_DAY, startOfDay } from './calendar.ts';
import { createWorkingHours } from './hours.ts';
import { tripDuration, walkingSpeed } from './life.ts';
import type { Activity, DayPlan } from './records.ts';

const MOST_PROBLEMS_LISTED = 10;
/** Entrance points are compared to the nearest millimetre. */
const CLOSE = 1e-3;

export interface PlanChecker {
  /** One line per rule a plan breaks. */
  check(plan: DayPlan): string[];
  /** One line if a person is not in the same place at the end of one day and the start of the next. */
  checkContinuity(earlier: DayPlan, later: DayPlan): string[];
}

const describe = (activity: Activity) => (activity.kind === 'travel' ? `walking to ${activity.toBuildingId}` : `${activity.kind} in ${activity.buildingId}`);

export function createPlanChecker(inputs: { city: City; layout: Layout; pack: SettingPack; seed?: number }): PlanChecker {
  const { city, layout, pack } = inputs;
  const hours = createWorkingHours(inputs);
  const personIndex = new Map(city.people.map((person, index) => [person.id, index]));
  const openAir = new Set(city.buildings.filter((building) => placeFlagsOf(building.type, pack).openAir).map((building) => building.id));
  const people = new Map(city.people.map((person) => [person.id, person]));
  const buildings = new Map(city.buildings.map((building) => [building.id, building]));
  const homes = new Map(city.households.map((household) => [household.id, household.dwellingId]));
  const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
  const segments = new Set(layout.segments.map((segment) => segment.id));
  const visits = new Map(pack.visits.visits.map((visit) => [visit.id, visit]));

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
      const { personalMinutes, dailyMinutes } = (pack.species[person.species] as Species).life.variation;
      /** How far from the shift's own hours a worker's habit and the day's variation can take them. */
      const slack = (personalMinutes + dailyMinutes) * 60;

      // The plan covers the whole day with no gaps and no overlaps.
      if (activities.length === 0) return [`${plan.personId}, day ${plan.day}: the plan is empty`];
      if ((activities[0] as Activity).start !== dayStart) problem(`the plan starts at ${(activities[0] as Activity).start}, not at midnight`);
      if ((activities[activities.length - 1] as Activity).end !== dayEnd) problem('the plan does not run to midnight');

      activities.forEach((activity, at) => {
        const previous = activities[at - 1];
        if (activity.end < activity.start) problem(`activity ${at + 1} ends before it starts`);
        if (previous && activity.start !== previous.end) {
          problem(`activity ${at + 1} starts at ${activity.start} but the one before ends at ${previous.end}`);
        }
        // Each activity begins where the previous one ended.
        const from = activity.kind === 'travel' ? activity.fromBuildingId : activity.buildingId;
        const before = previous === undefined ? undefined : previous.kind === 'travel' ? previous.toBuildingId : previous.buildingId;
        if (before !== undefined && from !== before) problem(`activity ${at + 1} begins in ${from} but the one before ended in ${before}`);
        if (previous?.kind === 'travel' && activity.kind === 'travel') problem(`activity ${at + 1} is a second walk with no stop between`);

        if (activity.kind === 'travel') {
          for (const id of [activity.fromBuildingId, activity.toBuildingId]) {
            if (!buildings.has(id)) problem(`activity ${at + 1} names ${id}, which does not exist`);
          }
          if (activity.fromBuildingId === activity.toBuildingId) problem(`activity ${at + 1} is a walk from ${activity.fromBuildingId} to itself`);
          // A trip takes its path's length divided by the person's walking speed.
          if (activity.arriveAt - activity.departAt !== tripDuration(activity.path.length, speed)) {
            problem(`activity ${at + 1} is a walk of ${activity.path.length.toFixed(1)} m taking ${activity.arriveAt - activity.departAt} s, not the ${tripDuration(activity.path.length, speed)} s that ${speed} m/s gives`);
          }
          if (activity.start < activity.departAt || activity.end > activity.arriveAt) problem(`activity ${at + 1} runs outside its own trip`);
          // The path runs from one building's entrance to the other's, along segments that exist.
          const first = activity.path.points[0];
          const last = activity.path.points[activity.path.points.length - 1];
          const out = lots.get(activity.fromBuildingId)?.entrance.point;
          const into = lots.get(activity.toBuildingId)?.entrance.point;
          if (!first || !last || !out || !into || distance(first, out) > CLOSE || distance(last, into) > CLOSE) {
            problem(`activity ${at + 1} has a path that does not run from the entrance of ${activity.fromBuildingId} to that of ${activity.toBuildingId}`);
          }
          if (activity.path.segmentIds.some((id) => !segments.has(id))) problem(`activity ${at + 1} walks a segment that does not exist`);
          if (Math.abs(activity.path.walked.reduce((sum, part) => sum + part, 0) - activity.path.length) > CLOSE) {
            problem(`activity ${at + 1} has a path whose parts do not add up to its length`);
          }
          return;
        }

        const building = buildings.get(activity.buildingId);
        if (!building) return problem(`activity ${at + 1} is in ${activity.buildingId}, which does not exist`);
        if ((activity.kind === 'sleep' || activity.kind === 'home') && activity.buildingId !== home) {
          problem(`activity ${at + 1} is ${activity.kind} in ${activity.buildingId}, which is not the person's home ${home}`);
        }
        // Work happens only at the person's own workplace, and only for people in the workforce.
        if (activity.kind === 'work') {
          if (person.workforceState !== 'working') problem(`activity ${at + 1} is work, but the person is not in the workforce`);
          else if (activity.buildingId !== person.workplaceId) problem(`activity ${at + 1} is work in ${activity.buildingId}, not the person's workplace ${person.workplaceId}`);
          // Work is done in the hours of the person's own shift, the same shift every day, and not before it starts.
          if (!shift) problem(`activity ${at + 1} is work, but the person has no shift`);
          else if (![plan.day - 1, plan.day].some((day) => activity.start >= startOfDay(day) + shift.start - slack && activity.end <= startOfDay(day) + shift.start + shiftLength(shift) + slack)) {
            problem(`activity ${at + 1} is work outside the hours of the person's shift, "${shift.id}"`);
          }
        }
        // Every visit goes to a building type that visit allows.
        if (activity.kind === 'visit') {
          const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
          if (!visit) problem(`activity ${at + 1} is a visit of the kind "${activity.visitId}", which the pack does not define`);
          else {
            const atHome = activity.buildingId === home;
            if (atHome ? !visit.destinations.includes(HOME) : !visit.destinations.includes(building.type)) {
              problem(`activity ${at + 1} is a "${visit.id}" visit to ${atHome ? "the person's own home" : `a ${building.type}`}, which that visit does not allow`);
            }
            // A visit to the person's own home involves no travel: it is neither walked to nor walked away from.
            const next = activities[at + 1];
            if (atHome && (previous?.kind === 'travel' || next?.kind === 'travel') && visit.destinations.every((type) => type === HOME)) {
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
        const visitOutside = activity.kind === 'visit' && activity.visitId !== undefined && visits.get(activity.visitId)?.outside === true;
        const shouldBeOutside = (activity.kind === 'work' || activity.kind === 'visit') && (openAir.has(activity.buildingId) || visitOutside);
        if ((activity.outside === true) !== shouldBeOutside) {
          problem(`activity ${at + 1} is ${activity.outside ? 'outside' : 'inside'} at ${activity.buildingId}, but should be ${shouldBeOutside ? 'outside' : 'inside'}`);
        }
        // An outside stay has a wander: it covers exactly the stay, keeps to the lot's open ground, and is no faster than the pack's pace.
        if ((activity.wander !== undefined) !== (activity.outside === true)) problem(`activity ${at + 1} must have a wander exactly when it is outside`);
        const lot = lots.get(activity.buildingId);
        if (activity.wander && lot) {
          const { times, points } = activity.wander;
          const pace = (pack.species[person.species] as Species).life.outside?.pace ?? 0;
          const onGround = (point: [number, number]) => pointInPolygon(point, lot.polygon) && !lot.footprints.some((footprint) => strictlyInside(point, footprint));
          if (times.length !== points.length || times.length < 2) problem(`activity ${at + 1} has a wander without a time for each point`);
          else if (times[0] !== activity.start || times[times.length - 1] !== activity.end) {
            problem(`activity ${at + 1} has a wander from ${times[0]} to ${times[times.length - 1]}, not covering the stay from ${activity.start} to ${activity.end}`);
          }
          for (let leg = 0; leg < points.length; leg++) {
            const point = points[leg] as [number, number];
            if (!onGround(point)) {
              problem(`activity ${at + 1} wanders to a point that is not on the open ground of ${activity.buildingId}'s lot`);
              break;
            }
            if (leg === 0) continue;
            const before = points[leg - 1] as [number, number];
            const elapsed = (times[leg] as number) - (times[leg - 1] as number);
            const moved = distance(before, point);
            if (elapsed < 0) problem(`activity ${at + 1} has a wander whose times go back`);
            if (moved > pace * elapsed + CLOSE) {
              problem(`activity ${at + 1} wanders ${moved.toFixed(2)} m in ${elapsed} s, faster than the pace of ${pace} m/s`);
              break;
            }
            // No leg passes through a footprint or leaves the lot.
            const middle: [number, number] = [(before[0] + point[0]) / 2, (before[1] + point[1]) / 2];
            const crosses = [lot.polygon, ...lot.footprints].some((outline) => outline.some((corner, index) => piecesCross(before, point, corner, outline[(index + 1) % outline.length] as [number, number])));
            if (moved > 0 && (crosses || !onGround(middle))) {
              problem(`activity ${at + 1} wanders through a footprint or off the lot of ${activity.buildingId}`);
              break;
            }
          }
        }
        if (activity.end === activity.start) problem(`activity ${at + 1} is a stay of no length`);
      });
      return problems;
    },

    checkContinuity(earlier, later) {
      const last = earlier.activities[earlier.activities.length - 1];
      const first = later.activities[0];
      if (!last || !first) return [`${earlier.personId}: a plan is empty`];
      // The same place either side of midnight: one building, or one walk. A walk that ends or
      // begins exactly at midnight meets the building it ends or begins at.
      const boundary = startOfDay(later.day);
      let same: boolean;
      if (last.kind === 'travel' && first.kind === 'travel') same = last.departAt === first.departAt && last.toBuildingId === first.toBuildingId;
      else if (last.kind === 'travel') same = first.kind !== 'travel' && last.arriveAt === boundary && last.toBuildingId === first.buildingId;
      else if (first.kind === 'travel') same = first.departAt === boundary && first.fromBuildingId === last.buildingId;
      // Someone outside either side of midnight is at the same point: one wander ends where the next begins.
      else {
        const leftAt = last.wander?.points[last.wander.points.length - 1];
        const foundAt = first.wander?.points[0];
        same = last.buildingId === first.buildingId && leftAt?.[0] === foundAt?.[0] && leftAt?.[1] === foundAt?.[1];
      }
      return same ? [] : [`${earlier.personId}: day ${earlier.day} ends ${describe(last)} but day ${later.day} starts ${describe(first)}`];
    },
  };
}
