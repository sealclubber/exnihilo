/**
 * Phase 5: paths between street positions, the avatar's state and actions,
 * and what it perceives.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AvatarState,
  type AvatarTown,
  type City,
  type Layout,
  type Nearby,
  type PathFinder,
  type Point,
  type SettingPack,
  type SettlementLife,
  type StreetPosition,
  AvatarError,
  AvatarStateSchema,
  GENERATOR_VERSION,
  LAYOUT_VERSION,
  LIFE_VERSION,
  NearbySchema,
  StreetPathSchema,
  arrivalTime,
  avatarPosition,
  avatarTown,
  createLife,
  createPathFinder,
  createRng,
  generateCity,
  generateLayout,
  geometry,
  leaveBuilding,
  parsePack,
  perceive,
  settleAvatar,
  spawnAvatar,
  startOfDay,
  stopAvatar,
  walkToBuilding,
  walkToPoint,
} from '../src/index.ts';
import { medievalPack, rawMedievalPack, settlement } from './pack.ts';

/** A limit for the tests that plan whole towns, with headroom for a slower machine. */
const SLOW = 60_000;

const pack = medievalPack();
const { distance, polylineLength, projectOnPolyline, crossingsOfPolyline, distanceToPolyline } = geometry;
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};

interface Town {
  city: City;
  layout: Layout;
  finder: PathFinder;
  life: SettlementLife;
  town: AvatarTown;
}
const make = (id: string): Town => {
  const brief = settlement(id);
  const city = generateCity(brief, pack);
  const layout = generateLayout(city, brief, pack);
  const finder = createPathFinder(layout);
  return { city, layout, finder, life: createLife({ city, layout, pack }), town: avatarTown(city, layout, finder) };
};

let badanos: Town;
beforeAll(() => {
  badanos = make('settlement-641');
}, SLOW);

const SPEED = pack.avatar.walkingSpeed;
const RADIUS = pack.avatar.perceptionRadius;
/** Seeded points scattered over a layout's bounds. */
const scattered = (layout: Layout, count: number, seed: number): Point[] => {
  const rng = createRng(seed);
  const { minX, minY, maxX, maxY } = layout.summary.bounds;
  return Array.from({ length: count }, (): Point => [minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)]);
};
const segmentOf = (layout: Layout, id: string) => layout.segments.find((segment) => segment.id === id)!;
/** A position part of the way along a segment. */
const along = (layout: Layout, index: number, share: number): StreetPosition => {
  const segment = layout.segments[index]!;
  return { segmentId: segment.id, point: geometry.pointAlongPolyline(segment.points, polylineLength(segment.points) * share) };
};

