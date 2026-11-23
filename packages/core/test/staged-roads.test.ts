/**
 * Phase 6E, step 1: the staged generator's water, highways, bridges and
 * harbour, checked for every settlement of Lomia.
 */
import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/index.ts';
import { bearingDifference, bearingVector, distance, exactBearing, pointAlongPolyline, polylineLength } from '../src/layout/geometry.ts';
import { type TownPlan, planTown, stagedSettings } from '../src/layout/staged/plan.ts';
import { plazaRadius } from '../src/layout/staged/special.ts';
import type { Point, SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack, rawMedievalPack, settlement } from './pack.ts';
import { parsePack } from '../src/index.ts';

const pack = medievalPack();
const settings = stagedSettings(pack);
let plans: Array<{ brief: SettlementBrief; plan: TownPlan }> | undefined;
/** Every settlement's plan, made once. */
function everyPlan() {
  return (plans ??= lomiaWorld().settlements.map((brief) => ({ brief, plan: planTown(brief, generateCity(brief, pack).buildings.length, pack) })));
}
const planOf = (id: string) => everyPlan().find(({ brief }) => brief.id === id) as { brief: SettlementBrief; plan: TownPlan };
const samples = (points: readonly Point[], step = 5) => {
  const length = polylineLength(points);
  const out: Point[] = [];
  for (let along = 0; along <= length; along += step) out.push(pointAlongPolyline(points, along));
  return out;
};
const sizeRule = (buildings: number) => (settings.bridges.counts.find((entry) => entry.below === undefined || buildings < entry.below) as { bridges: number }).bridges;

describe('water', () => {
  it('a river reaches the edge on the bearings the brief gives', () => {
    for (const { brief, plan } of everyPlan()) {
      if (!brief.river) continue;
      const river = plan.river;
      expect(river, brief.name).toBeDefined();
      if (!river) continue;
      const first = river.line[0] as Point;
      const last = river.line[river.line.length - 1] as Point;
      if (brief.river.arrivesFrom) expect(bearingDifference(exactBearing([0, 0], first), brief.river.arrivesFrom.bearing), brief.name).toBeLessThan(5);
      if (brief.river.leavesToward) expect(bearingDifference(exactBearing([0, 0], last), brief.river.leavesToward.bearing), brief.name).toBeLessThan(5);
      expect(Math.hypot(...last), brief.name).toBeGreaterThan(plan.reach);
    }
  });

  it('a river passes the centre at a distance from the pack range, nearer and wider in a river port', () => {
    for (const { brief, plan } of everyPlan()) {
      if (!plan.river) continue;
      const riverPort = brief.flags.port && !brief.coast.isCoastal;
      const range = riverPort ? settings.river.portDistance : settings.river.distance;
      expect(plan.river.distance / plan.radius, brief.name).toBeGreaterThanOrEqual(range.min);
      // In a small town the room the plaza and a quay road need may be more than the range allows.
      const room = plan.river.width / 2 + plazaRadius(plan.buildings, settings) + settings.widths.highway;
      expect(plan.river.distance, brief.name).toBeLessThanOrEqual(Math.max(range.max * plan.radius, room) + 1e-6);
      expect(plan.river.nearest([0, 0]).distance, brief.name).toBeCloseTo(plan.river.distance, 6);
      // Between the centre and the bank there is room for the plaza and a quay road.
      expect(plan.river.gap([0, 0]), brief.name).toBeGreaterThanOrEqual(plazaRadius(plan.buildings, settings) + settings.widths.highway - 1e-6);
      expect(plan.astride, brief.name).toBe(plan.river.nearest([0, 0]).distance <= settings.bridges.astrideWithin * plan.radius);
      expect(plan.river.width, brief.name).toBe(settings.river.width * (riverPort ? settings.river.portWidth : 1));
    }
  });

  it('a coastal settlement has sea toward its water bearing and none behind it, and stands on land', () => {
    for (const { brief, plan } of everyPlan()) {
      expect(plan.coast !== undefined, brief.name).toBe(brief.coast.isCoastal);
      if (!plan.coast) continue;
      const toward = bearingVector(brief.coast.waterBearing as number);
      expect(plan.coast.gap([toward[0] * plan.reach, toward[1] * plan.reach]), brief.name).toBeLessThan(0);
      expect(plan.coast.gap([-toward[0] * plan.reach, -toward[1] * plan.reach]), brief.name).toBeGreaterThan(0);
      expect(plan.coast.gap([0, 0]), brief.name).toBeGreaterThan(0.25 * plan.radius);
    }
  });
});

