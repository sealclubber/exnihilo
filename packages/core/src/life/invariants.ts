/**
 * The rules every day plan must satisfy. Returns one line per broken rule; an
 * empty list means the plan is sound.
 */
import type { City } from '../city/records.ts';
import { distance } from '../layout/geometry.ts';
import type { Layout } from '../layout/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import { SECONDS_PER_DAY, startOfDay } from './calendar.ts';
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

export function createPlanChecker(inputs: { city: City; layout: Layout; pack: SettingPack }): PlanChecker {
  const { city, layout, pack } = inputs;
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
        }
        // Every visit goes to a building type that visit allows.
        if (activity.kind === 'visit') {
          const visit = activity.visitId === undefined ? undefined : visits.get(activity.visitId);
          if (!visit) problem(`activity ${at + 1} is a visit of the kind "${activity.visitId}", which the pack does not define`);
          else if (!visit.destinations.includes(building.type)) problem(`activity ${at + 1} is a "${visit.id}" visit to a ${building.type}, which that visit does not allow`);
        } else if (activity.visitId !== undefined) {
          problem(`activity ${at + 1} is ${activity.kind} but names a visit`);
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
      else same = last.buildingId === first.buildingId;
      return same ? [] : [`${earlier.personId}: day ${earlier.day} ends ${describe(last)} but day ${later.day} starts ${describe(first)}`];
    },
  };
}
