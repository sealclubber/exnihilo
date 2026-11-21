/**
 * Phase 6A: moving about outside. A wander is derived from the person and
 * the stay, keeps to the lot's open ground, and is never stepped.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type DayPlan,
  type Layout,
  type Lot,
  type Point,
  type SettingPack,
  type SettlementLife,
  type Stay,
  type Wander,
  GENERATOR_VERSION,
  LIFE_VERSION,
  WanderSchema,
  clipWander,
  createLife,
  createPlanChecker,
  createRng,
  generateCity,
  generateLayout,
  geometry,
  groundOf,
  makeWander,
  parsePack,
  positionOnWander,
  startOfDay,
} from '../src/index.ts';
import { medievalPack, medievalPackBefore6B, rawMedievalPack, settlement } from './pack.ts';

/** A limit for the tests that plan whole towns, with headroom for a slower machine. */
const SLOW = 60_000;

const pack = medievalPack();
const { distance, pointInPolygon, strictlyInside, piecesCross } = geometry;
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};
interface Town {
  city: City;
  layout: Layout;
  life: SettlementLife;
}
const town = (id: string, packUsed: SettingPack = pack): Town => {
  const brief = settlement(id);
  const city = generateCity(brief, packUsed);
  const layout = generateLayout(city, brief, packUsed);
  return { city, layout, life: createLife({ city, layout, pack: packUsed }) };
};
let badanos: Town;
let lots: Map<string, Lot>;
beforeAll(() => {
  badanos = town('settlement-641');
  lots = new Map(badanos.layout.lots.map((lot) => [lot.buildingId, lot]));
}, SLOW);

const PACE = pack.species.human!.life.outside!.pace;
const outsideOf = (plan: DayPlan) => plan.activities.filter((activity): activity is Stay => activity.kind !== 'travel' && activity.outside === true);
const onGround = (lot: Lot, point: Point) => pointInPolygon(point, lot.polygon) && !lot.footprints.some((footprint) => strictlyInside(point, footprint));
const lot = (polygon: Point[], footprints: Point[][], entrance: Point): Lot => ({
  id: 'lot-1-000001',
  buildingId: 'building-1-000001',
  polygon,
  districtId: 'district-1-001',
  entrance: { segmentId: 'segment-1-000001', point: entrance },
  footprints,
});
const square = (x: number, y: number, width: number, height: number): Point[] => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];

describe('a wander', () => {
  const wander: Wander = { times: [100, 160, 180, 240, 260], points: [[0, 0], [0, 0], [10, 0], [10, 0], [10, 8]] };

  it('fits its schema, and one that is malformed does not', () => {
    expect(WanderSchema.safeParse(wander).success).toBe(true);
    expect(WanderSchema.safeParse({ times: [1, 2, 3], points: [[0, 0], [1, 1]] }).success).toBe(false);
    expect(WanderSchema.safeParse({ times: [5, 2], points: [[0, 0], [1, 1]] }).success).toBe(false);
    expect(WanderSchema.safeParse({ times: [5], points: [[0, 0]] }).success).toBe(false);
  });

  it('gives a position by interpolation: pausing where two times share a point, moving in a straight line between', () => {
    expect(positionOnWander(wander, 100)).toEqual([0, 0]);
    expect(positionOnWander(wander, 130)).toEqual([0, 0]);
    expect(positionOnWander(wander, 160)).toEqual([0, 0]);
    expect(positionOnWander(wander, 170)).toEqual([5, 0]);
    expect(positionOnWander(wander, 180)).toEqual([10, 0]);
    expect(positionOnWander(wander, 200)).toEqual([10, 0]);
    expect(positionOnWander(wander, 250)).toEqual([10, 4]);
    // Before it begins and after it ends, the person is at its ends.
    expect(positionOnWander(wander, 0)).toEqual([0, 0]);
    expect(positionOnWander(wander, 999)).toEqual([10, 8]);
  });

  it('can be cut to a stretch of time, beginning and ending where the person is then', () => {
    const cut = clipWander(wander, 170, 250);
    expect(cut).toEqual({ times: [170, 180, 240, 250], points: [[5, 0], [10, 0], [10, 0], [10, 4]] });
    for (const time of [170, 175, 200, 245, 250]) expect(positionOnWander(cut, time)).toEqual(positionOnWander(wander, time));
    // A stretch that holds the whole wander leaves it as it is; one beyond it is its nearer end.
    expect(clipWander(wander, 0, 999)).toBe(wander);
    expect(clipWander(wander, 50, 170).times).toEqual([100, 160, 170]);
    expect(clipWander(wander, 300, 400)).toEqual({ times: [260, 260], points: [[10, 8], [10, 8]] });
  });
});