describe('paths between street positions', () => {
  it('leaves the lot-to-lot results exactly as they were', () => {
    const baseline = JSON.parse(readFileSync(new URL('./baselines/badanos-lot-paths.json', import.meta.url), 'utf8')) as { pathHash: string };
    const { lots } = badanos.layout;
    const finder = createPathFinder(badanos.layout);
    const hash = createHash('sha256');
    for (let i = 0; i < 4000; i++) hash.update(JSON.stringify(finder.path(lots[(i * 37) % lots.length]!.id, lots[(i * 101 + 13) % lots.length]!.id)));
    expect(hash.digest('hex')).toBe(baseline.pathHash);
  });

  it('gives a lot the position of its entrance, so that a lot is the special case', () => {
    const { layout, finder } = badanos;
    for (const [a, b] of [[0, 1771], [100, 900], [640, 641], [5, 5]] as const) {
      const from = layout.lots[a]!;
      const to = layout.lots[b]!;
      expect(finder.positionOfLot(from.id)).toEqual({ segmentId: from.entrance.segmentId, point: from.entrance.point });
      const { fromLotId: _from, toLotId: _to, ...walk } = finder.path(from.id, to.id);
      expect(finder.between(finder.positionOfLot(from.id), finder.positionOfLot(to.id))).toEqual(walk);
    }
    expect(() => finder.positionOfLot('lot-641-999999')).toThrow(/there is no lot/);
    expect(() => finder.between({ segmentId: 'segment-641-999999', point: [0, 0] }, along(layout, 0, 0.5))).toThrow(/there is no segment with the ID "segment-641-999999"/);
  });

  it('walks the stretch between two points on the same segment', () => {
    const { layout, finder } = badanos;
    const long = layout.segments.map((segment, index) => ({ index, length: polylineLength(segment.points) })).sort((a, b) => b.length - a.length)[0]!;
    const from = along(layout, long.index, 0.2);
    const to = along(layout, long.index, 0.7);
    const path = finder.between(from, to);
    expect(StreetPathSchema.safeParse(path).success).toBe(true);
    expect(path.segmentIds).toEqual([from.segmentId]);
    expect(path.length).toBeCloseTo(long.length * 0.5, 6);
    expect(path.walked).toEqual([path.length]);
    expect(path.points[0]).toEqual(from.point);
    expect(path.points.at(-1)).toEqual(to.point);
    // And the other way is the same stretch, reversed.
    const back = finder.between(to, from);
    expect(back.length).toBeCloseTo(path.length, 9);
    expect(back.points).toEqual([...path.points].reverse());
  });

  it('has a length equal to the distance walked along its segments, and a line of that length', () => {
    const { layout, finder } = badanos;
    const rng = createRng(7);
    for (let trial = 0; trial < 200; trial++) {
      const from = along(layout, rng.int(0, layout.segments.length - 1), rng.next());
      const to = along(layout, rng.int(0, layout.segments.length - 1), rng.next());
      const path = finder.between(from, to);
      expect(path.walked.reduce((sum, part) => sum + part, 0)).toBeCloseTo(path.length, 6);
      expect(polylineLength(path.points)).toBeCloseTo(path.length, 6);
      expect(path.segmentIds[0]).toBe(from.segmentId);
      expect(path.segmentIds.at(-1)).toBe(to.segmentId);
      expect(distance(path.points[0]!, from.point)).toBeLessThan(1e-6);
      expect(distance(path.points.at(-1)!, to.point)).toBeLessThan(1e-6);
      // No part walked is longer than its segment, and every point of the line is on a segment walked.
      path.segmentIds.forEach((id, index) => expect(path.walked[index]!).toBeLessThanOrEqual(polylineLength(segmentOf(layout, id).points) + 1e-6));
      // The straight line is never longer than the walk.
      expect(distance(from.point, to.point)).toBeLessThanOrEqual(path.length + 1e-6);
      // And it is as short the other way.
      expect(finder.between(to, from).length).toBeCloseTo(path.length, 6);
    }
  });

  it('crosses the bridge between positions on opposite banks of the river in Badanos', () => {
    const { layout, finder } = badanos;
    const river = layout.waters.find((water) => water.kind === 'river') as Extract<Layout['waters'][number], { kind: 'river' }>;
    const bridges = new Set(layout.segments.filter((segment) => segment.kind === 'bridge').map((segment) => segment.id));
    const streets = layout.segments.map((_, index) => index).filter((index) => layout.segments[index]!.kind !== 'bridge');
    const rng = createRng(11);
    let crossed = 0;
    for (let trial = 0; trial < 400 && crossed < 25; trial++) {
      const from = along(layout, streets[rng.int(0, streets.length - 1)]!, 0.5);
      const to = along(layout, streets[rng.int(0, streets.length - 1)]!, 0.5);
      // On opposite banks: the straight line between them crosses the river's centre line an odd number of times.
      if (crossingsOfPolyline(from.point, to.point, river.centreLine) % 2 !== 1) continue;
      if (distanceToPolyline(from.point, river.centreLine) < river.width || distanceToPolyline(to.point, river.centreLine) < river.width) continue;
      crossed++;
      expect(finder.between(from, to).segmentIds.some((id) => bridges.has(id)), `${from.segmentId} to ${to.segmentId}`).toBe(true);
    }
    expect(crossed).toBe(25);
  });

  it('has length zero from a position to itself', () => {
    const { layout, finder } = badanos;
    for (const index of [0, 17, 300]) {
      const here = along(layout, index, 0.37);
      const path = finder.between(here, here);
      expect(path.length).toBe(0);
      expect(path.segmentIds).toEqual([here.segmentId]);
      expect(path.points).toHaveLength(1);
      expect(distance(path.points[0]!, here.point)).toBeLessThan(1e-9);
    }
  });

  it('takes a point that is off the segment to the nearest point of its line', () => {
    const { layout, finder } = badanos;
    const here = along(layout, 40, 0.5);
    const off: StreetPosition = { segmentId: here.segmentId, point: [here.point[0] + 3, here.point[1] + 3] };
    const start = finder.between(off, along(layout, 41, 0.5)).points[0]!;
    expect(distance(start, projectOnPolyline(layout.segments[40]!.points, off.point).point)).toBeLessThan(1e-9);
  });

  it('finds the nearest point of the nearest segment to any point', () => {
    const { layout, finder } = badanos;
    for (const point of scattered(layout, 60, 3)) {
      const found = finder.nearestPosition(point);
      const best = Math.min(...layout.segments.map((segment) => distanceToPolyline(point, segment.points)));
      expect(distance(point, found.point)).toBeCloseTo(best, 9);
      expect(distanceToPolyline(found.point, segmentOf(layout, found.segmentId).points)).toBeLessThan(1e-9);
    }
  });
});

