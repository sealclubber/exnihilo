/**
 * The pure functions on the avatar's state: where it is at a game time, each
 * action it can take, and what it perceives.
 *
 * Every action takes the current game time and returns a new state. Nothing
 * here moves the avatar: a walk is a path, a departure time and a speed, and
 * the position during it is worked out when asked.
 */
import type { City } from '../city/records.ts';
import { pointAlongPolyline } from '../layout/geometry.ts';
import type { PathFinder } from '../layout/path.ts';
import type { Layout, StreetPosition } from '../layout/records.ts';
import type { SettlementLife } from '../life/life.ts';
import type { Nearby, Occupant } from '../life/records.ts';
import type { Point } from '../schema.ts';
import type { AvatarPosition, AvatarState, AvatarWalk } from './records.ts';

/** An action that makes no sense for the avatar as it is. The message says why. */
export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarError';
  }
}

/** What the avatar's actions need to know of a town: its street graph, and where each building's door is. */
export interface AvatarTown {
  settlementId: string;
  finder: PathFinder;
  /** The position of a building's lot entrance; nothing if the town has no such building. */
  entranceOf(buildingId: string): StreetPosition | undefined;
}

export function avatarTown(city: City, layout: Layout, finder: PathFinder): AvatarTown {
  const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot.id]));
  return {
    settlementId: city.summary.settlementId,
    finder,
    entranceOf(buildingId) {
      const lotId = lots.get(buildingId);
      return lotId === undefined ? undefined : finder.positionOfLot(lotId);
    },
  };
}

/** The game time at which a walk arrives. */
export function arrivalTime(walk: AvatarWalk): number {
  return walk.departAt + walk.path.length / walk.speed;
}

/**
 * The state as it stands at a game time: a walk that has reached its arrival
 * time counts as arrived, standing at the street point or in the building it
 * was heading for. Anything else is returned as it is.
 */
export function settle(state: AvatarState, time: number): AvatarState {
  if (state.kind !== 'walking' || time < arrivalTime(state)) return state;
  const { settlementId, destination } = state;
  return destination.kind === 'building'
    ? { kind: 'inside', settlementId, buildingId: destination.buildingId }
    : { kind: 'standing', settlementId, segmentId: destination.segmentId, point: destination.point };
}

/** Where the avatar is at a game time. Before a walk's departure it is at the walk's start. */
export function avatarPosition(state: AvatarState, time: number): AvatarPosition {
  const now = settle(state, time);
  if (now.kind === 'inside') return { kind: 'building', buildingId: now.buildingId };
  if (now.kind === 'standing') return { kind: 'street', segmentId: now.segmentId, point: now.point, walking: false };
  const { path, departAt, speed } = now;
  const along = Math.min(path.length, Math.max(0, (time - departAt) * speed));
  // The segment under the avatar: the first whose stretch of the path reaches this far.
  let covered = 0;
  let segment = path.segmentIds.length - 1;
  for (let at = 0; at < path.walked.length; at++) {
    covered += path.walked[at] as number;
    if (along <= covered) {
      segment = at;
      break;
    }
  }
  return { kind: 'street', segmentId: path.segmentIds[segment] as string, point: pointAlongPolyline(path.points, along), walking: true };
}

const inTown = (state: AvatarState, town: AvatarTown): void => {
  if (state.settlementId !== town.settlementId) {
    throw new AvatarError(`the avatar is in ${state.settlementId}, not ${town.settlementId}; to move it to another town, spawn it there`);
  }
};

/** Where on the street graph a walk ordered now would begin: where the avatar is, or the door of the building it is in. */
function startOf(state: AvatarState, town: AvatarTown, time: number): StreetPosition {
  const position = avatarPosition(state, time);
  if (position.kind === 'street') return { segmentId: position.segmentId, point: position.point };
  const door = town.entranceOf(position.buildingId);
  if (!door) throw new AvatarError(`the avatar is in ${position.buildingId}, which ${town.settlementId} does not have`);
  return door;
}

/** Puts the avatar in a town, standing at the nearest point of the nearest street segment to the point given. */
export function spawn(town: AvatarTown, point: Point): AvatarState {
  return { kind: 'standing', settlementId: town.settlementId, ...town.finder.nearestPosition(point) };
}

/**
 * Sets the avatar walking to a point on a street: the nearest point of the nearest segment to the point given,
 * by the shortest path from where the avatar is at this moment.
 */
export function walkToPoint(state: AvatarState, town: AvatarTown, point: Point, time: number, speed: number): AvatarState {
  inTown(state, town);
  const from = startOf(state, town, time);
  const to = town.finder.nearestPosition(point);
  const path = town.finder.between(from, to);
  // The walk ends where the path does: the point given, taken onto the segment's line.
  const end = path.points[path.points.length - 1] as Point;
  return { kind: 'walking', settlementId: state.settlementId, path, departAt: time, speed, destination: { kind: 'street', segmentId: to.segmentId, point: end } };
}

/** Sets the avatar walking to a building's lot entrance, after which it is in the building. */
export function walkToBuilding(state: AvatarState, town: AvatarTown, buildingId: string, time: number, speed: number): AvatarState {
  inTown(state, town);
  const door = town.entranceOf(buildingId);
  if (!door) throw new AvatarError(`${town.settlementId} has no building with the ID "${buildingId}"`);
  const position = avatarPosition(state, time);
  if (position.kind === 'building' && position.buildingId === buildingId) throw new AvatarError(`the avatar is already in ${buildingId}`);
  const path = town.finder.between(startOf(state, town, time), door);
  return { kind: 'walking', settlementId: state.settlementId, path, departAt: time, speed, destination: { kind: 'building', buildingId } };
}

/** Stops a walk: the avatar stands where it is at this moment. */
export function stop(state: AvatarState, time: number): AvatarState {
  const position = avatarPosition(state, time);
  if (position.kind === 'building') throw new AvatarError(`the avatar is in ${position.buildingId}, not walking, so there is no walk to stop`);
  if (!position.walking) throw new AvatarError('the avatar is standing still already, so there is no walk to stop');
  return { kind: 'standing', settlementId: state.settlementId, segmentId: position.segmentId, point: position.point };
}

/** Leaves a building: the avatar stands at the lot's entrance point. */
export function leave(state: AvatarState, town: AvatarTown, time: number): AvatarState {
  inTown(state, town);
  const position = avatarPosition(state, time);
  if (position.kind !== 'building') throw new AvatarError('the avatar is on a street, not in a building, so there is nothing to leave');
  return { kind: 'standing', settlementId: state.settlementId, ...startOf(state, town, time) };
}

/** What the avatar perceives at a moment. */
export type Perception =
  /** On a street, standing or walking: residents who are walking or out of doors within the radius, nearest first. */
  | { where: 'street'; time: number; point: Point; segmentId: string; radius: number; nearby: Nearby[] }
  /** In a building: everyone at that building, inside it or outside on its lot. */
  | { where: 'building'; time: number; buildingId: string; occupants: Occupant[] };

/**
 * What the avatar perceives at a game time. People inside a building are not
 * perceived from the street, and people on the street are not perceived from
 * inside. `life` must be the life of the town the avatar is in.
 */
export function perceive(state: AvatarState, life: SettlementLife, radius: number, time: number): Perception {
  const position = avatarPosition(state, time);
  if (position.kind === 'building') return { where: 'building', time, buildingId: position.buildingId, occupants: life.occupants(position.buildingId, time) };
  return { where: 'street', time, point: position.point, segmentId: position.segmentId, radius, nearby: life.nearby(position.point, radius, time) };
}