describe('open ground', () => {
  it('is the lot less its footprints', () => {
    const yard = groundOf(lot(square(0, 0, 10, 20), [square(0, 0, 10, 12)], [5, -3]));
    expect(yard.open).toBe(true);
    expect(yard.holds([5, 16])).toBe(true);
    expect(yard.holds([5, 6])).toBe(false);
    expect(yard.holds([5, 12])).toBe(false);
    expect(yard.holds([15, 16])).toBe(false);
    const rng = createRng(1);
    for (let draw = 0; draw < 200; draw++) {
      const [x, y] = yard.place(rng);
      expect(x > 0 && x < 10 && y > 12 && y < 20).toBe(true);
    }
  });

  it('is found in a thin strip that a coarse look would miss', () => {
    const strip = lot(square(0, 0, 20, 20), [square(0, 0, 20, 19.4)], [10, -3]);
    const ground = groundOf(strip);
    expect(ground.open).toBe(true);
    const rng = createRng(2);
    for (let draw = 0; draw < 50; draw++) expect(onGround(strip, ground.place(rng))).toBe(true);
  });

  it('is absent from a lot its building fills: a person outside there is at the frontage', () => {
    const full = groundOf(lot(square(0, 0, 10, 20), [square(0, 0, 10, 20)], [5, -3]));
    expect(full.open).toBe(false);
    // The point of the lot's outline nearest its entrance.
    expect(full.place(createRng(3))).toEqual([5, 0]);
    const wander = makeWander(full, createRng(3), 1000, 5000, { pace: 0.5, pause: { min: 60, max: 120 } });
    expect(wander).toEqual({ times: [1000, 5000], points: [[5, 0], [5, 0]] });
  });

  it('knows a straight line that would pass through a building from one that would not', () => {
    // A house in the middle of its lot, with ground all round it.
    const ring = groundOf(lot(square(0, 0, 30, 30), [square(10, 10, 10, 10)], [15, -3]));
    expect(ring.clear([5, 5], [25, 5])).toBe(true);
    expect(ring.clear([5, 15], [25, 15])).toBe(false);
    expect(ring.clear([5, 5], [25, 25])).toBe(false);
    expect(ring.clear([5, 5], [5, 25])).toBe(true);
    // Nor may a line leave the lot, as it could from one arm of an L to the other.
    const bent = groundOf(lot([[0, 0], [10, 0], [10, 20], [30, 20], [30, 30], [0, 30]], [], [5, -3]));
    expect(bent.clear([5, 5], [25, 25])).toBe(false);
    expect(bent.clear([5, 5], [5, 25])).toBe(true);
  });
});

describe('making a wander', () => {
  const house = lot(square(0, 0, 30, 30), [square(10, 10, 10, 10)], [15, -3]);
  const habit = { pace: 0.5, pause: { min: 60, max: 300 } };

  it('covers the stay, pausing and moving by turns, at no more than the pace', () => {
    const wander = makeWander(groundOf(house), createRng(5), 10_000, 40_000, habit);
    expect(WanderSchema.safeParse(wander).success).toBe(true);
    expect(wander.times[0]).toBe(10_000);
    expect(wander.times.at(-1)).toBe(40_000);
    let pauses = 0;
    let moves = 0;
    for (let leg = 1; leg < wander.times.length; leg++) {
      const elapsed = wander.times[leg]! - wander.times[leg - 1]!;
      const moved = distance(wander.points[leg - 1]!, wander.points[leg]!);
      expect(moved).toBeLessThanOrEqual(habit.pace * elapsed + 1e-9);
      if (moved === 0) {
        pauses++;
        expect(elapsed).toBeGreaterThanOrEqual(1);
        expect(elapsed).toBeLessThanOrEqual(300);
      } else moves++;
    }
    expect(pauses).toBeGreaterThan(50);
    expect(moves).toBeGreaterThan(50);
  });

  it('never passes through a footprint or leaves the lot, even round a house in the middle of it', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const wander = makeWander(groundOf(house), createRng(seed), 0, 30_000, habit);
      for (let leg = 1; leg < wander.points.length; leg++) {
        const from = wander.points[leg - 1]!;
        const to = wander.points[leg]!;
        expect(onGround(house, to)).toBe(true);
        // Sampled all along the way.
        for (let step = 0; step <= 20; step++) {
          const point: Point = [from[0] + ((to[0] - from[0]) * step) / 20, from[1] + ((to[1] - from[1]) * step) / 20];
          expect(onGround(house, point), `seed ${seed}, leg ${leg}`).toBe(true);
        }
        for (const outline of [house.polygon, ...house.footprints]) {
          outline.forEach((corner, index) => expect(piecesCross(from, to, corner, outline[(index + 1) % outline.length]!)).toBe(false));
        }
      }
    }
  });

  it('is the same for the same stream, and stands still at a pace of zero or with no habit', () => {
    const make = (seed: number, how: typeof habit | undefined) => makeWander(groundOf(house), createRng(seed), 0, 20_000, how);
    expect(make(9, habit)).toEqual(make(9, habit));
    expect(make(9, habit)).not.toEqual(make(10, habit));
    for (const still of [make(9, { ...habit, pace: 0 }), make(9, undefined)]) {
      expect(still.times).toEqual([0, 20_000]);
      expect(still.points[0]).toEqual(still.points[1]);
      expect(onGround(house, still.points[0]!)).toBe(true);
    }
  });

  it('ends a stay that is over mid-stride part of the way there', () => {
    // A stay too short for the first pause to end: one point, held.
    const brief = makeWander(groundOf(house), createRng(4), 0, 30, habit);
    expect(brief.times).toEqual([0, 30]);
    // Many short stays: whenever the last leg is a move, it is no faster than the pace.
    for (let seed = 0; seed < 200; seed++) {
      const wander = makeWander(groundOf(house), createRng(seed), 0, 400, habit);
      expect(wander.times.at(-1)).toBe(400);
      const last = wander.times.length - 1;
      expect(distance(wander.points[last - 1]!, wander.points[last]!)).toBeLessThanOrEqual(habit.pace * (wander.times[last]! - wander.times[last - 1]!) + 1e-9);
    }
  });
});