describe('the avatar', () => {
  const T0 = at(1, 7, 45);
  const spawned = (point: Point = [0, 0]) => spawnAvatar(badanos.town, point);
  const streetPoint = (state: AvatarState, time: number) => {
    const position = avatarPosition(state, time);
    if (position.kind !== 'street') throw new Error('the avatar is not on a street');
    return position;
  };

  it('spawns on a street segment, at the nearest point of the nearest segment', () => {
    const { layout } = badanos;
    for (const point of scattered(layout, 40, 5)) {
      const state = spawned(point);
      expect(AvatarStateSchema.safeParse(state).success).toBe(true);
      if (state.kind !== 'standing') throw new Error('not standing');
      expect(state.settlementId).toBe('settlement-641');
      const best = Math.min(...layout.segments.map((segment) => distanceToPolyline(point, segment.points)));
      expect(distance(point, state.point)).toBeCloseTo(best, 9);
      expect(distanceToPolyline(state.point, segmentOf(layout, state.segmentId).points)).toBeLessThan(1e-9);
      expect(avatarPosition(state, T0)).toEqual({ kind: 'street', segmentId: state.segmentId, point: state.point, walking: false });
    }
  });

  it('walks its path at its speed: the distance covered is speed times elapsed game time', () => {
    const { layout } = badanos;
    const walk = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    if (walk.kind !== 'walking') throw new Error('not walking');
    expect(AvatarStateSchema.safeParse(walk).success).toBe(true);
    expect(walk.path.length).toBeGreaterThan(300);
    expect(arrivalTime(walk)).toBeCloseTo(T0 + walk.path.length / SPEED, 9);
    for (const elapsed of [0, 1, 17.5, 60, 200, walk.path.length / SPEED - 0.5]) {
      const position = streetPoint(walk, T0 + elapsed);
      expect(position.walking).toBe(true);
      // On the path, as far along it as speed times time.
      const on = projectOnPolyline(walk.path.points, position.point);
      expect(on.distance).toBeLessThan(1e-6);
      expect(on.along).toBeCloseTo(SPEED * elapsed, 6);
      // And on the segment it says it is on, which is one of the path's.
      expect(walk.path.segmentIds).toContain(position.segmentId);
      expect(distanceToPolyline(position.point, segmentOf(layout, position.segmentId).points)).toBeLessThan(1e-6);
    }
    // Before the departure it is at the start.
    expect(streetPoint(walk, T0 - 500).point).toEqual(walk.path.points[0]);
  });

  it('is standing at its destination at or after the arrival time, or in the building it walked to', () => {
    const toStreet = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    if (toStreet.kind !== 'walking' || toStreet.destination.kind !== 'street') throw new Error('not walking to a street');
    const end = toStreet.path.points.at(-1)!;
    for (const later of [0, 0.001, 60, 86_400 * 3]) {
      const time = arrivalTime(toStreet) + later;
      expect(avatarPosition(toStreet, time)).toEqual({ kind: 'street', segmentId: toStreet.destination.segmentId, point: end, walking: false });
      expect(settleAvatar(toStreet, time)).toEqual({ kind: 'standing', settlementId: 'settlement-641', segmentId: toStreet.destination.segmentId, point: end });
    }
    expect(settleAvatar(toStreet, arrivalTime(toStreet) - 0.001)).toBe(toStreet);

    const building = badanos.city.buildings[900]!;
    const toBuilding = walkToBuilding(spawned(), badanos.town, building.id, T0, SPEED);
    if (toBuilding.kind !== 'walking') throw new Error('not walking');
    // It walks to the lot's entrance.
    const lot = badanos.layout.lots.find((entry) => entry.buildingId === building.id)!;
    expect(toBuilding.path.points.at(-1)).toEqual(lot.entrance.point);
    expect(streetPoint(toBuilding, arrivalTime(toBuilding) - 1).walking).toBe(true);
    expect(avatarPosition(toBuilding, arrivalTime(toBuilding))).toEqual({ kind: 'building', buildingId: building.id });
    expect(settleAvatar(toBuilding, arrivalTime(toBuilding) + 5)).toEqual({ kind: 'inside', settlementId: 'settlement-641', buildingId: building.id });
  });

  it('has a position that depends only on state and game time, asked in any order', () => {
    const walk = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    const times = [T0 + 300, T0 - 50, T0 + 10, T0 + 100_000, T0 + 150, T0, T0 + 10];
    const first = times.map((time) => avatarPosition(walk, time));
    const again = [...times].reverse().map((time) => avatarPosition(walk, time)).reverse();
    expect(again).toEqual(first);
    expect(first[2]).toEqual(first[6]);
    // Going back in time takes the avatar back along its path.
    const forward = projectOnPolyline((walk as { path: { points: Point[] } }).path.points, streetPoint(walk, T0 + 150).point).along;
    const back = projectOnPolyline((walk as { path: { points: Point[] } }).path.points, streetPoint(walk, T0 + 10).point).along;
    expect(back).toBeLessThan(forward);
    // The state itself is never changed by being asked.
    const copy = structuredClone(walk);
    avatarPosition(walk, T0 + 77);
    settleAvatar(walk, T0 + 1e9);
    expect(walk).toEqual(copy);
  });

  it('stops exactly where it was at that moment', () => {
    const walk = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    const moment = T0 + 123.4;
    const where = streetPoint(walk, moment);
    const stopped = stopAvatar(walk, moment);
    expect(stopped).toEqual({ kind: 'standing', settlementId: 'settlement-641', segmentId: where.segmentId, point: where.point });
    for (const time of [moment, moment + 1, moment + 10_000]) expect(avatarPosition(stopped, time)).toEqual({ ...where, walking: false });
  });

  it('starts a new walk ordered during a walk from the position at that moment, with no jump', () => {
    const first = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    const moment = T0 + 95.5;
    const where = streetPoint(first, moment);
    const second = walkToPoint(first, badanos.town, [-100, 300], moment, SPEED);
    if (second.kind !== 'walking') throw new Error('not walking');
    expect(second.departAt).toBe(moment);
    expect(distance(second.path.points[0]!, where.point)).toBeLessThan(1e-6);
    expect(distance(streetPoint(second, moment).point, where.point)).toBeLessThan(1e-6);
    // A moment later it has moved no further than its speed allows.
    expect(distance(streetPoint(second, moment + 2).point, where.point)).toBeLessThanOrEqual(SPEED * 2 + 1e-6);
    // The same holds for turning toward a building mid-walk.
    const third = walkToBuilding(second, badanos.town, badanos.city.buildings[10]!.id, moment + 30, SPEED);
    if (third.kind !== 'walking') throw new Error('not walking');
    expect(distance(third.path.points[0]!, streetPoint(second, moment + 30).point)).toBeLessThan(1e-6);
  });

  it('leaves a building at its lot\'s entrance point, and walks from a building by way of its door', () => {
    const building = badanos.city.buildings[900]!;
    const lot = badanos.layout.lots.find((entry) => entry.buildingId === building.id)!;
    const inside = settleAvatar(walkToBuilding(spawned(), badanos.town, building.id, T0, SPEED), T0 + 86_400);
    expect(inside.kind).toBe('inside');
    expect(leaveBuilding(inside, badanos.town, T0 + 86_400)).toEqual({ kind: 'standing', settlementId: 'settlement-641', segmentId: lot.entrance.segmentId, point: lot.entrance.point });
    // Leaving also works on a walk that has arrived but has not been settled.
    const arrived = walkToBuilding(spawned(), badanos.town, building.id, T0, SPEED);
    expect(leaveBuilding(arrived, badanos.town, T0 + 86_400)).toMatchObject({ kind: 'standing', point: lot.entrance.point });
    // A walk ordered from inside begins at the door.
    const out = walkToPoint(inside, badanos.town, [0, 0], T0 + 86_400, SPEED);
    expect((out as { path: { points: Point[] } }).path.points[0]).toEqual(lot.entrance.point);
  });

  it('refuses an action that makes no sense, saying why', () => {
    const standing = spawned();
    const walking = walkToPoint(standing, badanos.town, [250, -150], T0, SPEED);
    const building = badanos.city.buildings[900]!;
    const inside = settleAvatar(walkToBuilding(standing, badanos.town, building.id, T0, SPEED), T0 + 86_400);
    const refused = (action: () => unknown, message: RegExp) => {
      expect(action).toThrow(AvatarError);
      expect(action).toThrow(message);
    };
    refused(() => leaveBuilding(standing, badanos.town, T0), /the avatar is on a street, not in a building, so there is nothing to leave/);
    refused(() => leaveBuilding(walking, badanos.town, T0 + 5), /on a street, not in a building/);
    refused(() => stopAvatar(standing, T0), /standing still already, so there is no walk to stop/);
    refused(() => stopAvatar(walking, arrivalTime(walking as never) + 1), /standing still already/);
    refused(() => stopAvatar(inside, T0), /is in building-641-\d+, not walking/);
    refused(() => walkToBuilding(inside, badanos.town, building.id, T0, SPEED), /the avatar is already in building-641-\d+/);
    refused(() => walkToBuilding(standing, badanos.town, 'building-641-999999', T0, SPEED), /settlement-641 has no building with the ID "building-641-999999"/);
    // Another town is a fresh spawn, not a walk.
    const elsewhere = { ...badanos.town, settlementId: 'settlement-455' };
    refused(() => walkToPoint(standing, elsewhere, [0, 0], T0, SPEED), /the avatar is in settlement-641, not settlement-455; to move it to another town, spawn it there/);
    refused(() => walkToBuilding(standing, elsewhere, building.id, T0, SPEED), /spawn it there/);
    refused(() => leaveBuilding(inside, elsewhere, T0), /spawn it there/);
  });

  it('halves its walking time when its speed doubles', () => {
    const fast = edited((raw) => (raw.avatar.walkingSpeed *= 2));
    expect(fast.avatar.walkingSpeed).toBe(SPEED * 2);
    const slow = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, SPEED);
    const quick = walkToPoint(spawned([-300, 100]), badanos.town, [250, -150], T0, fast.avatar.walkingSpeed);
    expect(arrivalTime(quick as never) - T0).toBeCloseTo((arrivalTime(slow as never) - T0) / 2, 9);
  });
});