describe('highways', () => {
  it('every land route has an exit on dry land near its bearing, and a highway that ends there', () => {
    for (const { brief, plan } of everyPlan()) {
      const land = brief.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.kind !== 'sea-route');
      expect(plan.exits.filter((exit) => !exit.atQuay).map((exit) => exit.route), brief.name).toEqual(land.map(({ index }) => index));
      for (const exit of plan.exits.filter((entry) => !entry.atQuay)) {
        const route = brief.routes[exit.route] as SettlementBrief['routes'][number];
        expect(bearingDifference(exit.bearing, route.bearing), `${brief.name} route ${exit.route}`).toBeLessThanOrEqual(settings.highways.exitShift);
        if (plan.river) expect(plan.river.gap(exit.point), brief.name).toBeGreaterThan(0);
        if (plan.coast) expect(plan.coast.gap(exit.point), brief.name).toBeGreaterThan(0);
        const carrying = plan.highways.filter((highway) => highway.routes.includes(exit.route));
        expect(carrying.length, `${brief.name} route ${exit.route}`).toBe(1);
        const points = (carrying[0] as TownPlan['highways'][number]).points;
        expect(Math.min(distance(points[0] as Point, exit.point), distance(points[points.length - 1] as Point, exit.point)), `${brief.name} route ${exit.route}`).toBeLessThan(1);
      }
    }
  });

  it('no highway is in the water but on a bridge', () => {
    for (const { brief, plan } of everyPlan()) {
      for (const highway of plan.highways) {
        for (const point of samples(highway.points)) {
          if (plan.river && plan.river.gap(point) < 0) expect(plan.bridges.some((bridge) => distance(point, bridge.centre) < distance(bridge.a, bridge.b) / 2 + 1), `${brief.name}: a ${highway.kind} highway in the river`).toBe(true);
          if (plan.coast && highway.kind !== 'quay-road') expect(plan.coast.gap(point), `${brief.name}: a ${highway.kind} highway in the sea`).toBeGreaterThanOrEqual(0);
        }
      }
      for (const street of plan.mainStreets) {
        for (const point of samples(street)) {
          if (plan.river) expect(plan.river.gap(point), `${brief.name}: a main street in the river`).toBeGreaterThan(0);
          if (plan.coast) expect(plan.coast.gap(point), `${brief.name}: a main street in the sea`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('every highway but a through road starts on another road or at the centre', () => {
    for (const { brief, plan } of everyPlan()) {
      for (const highway of plan.highways) {
        if (highway.kind === 'route' && highway.routes.length === 2) continue;
        const start = highway.points[0] as Point;
        const others = plan.highways.filter((other) => other !== highway);
        const near = Math.hypot(...start) < 1 || others.some((other) => samples(other.points, 3).some((point) => distance(point, start) < 20));
        expect(near, `${brief.name}: a ${highway.kind} highway starts nowhere`).toBe(true);
      }
    }
  });
});

describe('bridges', () => {
  it('stand square to the bank, within 10 degrees, with both ends on dry land', () => {
    for (const { brief, plan } of everyPlan()) {
      for (const bridge of plan.bridges) {
        const river = plan.river as NonNullable<TownPlan['river']>;
        const { direction } = river.at(bridge.along);
        const over = [(bridge.b[0] - bridge.a[0]) / distance(bridge.a, bridge.b), (bridge.b[1] - bridge.a[1]) / distance(bridge.a, bridge.b)] as Point;
        const off = (Math.asin(Math.min(1, Math.abs(direction[0] * over[0] + direction[1] * over[1]))) * 180) / Math.PI;
        expect(off, brief.name).toBeLessThan(10);
        expect(river.gap(bridge.a), brief.name).toBeGreaterThan(0);
        expect(river.gap(bridge.b), brief.name).toBeGreaterThan(0);
        expect(river.side(bridge.a), brief.name).toBe(river.side([0, 0]));
        expect(river.side(bridge.b), brief.name).not.toBe(river.side([0, 0]));
      }
    }
  });

  it('stand only where a route crosses the river or the town is astride it, as many as the size rule says', () => {
    let short = 0;
    let none = 0;
    for (const { brief, plan } of everyPlan()) {
      if (!plan.river) {
        expect(plan.bridges.length, brief.name).toBe(0);
        expect(plan.farBank, brief.name).toBe(false);
        continue;
      }
      const crossed = plan.exits.some((exit) => !exit.atQuay && (plan.river as NonNullable<TownPlan['river']>).crossed([0, 0], exit.point));
      expect(plan.farBank, brief.name).toBe(plan.bridges.length > 0);
      if (!crossed && !plan.astride) {
        // Beside a river no route crosses: no bridge, and no ground across the river.
        none++;
        expect(plan.bridges.length, brief.name).toBe(0);
        expect(plan.mainStreets.length, brief.name).toBe(0);
        continue;
      }
      const wanted = sizeRule(plan.buildings);
      expect(plan.bridges.length, brief.name).toBeLessThanOrEqual(wanted);
      if (plan.bridges.length < wanted) {
        short++;
        expect(plan.notes.some((note) => /bridge|river/.test(note)), `${brief.name} has ${plan.bridges.length} of ${wanted} bridges and no note`).toBe(true);
      }
      expect(plan.bridges.filter((bridge) => bridge.main).length, brief.name).toBe(plan.bridges.length > 0 ? 1 : 0);
      // Every bridge carries exactly one road, but the main one, which every highway over the river uses.
      plan.bridges.forEach((bridge, index) => {
        const carried = plan.highways.filter((highway) => highway.bridges.includes(index)).length;
        if (bridge.main) expect(carried, brief.name).toBeGreaterThanOrEqual(1);
        else expect(carried, brief.name).toBe(1);
      });
      // Astride with no route across, each bridge's road runs on into the far bank as a main street from its far end.
      if (!crossed) {
        expect(plan.mainStreets.length, brief.name).toBe(plan.bridges.length);
        for (const street of plan.mainStreets) expect(Math.min(...plan.bridges.map((bridge) => distance(bridge.b, street[0] as Point))), brief.name).toBeLessThan(1e-6);
      } else expect(plan.mainStreets.length, brief.name).toBe(0);
    }
    console.log(`${none} river towns stand beside a river no route crosses and have no bridge; ${short} have fewer bridges than the size rule`);
    expect(short).toBeLessThanOrEqual(3);
  });

  it('further bridges stand a share of the radius apart along the bank, and no less than the pack\'s floor', () => {
    for (const { brief, plan } of everyPlan()) {
      const alongs = plan.bridges.map((bridge) => bridge.along).sort((a, b) => a - b);
      const { apart, apartLeast } = settings.bridges;
      for (let at = 1; at < alongs.length; at++) {
        const gap = (alongs[at] as number) - (alongs[at - 1] as number);
        expect(gap, brief.name).toBeGreaterThanOrEqual(Math.max(apart.min * plan.radius, apartLeast) - 1e-6);
        expect(gap, brief.name).toBeLessThanOrEqual(2 * Math.max(apart.max * plan.radius, apartLeast) + 1e-6);
      }
    }
  });
});

describe('harbour', () => {
  it('every port has a quay, and a settlement with a sea route but no port flag a single jetty: on the coast if it has one, otherwise on its river', () => {
    for (const { brief, plan } of everyPlan()) {
      const seaRoutes = brief.routes.flatMap((route, index) => (route.kind === 'sea-route' ? [index] : []));
      if (!brief.flags.port && seaRoutes.length === 0) {
        expect(plan.harbour, brief.name).toBeUndefined();
        continue;
      }
      expect(plan.harbour?.on, brief.name).toBe(brief.coast.isCoastal ? 'coast' : 'river');
      const harbour = plan.harbour as NonNullable<TownPlan['harbour']>;
      expect(harbour.kind, brief.name).toBe(brief.flags.port ? 'quay' : 'jetty');
      expect(harbour.piers.length, brief.name).toBe(brief.flags.port ? settings.harbour.piers.count : 1);
      const gap = (point: Point) => (harbour.on === 'coast' ? (plan.coast as NonNullable<TownPlan['coast']>).gap(point) : (plan.river as NonNullable<TownPlan['river']>).gap(point));
      // The quay is on land at the water's edge, and each pier runs from it out over the water.
      for (const point of harbour.quay) {
        expect(gap(point), brief.name).toBeGreaterThan(0);
        expect(gap(point), brief.name).toBeLessThan(3 * settings.harbour.quay.inset);
      }
      for (const [foot, head] of harbour.piers) {
        expect(gap(foot), brief.name).toBeGreaterThan(0);
        expect(gap(head), brief.name).toBeLessThan(0);
        if (harbour.on === 'river') expect(-gap(head), brief.name).toBeLessThanOrEqual(settings.harbour.jettyShare * (plan.river as NonNullable<TownPlan['river']>).width * 1.01);
      }
      // The sea routes end at the quay, each with its exit at one end of it.
      const road = plan.highways.filter((highway) => highway.kind === 'quay-road');
      expect(road.length, brief.name).toBe(1);
      const points = (road[0] as TownPlan['highways'][number]).points;
      expect(Math.hypot(...(points[0] as Point)), brief.name).toBeLessThan(1);
      expect(Math.min(...harbour.quay.map((point) => distance(point, points[points.length - 1] as Point))), brief.name).toBeLessThan(1);
      expect((road[0] as TownPlan['highways'][number]).routes, brief.name).toEqual(seaRoutes);
      expect(plan.exits.filter((exit) => exit.atQuay).map((exit) => exit.route), brief.name).toEqual(seaRoutes);
      const ends = [harbour.quay[0] as Point, harbour.quay[harbour.quay.length - 1] as Point];
      for (const exit of plan.exits.filter((entry) => entry.atQuay)) expect(Math.min(...ends.map((end) => distance(end, exit.point))), brief.name).toBeLessThan(1e-6);
      // One exit for every route of the brief, in the brief's order.
      expect(plan.exits.map((exit) => exit.route), brief.name).toEqual(brief.routes.map((_, index) => index));
    }
  });

  it('a river wharf keeps clear of the bridges', () => {
    for (const { brief, plan } of everyPlan()) {
      if (plan.harbour?.on !== 'river') continue;
      for (const bridge of plan.bridges) expect(Math.min(...plan.harbour.quay.map((point) => distance(point, bridge.a))), brief.name).toBeGreaterThan(settings.harbour.clearOfBridge * 0.8);
    }
  });
});

describe('named settlements', () => {
  it('Badanos stands astride its river, which no route crosses: two bridges, each with a main street beyond', () => {
    const { plan } = planOf('settlement-641');
    expect(plan.buildings).toBe(1825);
    expect(plan.astride).toBe(true);
    expect(plan.bridges.length).toBe(2);
    expect(plan.mainStreets.length).toBe(2);
    expect(plan.exits.map((exit) => exit.route)).toEqual([0, 1]);
    expect(plan.harbour).toBeUndefined();
    // The one through road carries both ends of the trail.
    expect(plan.highways.filter((highway) => highway.kind === 'route').map((highway) => highway.routes.length)).toEqual([2]);
  });

  it('Pombal is a river port: a wider river, three bridges, and a wharf where both its sea routes end', () => {
    const { plan } = planOf('settlement-5');
    expect(plan.river?.width).toBe(settings.river.width * settings.river.portWidth);
    expect(plan.bridges.length).toBe(3);
    expect(plan.harbour).toMatchObject({ on: 'river', kind: 'quay' });
    expect(plan.exits.map((exit) => exit.atQuay)).toEqual([true, true, false, false]);
  });

  it('Cevilefon is a sea port with a quay on the coast and no bridge', () => {
    const { plan } = planOf('settlement-3');
    expect(plan.harbour).toMatchObject({ on: 'coast', kind: 'quay' });
    expect(plan.harbour?.piers.length).toBe(settings.harbour.piers.count);
    expect(plan.bridges.length).toBe(0);
  });

  it('Karlen has sea routes but is no port: a single jetty on its river', () => {
    const { plan } = planOf('settlement-8');
    expect(plan.harbour).toMatchObject({ on: 'river', kind: 'jetty' });
    expect(plan.harbour?.piers.length).toBe(1);
    expect(plan.exits.filter((exit) => exit.atQuay).length).toBe(2);
  });
});

describe('determinism and pack edits', () => {
  it('the same brief, pack and seed give the same plan, and another seed a different one', () => {
    const brief = settlement('settlement-641');
    const lines = (plan: TownPlan) => JSON.stringify([plan.river?.line, plan.highways, plan.bridges, plan.exits, plan.harbour]);
    expect(lines(planTown(brief, 1825, pack))).toBe(lines(planTown(brief, 1825, pack)));
    expect(lines(planTown(brief, 1825, pack, brief.seed + 1))).not.toBe(lines(planTown(brief, 1825, pack)));
  });

  it('widening the river in a copy of the pack widens it in Badanos, and lengthens its bridges', () => {
    const raw = rawMedievalPack();
    raw.layout.staged.river.width = 50;
    const wide = planTown(settlement('settlement-641'), 1825, parsePack(raw));
    const { plan } = planOf('settlement-641');
    expect(wide.river?.width).toBe(50);
    expect(distance((wide.bridges[0] as TownPlan['bridges'][number]).a, (wide.bridges[0] as TownPlan['bridges'][number]).b)).toBeCloseTo(distance((plan.bridges[0] as TownPlan['bridges'][number]).a, (plan.bridges[0] as TownPlan['bridges'][number]).b) + 20, 6);
  });

  it('a pack without the staged block still loads, and the staged generator says what it needs', () => {
    const raw = rawMedievalPack();
    delete raw.layout.staged;
    expect(() => planTown(settlement('settlement-641'), 1825, parsePack(raw))).toThrow(/staged/);
  });
});