describe('residents outside', () => {
  it('each have a wander that covers exactly their stay', () => {
    const { life } = badanos;
    let stays = 0;
    let moving = 0;
    for (const day of [1, 7]) {
      for (const plan of life.plansForDay(day)) {
        for (const stay of outsideOf(plan)) {
          stays++;
          const wander = stay.wander!;
          expect(wander.times[0], plan.personId).toBe(stay.start);
          expect(wander.times.at(-1), plan.personId).toBe(stay.end);
          if (new Set(wander.points.map((point) => point.join())).size > 1) moving++;
        }
        // Nobody indoors has one.
        for (const activity of plan.activities) if (activity.kind !== 'travel' && !activity.outside) expect(activity).not.toHaveProperty('wander');
      }
    }
    expect(stays).toBeGreaterThan(5000);
    // All but the shortest stays have the person move at least once.
    expect(moving / stays).toBeGreaterThan(0.95);
  });

  it('are, at every sampled moment, inside the lot and outside every footprint', { timeout: SLOW }, () => {
    const { life } = badanos;
    let sampled = 0;
    let withBuilding = 0;
    for (const plan of life.plansForDay(1)) {
      for (const stay of outsideOf(plan)) {
        const ground = lots.get(stay.buildingId)!;
        if (ground.footprints.length > 0) withBuilding++;
        // Moments all through the stay, at the whereabouts query and on the wander itself.
        for (let step = 0; step < 12; step++) {
          const time = stay.start + ((stay.end - stay.start - 1) * step) / 11;
          const where = life.whereabouts(plan.personId, time);
          if (where.kind === 'travel' || !where.outside) throw new Error(`${plan.personId} is not outside at ${time}`);
          if (!onGround(ground, where.point!)) throw new Error(`${plan.personId} at ${time} is at ${where.point} on ${ground.id}, which is not open ground`);
          expect(where.point).toEqual(positionOnWander(stay.wander!, time));
          sampled++;
        }
      }
    }
    expect(sampled).toBeGreaterThan(30_000);
    // Many of them on lots that have a building to keep out of.
    expect(withBuilding).toBeGreaterThan(1500);
  });

  it('move, between any two moments, no further than the pace allows', () => {
    const { life } = badanos;
    const rng = createRng(31);
    let pairs = 0;
    let furthest = 0;
    for (const plan of life.plansForDay(1)) {
      for (const stay of outsideOf(plan)) {
        for (let pair = 0; pair < 6; pair++) {
          const a = stay.start + rng.next() * (stay.end - stay.start);
          const b = stay.start + rng.next() * (stay.end - stay.start);
          const moved = distance(positionOnWander(stay.wander!, a), positionOnWander(stay.wander!, b));
          if (moved > PACE * Math.abs(a - b) + 1e-6) throw new Error(`${plan.personId} moves ${moved} m in ${Math.abs(a - b)} s`);
          furthest = Math.max(furthest, moved);
          pairs++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(15_000);
    expect(furthest).toBeGreaterThan(10);
  });

  it('have the same wander for the same inputs, whatever else was worked out first', () => {
    const { city, layout } = badanos;
    const a = createLife({ city, layout, pack });
    const b = createLife({ city, layout, pack });
    b.plansForDay(4);
    b.nearby([0, 0], 500, at(2, 12));
    const people = city.people.filter((_, index) => index % 7 === 0);
    for (const person of [...people].reverse()) b.whereabouts(person.id, at(3, 10, 30));
    for (const person of people) expect(a.plan(person.id, 3)).toEqual(b.plan(person.id, 3));
    expect(JSON.stringify(a.plansForDay(3))).toBe(JSON.stringify(b.plansForDay(3)));
    // A different seed, a different wander on the same ground.
    const other = createLife({ city, layout, pack, seed: 99 });
    expect(JSON.stringify(other.outsideStays(at(3, 10), at(3, 11)))).not.toBe(JSON.stringify(a.outsideStays(at(3, 10), at(3, 11))));
  });

  it('do not move at all when the pack\'s pace is zero, or when the pack says nothing of it', { timeout: SLOW }, () => {
    for (const still of [edited((raw) => (raw.species.human.life.outside.pace = 0)), edited((raw) => delete raw.species.human.life.outside)]) {
      const { city, layout, life } = town('settlement-641', still);
      const checker = createPlanChecker({ city, layout, pack: still });
      let stays = 0;
      for (const plan of life.plansForDay(1)) {
        for (const stay of outsideOf(plan)) {
          stays++;
          expect(stay.wander!.times).toEqual([stay.start, stay.end]);
          expect(stay.wander!.points[0]).toEqual(stay.wander!.points[1]);
        }
      }
      expect(stays).toBeGreaterThan(3000);
      expect(life.plansForDay(1).filter((_, index) => index % 20 === 0).flatMap((plan) => checker.check(plan))).toEqual([]);
      // Standing still, but still somewhere on the open ground.
      const someone = life.outsideStays(at(1, 12), at(1, 12, 10))[0]!;
      expect(positionOnWander(someone.wander, at(1, 12))).toEqual(positionOnWander(someone.wander, at(1, 12, 9)));
    }
  });

  it('move faster when the pack\'s pace is raised, and pause for as long as the pack says', { timeout: SLOW }, () => {
    const brisk = edited((raw) => Object.assign(raw.species.human.life.outside, { pace: 2, pauseMinutes: { min: 20, max: 30 } }));
    const { life } = town('settlement-641', brisk);
    let fastest = 0;
    for (const plan of life.plansForDay(1).slice(0, 3000)) {
      for (const stay of outsideOf(plan)) {
        const { times, points } = stay.wander!;
        for (let leg = 1; leg < times.length; leg++) {
          const elapsed = times[leg]! - times[leg - 1]!;
          const moved = distance(points[leg - 1]!, points[leg]!);
          if (moved > 0) fastest = Math.max(fastest, moved / elapsed);
          // A pause that is not cut short by the stay's end lasts between 20 and 30 minutes.
          else if (leg < times.length - 1) expect(elapsed >= 20 * 60 && elapsed <= 30 * 60, `${plan.personId}: a pause of ${elapsed} s`).toBe(true);
        }
      }
    }
    expect(fastest).toBeGreaterThan(PACE);
    expect(fastest).toBeLessThanOrEqual(2 + 1e-9);
  });
});

describe('unchanged behaviour', () => {
  it('keeps every activity, building, time and trip of Badanos over eight days as they were at life version 2', { timeout: SLOW }, () => {
    const baseline = JSON.parse(readFileSync(new URL('./baselines/badanos-life-v2.json', import.meta.url), 'utf8')) as { planHash: Record<string, string> };
    expect(Object.keys(baseline.planHash)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    // The fingerprint is of the town before phase 6B gave it civic buildings, rounds and errands.
    const before = town('settlement-641', medievalPackBefore6B());
    for (const [day, hash] of Object.entries(baseline.planHash)) {
      // Everything but where on the lot an outside stay is spent.
      const plans = before.life.plansForDay(Number(day)).map((plan) => ({ ...plan, activities: plan.activities.map(({ wander: _wander, ...rest }: any) => rest) }));
      expect(createHash('sha256').update(JSON.stringify(plans)).digest('hex'), `day ${day}`).toBe(hash);
    }
    expect(LIFE_VERSION).toBe(3);
    expect(GENERATOR_VERSION).toBe(3);
  });
});