describe('perception', () => {
  /** Everyone within a distance of a point, found the slow way: by asking where each resident is. */
  const bruteForce = ({ city, life }: Town, point: Point, radius: number, time: number) =>
    city.people
      .flatMap((person) => {
        const where = life.whereabouts(person.id, time);
        const seen = where.kind === 'travel' ? where.point : where.outside ? where.point! : undefined;
        if (!seen) return [];
        const away = distance(point, seen);
        return away <= radius ? [{ personId: person.id, distance: away, kind: where.kind === 'travel' ? 'walking' : 'outside' }] : [];
      })
      .sort((a, b) => a.distance - b.distance || (a.personId < b.personId ? -1 : 1));
  const brief = (found: Nearby[]) => found.map(({ personId, distance: away, kind }) => ({ personId, distance: away, kind }));

  it('finds exactly the residents a check of everyone\'s whereabouts finds, in order of distance', { timeout: SLOW }, () => {
    const { layout, life } = badanos;
    let seen = 0;
    for (const [hours, minutes] of [[3, 0], [7, 50], [12, 30], [20, 30]] as const) {
      const time = at(1, hours, minutes);
      // Points on streets all over the town, and a wide radius as well as the pack's.
      const points = scattered(layout, 24, hours * 100 + minutes).map((point) => badanos.finder.nearestPosition(point).point);
      for (const point of points) {
        for (const radius of [RADIUS, 150]) {
          const found = life.nearby(point, radius, time);
          expect(brief(found), `${hours}:${minutes} at ${point}`).toEqual(bruteForce(badanos, point, radius, time));
          for (const entry of found.slice(0, 5)) expect(NearbySchema.safeParse(entry).success).toBe(true);
          seen += found.length;
        }
      }
    }
    expect(seen).toBeGreaterThan(2000);
  });

  it('says what each person nearby is doing, in agreement with their whereabouts', () => {
    const { life } = badanos;
    const time = at(1, 7, 50);
    const found = life.nearby([0, 0], 400, time);
    expect(found.some((entry) => entry.kind === 'walking')).toBe(true);
    expect(life.nearby([0, 0], 400, at(1, 12, 30)).some((entry) => entry.kind === 'outside')).toBe(true);
    for (const entry of [...found, ...life.nearby([0, 0], 400, at(1, 12, 30))]) {
      const where = life.whereabouts(entry.personId, entry.kind === 'walking' && found.includes(entry) ? time : found.includes(entry) ? time : at(1, 12, 30));
      if (entry.kind === 'walking') expect(where).toMatchObject({ kind: 'travel', point: entry.point, fromBuildingId: entry.fromBuildingId, toBuildingId: entry.toBuildingId });
      else expect(where).toMatchObject({ kind: entry.activity, outside: true, point: entry.point, buildingId: entry.buildingId });
    }
  });

  it('never removes anyone when the radius doubles', () => {
    const { layout, life } = badanos;
    const wide = edited((raw) => (raw.avatar.perceptionRadius *= 2)).avatar.perceptionRadius;
    expect(wide).toBe(RADIUS * 2);
    let grew = 0;
    for (const time of [at(1, 7, 50), at(1, 12, 30)]) {
      for (const point of scattered(layout, 30, 21)) {
        const near = new Set(life.nearby(point, RADIUS, time).map((entry) => entry.personId));
        const far = new Set(life.nearby(point, wide, time).map((entry) => entry.personId));
        for (const id of near) expect(far.has(id)).toBe(true);
        if (far.size > near.size) grew++;
      }
    }
    expect(grew).toBeGreaterThan(5);
  });

  it('perceives, from a street, only people who are walking or outside, and nobody inside a building', () => {
    const { life, town, city } = badanos;
    for (const time of [at(1, 3), at(1, 12, 30)]) {
      for (const point of scattered(badanos.layout, 20, 9)) {
        const seen = perceive(spawnAvatar(town, point), life, 200, time);
        if (seen.where !== 'street') throw new Error('not on a street');
        for (const entry of seen.nearby) {
          const where = life.whereabouts(entry.personId, time);
          expect(where.kind === 'travel' || where.outside === true, entry.personId).toBe(true);
        }
        // At 03:00 that is nobody at all, or the few who are walking then.
        if (time === at(1, 3)) expect(seen.nearby.every((entry) => entry.kind === 'walking')).toBe(true);
      }
    }
    // The whole town from its centre at 03:00: everyone asleep indoors goes unseen.
    const all = perceive(spawnAvatar(town, [0, 0]), life, 1e6, at(1, 3));
    if (all.where !== 'street') throw new Error('not on a street');
    const out = city.people.filter((person) => {
      const where = life.whereabouts(person.id, at(1, 3));
      return where.kind === 'travel' || where.outside;
    });
    expect(all.nearby.map((entry) => entry.personId).sort()).toEqual(out.map((person) => person.id).sort());
    expect(all.nearby.length).toBeLessThan(20);
  });

  it('perceives, in a building, exactly that building\'s occupants, and nobody on the street', () => {
    const { life, town, city } = badanos;
    const time = at(1, 11);
    const stall = city.buildings.find((building) => building.type === 'market-stall')!;
    const tannery = city.buildings.find((building) => building.type === 'tannery')!;
    for (const building of [stall, tannery]) {
      const walk = walkToBuilding(spawnAvatar(town, [0, 0]), town, building.id, time - 3600, SPEED);
      expect(avatarPosition(walk, time).kind).toBe('building');
      const seen = perceive(walk, life, RADIUS, time);
      if (seen.where !== 'building') throw new Error('not in a building');
      expect(seen.buildingId).toBe(building.id);
      expect(seen.occupants).toEqual(life.occupants(building.id, time));
      expect(seen.occupants.length).toBeGreaterThan(0);
      expect(seen).not.toHaveProperty('nearby');
    }
    // On the way there, it perceives the street instead.
    const walk = walkToBuilding(spawnAvatar(town, [0, 0]), town, tannery.id, time, SPEED);
    expect(perceive(walk, life, RADIUS, time + 1).where).toBe('street');
  });

  it('answers in under 10 milliseconds in Badanos once its index is built', () => {
    const { layout, life } = badanos;
    const points = scattered(layout, 200, 77).map((point) => badanos.finder.nearestPosition(point).point);
    const report: string[] = [];
    for (const [hours, minutes] of [[7, 50], [12, 30]] as const) {
      const time = at(2, hours, minutes);
      life.nearby([0, 0], RADIUS, time);
      const started = performance.now();
      for (const point of points) life.nearby(point, RADIUS, time);
      const each = (performance.now() - started) / points.length;
      report.push(`${String(hours).padStart(2, '0')}:${minutes} ${each.toFixed(3)} ms`);
      expect(each).toBeLessThan(10);
    }
    console.log(`A nearby query in Badanos: ${report.join(', ')}`);
  });

  it('answers quickly in Pombal too', { timeout: SLOW }, () => {
    const pombal = make('settlement-5');
    const points = scattered(pombal.layout, 200, 78).map((point) => pombal.finder.nearestPosition(point).point);
    const report: string[] = [];
    for (const [hours, minutes] of [[7, 50], [12, 30]] as const) {
      const time = at(2, hours, minutes);
      const building = performance.now();
      pombal.life.nearby([0, 0], RADIUS, time);
      const built = performance.now() - building;
      const started = performance.now();
      for (const point of points) pombal.life.nearby(point, RADIUS, time);
      const each = (performance.now() - started) / points.length;
      report.push(`${String(hours).padStart(2, '0')}:${minutes} ${each.toFixed(3)} ms (first ${built.toFixed(0)} ms)`);
      expect(each).toBeLessThan(10);
    }
    console.log(`A nearby query in Pombal: ${report.join(', ')}`);
  });
});

describe('unchanged', () => {
  it('leaves residents\' plans byte-identical with and without an avatar about', () => {
    const { city, layout, town } = badanos;
    const plain = createLife({ city, layout, pack });
    const before = JSON.stringify(plain.plansForDay(3));
    // An avatar spawns, walks, is perceived around, enters a building and leaves.
    const watched = createLife({ city, layout, pack });
    let avatar = spawnAvatar(town, [40, 40]);
    perceive(avatar, watched, RADIUS, at(3, 7, 50));
    avatar = walkToBuilding(avatar, town, city.buildings[300]!.id, at(3, 7, 50), SPEED);
    for (let minute = 0; minute < 30; minute++) perceive(avatar, watched, RADIUS, at(3, 7, 50 + minute));
    avatar = leaveBuilding(avatar, town, at(3, 9));
    expect(JSON.stringify(watched.plansForDay(3))).toBe(before);
    expect(JSON.stringify(createLife({ city, layout, pack }).plansForDay(3))).toBe(before);
  });

  it('keeps every version where it was', () => {
    expect(LIFE_VERSION).toBe(3);
    expect(LAYOUT_VERSION).toBe(2);
    expect(GENERATOR_VERSION).toBe(2);
  });
});
