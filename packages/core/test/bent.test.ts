/**
 * Phase 6D, task 1: everything that reads a layout, run on a town with no straight street in it.
 *
 * Until now every segment any generator made was one straight line, so paths, positions, wanders, street stops,
 * sleeping places, the avatar and the nearby query had only ever run on two-point segments. The town here is
 * Badanos put through a smooth warp (`bent.ts`): river, bridges, dead ends and all, with every segment a
 * polyline of many pieces.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type Layout,
  type PathFinder,
  type Point,
  type SettlementLife,
  type Travel,
  arrivalTime,
  avatarPosition,
  avatarTown,
  checkLayout,
  createLife,
  createOutsiderChecker,
  createPathFinder,
  createPlanChecker,
  createRng,
  generateCity,
  generateLayout,
  geometry,
  isOutsiderId,
  sleepingPlacesAt,
  spawnAvatar,
  startOfDay,
  walkToBuilding,
  walkToPoint,
} from '../src/index.ts';
import { bend, warp } from './bent.ts';
import { medievalPack, settlement } from './pack.ts';

const SLOW = 240_000;
const pack = medievalPack();
const { distance, distanceToPolyline, polylineLength, projectOnPolyline } = geometry;
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const brief = settlement('settlement-641');

let city: City;
let straight: Layout;
let layout: Layout;
let life: SettlementLife;
let finder: PathFinder;
beforeAll(() => {
  city = generateCity(brief, pack);
  straight = generateLayout(city, brief, pack);
  layout = bend(straight);
  life = createLife({ city, layout, pack, brief });
  finder = createPathFinder(layout);
}, SLOW);

describe('the bent town', () => {
  it('has no straight street: every segment is a polyline of several pieces, from one junction\'s position to the other\'s', () => {
    const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction.position]));
    for (const segment of layout.segments) {
      expect(segment.points.length).toBeGreaterThan(2);
      expect(distance(segment.points[0]!, junctions.get(segment.fromJunctionId)!)).toBeLessThan(1e-9);
      expect(distance(segment.points.at(-1)!, junctions.get(segment.toJunctionId)!)).toBeLessThan(1e-9);
      // Longer along its line than straight between its ends, for most; never shorter.
      expect(polylineLength(segment.points)).toBeGreaterThanOrEqual(distance(segment.points[0]!, segment.points.at(-1)!) - 1e-9);
    }
    const bentOnes = layout.segments.filter((segment) => polylineLength(segment.points) > distance(segment.points[0]!, segment.points.at(-1)!) * 1.001);
    expect(bentOnes.length / layout.segments.length).toBeGreaterThan(0.7);
    expect(layout.segments.some((segment) => segment.kind === 'bridge')).toBe(true);
    expect(layout.junctions.some((junction) => junction.kind === 'dead-end')).toBe(true);
    // All but the smallest lots have sides of several pieces too.
    expect(layout.lots.filter((lot) => lot.polygon.length > 4).length / layout.lots.length).toBeGreaterThan(0.9);
  });

  it('is a sound layout by every rule but one: the warp widens the gap between some lots and their street', () => {
    // A warp stretches as well as bends, by up to a third here, so a lot that stood exactly half the widest street
    // from its street's line may stand a little further. Every other rule holds, bends and all.
    const problems = checkLayout(layout, city, brief, pack);
    expect(problems.filter((problem) => !/does not border/.test(problem))).toEqual([]);
  });
});

describe('paths on bent streets', () => {
  it('run along the polylines from entrance to entrance, as long as the pieces walked', () => {
    const rng = createRng(11);
    const lines = new Map(layout.segments.map((segment) => [segment.id, segment.points]));
    const lots = layout.lots;
    for (let trial = 0; trial < 300; trial++) {
      const from = lots[rng.int(0, lots.length - 1)]!;
      const to = lots[rng.int(0, lots.length - 1)]!;
      const path = finder.path(from.id, to.id);
      expect(distance(path.points[0]!, from.entrance.point)).toBeLessThan(1e-6);
      expect(distance(path.points.at(-1)!, to.entrance.point)).toBeLessThan(1e-6);
      // The length is the length of the line walked, and the sum of what is walked on each segment.
      expect(path.length).toBeCloseTo(polylineLength(path.points), 6);
      expect(path.walked.reduce((sum, part) => sum + part, 0)).toBeCloseTo(path.length, 6);
      // Never shorter than the straight line, and every point of the line is on a segment walked.
      expect(path.length).toBeGreaterThanOrEqual(distance(from.entrance.point, to.entrance.point) - 1e-6);
      for (const point of path.points) expect(Math.min(...path.segmentIds.map((id) => distanceToPolyline(point, lines.get(id)!)))).toBeLessThan(1e-6);
      // What is walked on a segment is never more than the segment is long: along its bends, not between its ends.
      path.segmentIds.forEach((id, index) => expect(path.walked[index]!).toBeLessThanOrEqual(polylineLength(lines.get(id)!) + 1e-6));
    }
  });

  it('are longer than on the straight town by about what the bends add, and join the same lots', () => {
    const before = createPathFinder(straight);
    const rng = createRng(12);
    let ratio = 0;
    for (let trial = 0; trial < 200; trial++) {
      const a = layout.lots[rng.int(0, layout.lots.length - 1)]!;
      const b = layout.lots[rng.int(0, layout.lots.length - 1)]!;
      if (a.id === b.id) continue;
      const bentPath = finder.path(a.id, b.id);
      const plain = before.path(a.id, b.id);
      ratio += bentPath.length / Math.max(plain.length, 1) / 200;
      expect(bentPath.length).toBeGreaterThan(plain.length * 0.6);
      expect(bentPath.length).toBeLessThan(plain.length * 1.6 + 20);
    }
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.2);
  });

  it('take a position anywhere on the map to the nearest point of the nearest bent segment', () => {
    const rng = createRng(13);
    const { minX, minY, maxX, maxY } = layout.summary.bounds;
    for (let trial = 0; trial < 200; trial++) {
      const point: Point = [minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)];
      const position = finder.nearestPosition(point);
      const line = layout.segments.find((segment) => segment.id === position.segmentId)!.points;
      expect(distanceToPolyline(position.point, line)).toBeLessThan(1e-9);
      const nearest = Math.min(...layout.segments.map((segment) => distanceToPolyline(point, segment.points)));
      expect(distance(point, position.point)).toBeCloseTo(nearest, 6);
    }
  });
});

describe('daily life on bent streets', () => {
  it('gives every resident and every outsider a sound plan, on a work day and the rest day', { timeout: SLOW }, () => {
    const residents = createPlanChecker({ city, layout, pack });
    const strangers = createOutsiderChecker({ city, layout, pack, outsiders: life.outsiders! });
    const failures: string[] = [];
    let plans = 0;
    for (const day of [1, 7]) {
      for (const plan of life.plansForDay(day)) {
        plans++;
        failures.push(...residents.check(plan), ...residents.checkContinuity(plan, life.plan(plan.personId, day + 1)));
      }
      for (const plan of life.outsiders!.plansForDay(day)) {
        plans++;
        failures.push(...strangers.check(plan), ...strangers.checkContinuity(plan, life.plan(plan.personId, day + 1)));
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(plans).toBeGreaterThan(19_000);
  });

  it('has every walker on the polyline at every sampled time, having walked speed times time along it', { timeout: SLOW }, () => {
    const lines = new Map(layout.segments.map((segment) => [segment.id, segment.points]));
    let sampled = 0;
    let onBends = 0;
    for (const plan of life.plansForDay(1).filter((_, index) => index % 7 === 0)) {
      for (const activity of plan.activities) {
        if (activity.kind !== 'travel' || activity.arriveAt === activity.departAt) continue;
        const walk = activity as Travel;
        const pace = walk.path.length / (walk.arriveAt - walk.departAt);
        for (let step = 0; step <= 6; step++) {
          const time = Math.min(walk.end - 1, walk.start + Math.floor(((walk.end - walk.start) * step) / 6));
          if (time < walk.start) continue;
          const where = life.whereabouts(plan.personId, time);
          if (where.kind !== 'travel') continue;
          sampled++;
          // On the line walked, and on the segment the answer names.
          const along = projectOnPolyline(walk.path.points, where.point);
          expect(along.distance).toBeLessThan(1e-6);
          expect(distanceToPolyline(where.point, lines.get(where.segmentId)!)).toBeLessThan(1e-6);
          // Distance walked along the bends is speed times time. (A line that passes a place twice could project to
          // the wrong pass; those samples are left out.)
          const walked = pace * (time - walk.departAt);
          if (Math.abs(along.along - walked) < 1) expect(along.along).toBeCloseTo(walked, 4);
          else expect(distance(geometry.pointAlongPolyline(walk.path.points, walked), where.point)).toBeLessThan(1e-6);
          if (lines.get(where.segmentId)!.length > 2) onBends++;
        }
      }
    }
    expect(sampled).toBeGreaterThan(20_000);
    expect(onBends).toBe(sampled);
  });

  it('keeps people stopped on a street, or out in front of a building, on the bent line of their segment', () => {
    const lines = new Map(layout.segments.map((segment) => [segment.id, segment.points]));
    const lots = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    let onStreet = 0;
    for (const stay of life.outsideStays(at(1, 9), at(1, 18))) {
      const segmentId = stay.segmentId ?? (stay.onStreet ? lots.get(stay.buildingId!)!.entrance.segmentId : undefined);
      if (segmentId === undefined) continue;
      onStreet++;
      for (const point of stay.wander.points) expect(distanceToPolyline(point, lines.get(segmentId)!)).toBeLessThan(1e-6);
      // Between two points of a wander they are still on the street: the stretch they keep to is one straight piece.
      for (let leg = 1; leg < stay.wander.points.length; leg++) {
        const [a, b] = [stay.wander.points[leg - 1]!, stay.wander.points[leg]!];
        expect(distanceToPolyline([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], lines.get(segmentId)!)).toBeLessThan(1e-6);
      }
    }
    expect(onStreet).toBeGreaterThan(500);
  });

  it('finds with the nearby query exactly whom a check of everyone\'s whereabouts finds', { timeout: SLOW }, () => {
    const rng = createRng(14);
    const { minX, minY, maxX, maxY } = layout.summary.bounds;
    const everyone = [...city.people.map((person) => person.id), ...life.outsiders!.inTown(1).map((outsider) => outsider.id)];
    let found = 0;
    for (const hours of [3, 8, 12.5, 17]) {
      const time = startOfDay(1) + hours * 3600;
      for (let trial = 0; trial < 6; trial++) {
        const point = finder.nearestPosition([minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)]).point;
        const brute = everyone
          .flatMap((personId) => {
            const where = life.whereabouts(personId, time);
            if (where.kind === 'away') return [];
            const seen = where.kind === 'travel' || where.kind === 'street' ? where.point : where.outside ? where.point! : undefined;
            return seen && distance(point, seen) <= 120 ? [{ personId, distance: distance(point, seen) }] : [];
          })
          .sort((a, b) => a.distance - b.distance || (a.personId < b.personId ? -1 : 1));
        expect(life.nearby(point, 120, time).map(({ personId, distance: away }) => ({ personId, distance: away }))).toEqual(brute);
        found += brute.length;
      }
    }
    expect(found).toBeGreaterThan(300);
  });

  it('has vagrants asleep at 03:00 at places of the kinds the pack allows, on the bent lines', () => {
    const lines = new Map(layout.segments.map((segment) => [segment.id, segment]));
    const allowed = pack.travellers!.vagrants!.sleepsAt;
    for (const vagrant of life.outsiders!.vagrants()) {
      const where = life.whereabouts(vagrant.id, at(1, 3));
      expect(where).toMatchObject({ kind: 'street', purpose: 'sleep' });
      if (where.kind !== 'street') continue;
      expect(distanceToPolyline(where.point, lines.get(where.segmentId)!.points)).toBeLessThan(1e-6);
      expect(sleepingPlacesAt(layout, { segmentId: where.segmentId, point: where.point }, pack.visits.streetReach!).some((kind) => allowed.includes(kind))).toBe(true);
    }
    // The side of a bent street a lot stands on is told from the piece of the street at its entrance: the streets
    // built on one side only are the same streets as in the straight town.
    const edges = (town: Layout) => town.segments.filter((segment) => sleepingPlacesAt(town, { segmentId: segment.id, point: segment.points[0]! }, 0).includes('edge')).map((segment) => segment.id);
    expect(edges(layout)).toEqual(edges(straight));
    expect(edges(layout).length).toBeGreaterThan(5);
  });

  it('has travellers enter and leave at the exit junctions, wherever the warp put them', () => {
    const exits = new Map(layout.exits.map((exit) => [exit.id, layout.junctions.find((junction) => junction.id === exit.junctionId)!.position]));
    const parties = [1, 2, 3].flatMap((day) => life.outsiders!.arrivals(day));
    expect(parties.length).toBeGreaterThan(15);
    for (const party of parties) {
      const first = life.plan(party.memberIds[0]!, party.arrivalDay).activities[0]!;
      expect(first.kind).toBe('travel');
      if (first.kind === 'travel') expect(distance(first.path.points[0]!, exits.get(party.arrival.exitId)!)).toBeLessThan(1e-6);
      expect(isOutsiderId(party.memberIds[0]!)).toBe(true);
    }
  });
});

describe('the avatar on bent streets', () => {
  it('walks along the bends: on the line at every moment, as far along it as its speed and the time give', () => {
    const town = avatarTown(city, layout, finder);
    const speed = pack.avatar.walkingSpeed;
    const start = spawnAvatar(town, warp([-300, 120]));
    const walk = walkToPoint(start, town, warp([280, -160]), 1000, speed);
    if (walk.kind !== 'walking') throw new Error('expected a walk');
    const lines = new Map(layout.segments.map((segment) => [segment.id, segment.points]));
    const duration = arrivalTime(walk) - 1000;
    expect(duration).toBeCloseTo(walk.path.length / speed, 6);
    expect(walk.path.length).toBeCloseTo(polylineLength(walk.path.points), 6);
    for (let step = 0; step <= 40; step++) {
      const time = 1000 + (duration * step) / 40;
      const position = avatarPosition(walk, time);
      if (position.kind !== 'street') throw new Error('expected the avatar on a street');
      expect(distanceToPolyline(position.point, walk.path.points)).toBeLessThan(1e-6);
      expect(distanceToPolyline(position.point, lines.get(position.segmentId)!)).toBeLessThan(1e-6);
      expect(distance(position.point, geometry.pointAlongPolyline(walk.path.points, speed * (time - 1000)))).toBeLessThan(1e-6);
    }
    // And into a building by its door, from wherever it has got to.
    const tavern = city.buildings.find((building) => building.type === 'tavern')!;
    const inside = walkToBuilding(walk, town, tavern.id, 1000 + duration / 3, speed);
    if (inside.kind !== 'walking') throw new Error('expected a walk');
    expect(distance(inside.path.points.at(-1)!, layout.lots.find((lot) => lot.buildingId === tavern.id)!.entrance.point)).toBeLessThan(1e-6);
    expect(distance(inside.path.points[0]!, (avatarPosition(walk, 1000 + duration / 3) as { point: Point }).point)).toBeLessThan(1e-6);
  });
});
