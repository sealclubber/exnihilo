/**
 * The avatar in the viewer: where it is at a game time, given the state the
 * server sent, and the words for it and for who is around it.
 *
 * The viewer does not find paths or decide who is nearby. It is sent a state,
 * a resting place or a trip, and moves the avatar along the trip by the
 * clock, as it does for residents. Pure, so it can be tested without a browser.
 */
import type { AvatarState, Nearby, Occupant, PackLabels, Point } from '@worldsim/core';
import { buildingTypeName } from './city-format.ts';
import { formatClock } from './clock.ts';
import { activityWord } from './life-format.ts';
import { formatMetres } from './town-format.ts';

/** When following the avatar, the map's smaller side shows this many perception radii, so that a street fills the view. */
const FOLLOW_SPAN = 5;

export type AvatarPlace =
  | { kind: 'street'; point: Point; walking: boolean; arriveAt?: number }
  | { kind: 'building'; buildingId: string };

/** Where the avatar is at a game time. A walk that has reached its arrival time has arrived. */
export function avatarPlace(state: AvatarState, time: number): AvatarPlace {
  if (state.kind === 'inside') return { kind: 'building', buildingId: state.buildingId };
  if (state.kind === 'standing') return { kind: 'street', point: state.point, walking: false };
  const { path, departAt, speed, destination } = state;
  const arriveAt = departAt + path.length / speed;
  if (time >= arriveAt) {
    return destination.kind === 'building' ? { kind: 'building', buildingId: destination.buildingId } : { kind: 'street', point: destination.point, walking: false };
  }
  // As far along the line as speed times the time since setting out.
  let left = Math.max(0, (time - departAt) * speed);
  const { points } = path;
  for (let at = 1; at < points.length; at++) {
    const [ax, ay] = points[at - 1] as Point;
    const [bx, by] = points[at] as Point;
    const piece = Math.hypot(bx - ax, by - ay);
    if (left <= piece) {
      const part = piece === 0 ? 0 : left / piece;
      return { kind: 'street', point: [ax + (bx - ax) * part, ay + (by - ay) * part], walking: true, arriveAt };
    }
    left -= piece;
  }
  return { kind: 'street', point: points[points.length - 1] as Point, walking: true, arriveAt };
}

/** The scale, in pixels per metre, at which the map follows the avatar. */
export function followScale(radius: number, width: number, height: number): number {
  return Math.min(width, height) / (FOLLOW_SPAN * radius);
}

const place = (buildingId: string, buildings: Record<string, string>, labels: PackLabels) => {
  const type = buildings[buildingId];
  return type === undefined ? buildingId : buildingTypeName(type, labels).toLowerCase();
};

/** What the avatar is doing, in a phrase. */
export function describeAvatar(state: AvatarState, time: number, buildingName?: string): string {
  const where = avatarPlace(state, time);
  if (where.kind === 'building') return `In the ${buildingName ?? where.buildingId}`;
  if (!where.walking) return 'Standing in the street';
  const heading = state.kind === 'walking' && state.destination.kind === 'building' ? 'to a building' : 'along the street';
  return `Walking ${heading}, arriving at ${formatClock(where.arriveAt as number)}`;
}

/** What someone near the avatar is doing: "Walking to the tannery", "At work outside the market stall". */
export function describeNearby(entry: Nearby, buildings: Record<string, string>, labels: PackLabels): string {
  if (entry.kind === 'walking') {
    const walking = entry.round ? 'On their round, walking' : 'Walking';
    return entry.toBuildingId === undefined ? `${walking} along the street` : `${walking} to the ${place(entry.toBuildingId, buildings, labels)}`;
  }
  // At a stop on a street there is no building to name.
  const at = entry.buildingId === undefined ? 'in the street' : `outside the ${place(entry.buildingId, buildings, labels)}`;
  if (entry.round) return `On their round, stopped ${at}`;
  switch (entry.activity) {
    case 'work':
      return `At work ${at}`;
    // Someone who lives on the streets, asleep or awake at the place where they sleep.
    case 'sleep':
      return `Asleep ${at}`;
    case 'home':
      return entry.buildingId === undefined ? 'In the street, at the place where they sleep' : `Resting ${at}`;
    case 'visit':
      return `${labels.visits[entry.visitId ?? ''] ?? 'Visiting'}, ${at}`;
  }
}

/** What someone in the same building as the avatar is doing. An outsider there is a traveller: awake, they are at their lodging and not at home. */
export function describeOccupant(occupant: Occupant, labels: PackLabels): string {
  const doing = occupant.kind === 'visit' ? (labels.visits[occupant.visitId ?? ''] ?? 'Visiting') : activityWord(occupant.kind, occupant.outsider === true);
  return `${doing}${occupant.outside ? ' (outside)' : ''}`;
}

/** A distance for the list of people nearby: whole metres. */
export function describeDistance(metres: number): string {
  return formatMetres(Math.round(metres));
}
