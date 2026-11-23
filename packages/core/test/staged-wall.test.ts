/**
 * Phase 6E, step 2: the staged generator's wall, plaza and castle, checked
 * for every settlement of Lomia.
 */
import { describe, expect, it } from 'vitest';
import { generateCity, parsePack } from '../src/index.ts';
import { crossingsOfPolyline, distance, distanceBetweenPolygons, distancePolygonToPolyline, distanceToPolyline, pointAlongPolyline, pointInPolygon, polygonArea, polylineLength } from '../src/layout/geometry.ts';
import { crossingsAlong } from '../src/layout/staged/lines.ts';
import { type TownPlan, planTown, stagedSettings } from '../src/layout/staged/plan.ts';
import { specialArea } from '../src/layout/staged/special.ts';
import type { Wall } from '../src/layout/staged/wall.ts';
import type { Point, SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const settings = stagedSettings(pack);
let plans: Array<{ brief: SettlementBrief; plan: TownPlan }> | undefined;
/** Every settlement's plan, made once. */
function everyPlan() {
  return (plans ??= lomiaWorld().settlements.map((brief) => ({ brief, plan: planTown(brief, generateCity(brief, pack).buildings.length, pack) })));
}
const named = (name: string) => everyPlan().find(({ brief }) => brief.name === name) as { brief: SettlementBrief; plan: TownPlan };
const walled = () => everyPlan().filter(({ plan }) => plan.wall) as Array<{ brief: SettlementBrief; plan: TownPlan & { wall: Wall } }>;
const lineOf = (part: Wall['parts'][number]) => (part.closed ? [...part.points, part.points[0] as Point] : part.points);
const samples = (points: readonly Point[], step = 3) => {
  const length = polylineLength(points);
  const out: Point[] = [];
  for (let along = 0; along <= length; along += step) out.push(pointAlongPolyline(points, along));
  return out;
};

describe('the wall', () => {
  it('stands exactly where the brief is flagged for one', () => {
    for (const { brief, plan } of everyPlan()) expect(plan.wall !== undefined, brief.name).toBe(brief.flags.walls);
    expect(walled().length).toBe(107);
  });

  it('is a ring about the centre holding ground for the pack share of the buildings, long or round by its roads', () => {
    for (const { brief, plan } of walled()) {
      const { wall } = plan;
      const wanted = settings.wall.share * plan.buildings * settings.wall.perBuilding;
      // Towers stand on the curve and the wall runs straight between them, so the ring holds a little less.
      expect(polygonArea(wall.ring) / wanted, brief.name).toBeGreaterThan(0.85);
      expect(polygonArea(wall.ring) / wanted, brief.name).toBeLessThan(1.1);
      expect(pointInPolygon([0, 0], wall.ring), brief.name).toBe(true);
      expect([settings.wall.long, settings.wall.round].some((ratio) => Math.abs(wall.long / wall.short - ratio) < 1e-9), brief.name).toBe(true);
    }
  });

  it('has towers about the pack spacing apart, and runs straight between them', () => {
    for (const { brief, plan } of walled()) {
      const { ring } = plan.wall;
      expect(ring.length, brief.name).toBeGreaterThanOrEqual(settings.wall.towers.least);
      const most = Math.max(...ring.map((tower, at) => distance(tower, ring[(at + 1) % ring.length] as Point)));
      const round = ring.reduce((sum, tower, at) => sum + distance(tower, ring[(at + 1) % ring.length] as Point), 0);
      expect(most, brief.name).toBeLessThan((1 + 2 * settings.wall.towers.jitter + 0.1) * Math.max(settings.wall.towers.spacing * 1.5, round / ring.length));
    }
  });

  it('never stands in water or on a quay, and where it is open it ends at a bank, a shore or a quay', () => {
    let open = 0;
    for (const { brief, plan } of walled()) {
      const wet = (point: Point, slack: number) => (plan.river !== undefined && plan.river.gap(point) < slack) || (plan.coast !== undefined && plan.coast.gap(point) < slack) || (plan.harbour !== undefined && distanceToPolyline(point, plan.harbour.quay) < plan.harbour.width / 2 + slack);
      expect(plan.wall.parts.length, brief.name).toBeGreaterThan(0);
      for (const part of plan.wall.parts) {
        for (const point of samples(lineOf(part))) expect(wet(point, -0.2), brief.name).toBe(false);
        if (part.closed) continue;
        open++;
        expect(polylineLength(part.points), brief.name).toBeGreaterThanOrEqual(settings.wall.shortest);
        for (const end of [part.points[0] as Point, part.points[part.points.length - 1] as Point]) expect(wet(end, 0.2), brief.name).toBe(true);
      }
      expect(plan.wall.parts.some((part) => part.closed) ? plan.wall.parts.length : 1, brief.name).toBe(1);
    }
    expect(open).toBeGreaterThan(50);
  });

  it('leaves the far bank out where little of the ring lies across the river or no bridge leads there', () => {
    let dropped = 0;
    let both = 0;
    for (const { brief, plan } of walled()) {
      const { wall } = plan;
      expect(wall.farDropped, brief.name).toBe(wall.farShare > 0 && (wall.farShare < settings.wall.dropFarBelow || !plan.farBank));
      const across = (point: Point) => crossingsOfPolyline([0, 0], point, (plan.river as NonNullable<TownPlan['river']>).line) % 2 === 1;
      const far = plan.river ? wall.parts.filter((part) => across(pointAlongPolyline(part.points, polylineLength(part.points) / 2))).length : 0;
      if (wall.farDropped) {
        dropped++;
        expect(far, brief.name).toBe(0);
        for (const tower of wall.towers) expect(wall.inside(tower) || !across(tower), brief.name).toBe(true);
      } else if (wall.farShare > 0) {
        both++;
        expect(far, brief.name).toBeGreaterThan(0);
      }
    }
    expect({ dropped, both }).toEqual({ dropped: 38, both: 3 });
  });

  it('has a gate wherever a highway or a main street crosses it, and at each bridge into a bank the river closes', () => {
    let gates = 0;
    for (const { brief, plan } of walled()) {
      const { wall } = plan;
      const lines = wall.parts.map(lineOf);
      const roads = [...plan.highways.map((highway, index) => ({ points: highway.points, highway: index as number | undefined, mainStreet: undefined as number | undefined })), ...plan.mainStreets.map((points, index) => ({ points, highway: undefined, mainStreet: index }))];
      for (const road of roads) {
        const crossings = lines.flatMap((line) => crossingsAlong(road.points, line).map((along) => pointAlongPolyline(road.points, along)));
        // In at most once and out at most once.
        expect(crossings.length, `${brief.name}: a road crosses the wall ${crossings.length} times`).toBeLessThanOrEqual(2);
        for (const crossing of crossings) {
          const gate = wall.gates.find((entry) => entry.highway === road.highway && entry.mainStreet === road.mainStreet && distance(entry.point, crossing) <= settings.widths.highway + settings.bridges.landing);
          expect(gate, `${brief.name}: no gate where a road crosses the wall`).toBeDefined();
        }
      }
      for (const gate of wall.gates) {
        gates++;
        if (gate.bridge !== undefined) {
          const bridge = plan.bridges[gate.bridge] as TownPlan['bridges'][number];
          expect(Math.min(distance(gate.point, bridge.a), distance(gate.point, bridge.b)), brief.name).toBeLessThan(1e-6);
        } else expect(Math.min(...lines.map((line) => distanceToPolyline(gate.point, line))), brief.name).toBeLessThan(1e-6);
      }
      if (wall.farDropped) plan.bridges.forEach((bridge, index) => expect(wall.gates.some((gate) => gate.bridge === index), `${brief.name}: bridge ${index}`).toBe(pointInPolygon(bridge.a, wall.ring)));
    }
    expect(gates).toBeGreaterThan(250);
  });
});

describe('special wards', () => {
  it('a plaza lies at the centre of exactly the towns flagged for one, within its size limits and clear of water', () => {
    let count = 0;
    for (const { brief, plan } of everyPlan()) {
      expect(plan.plaza !== undefined, brief.name).toBe(brief.flags.plaza);
      if (!plan.plaza) continue;
      count++;
      const wanted = specialArea(plan.buildings, settings, settings.plaza);
      expect(wanted, brief.name).toBeLessThanOrEqual(settings.plaza.max);
      expect(wanted, brief.name).toBeGreaterThanOrEqual(Math.min(settings.plaza.min, settings.plaza.groundShare * plan.buildings * settings.extent.perBuilding));
      expect(polygonArea(plan.plaza.polygon), brief.name).toBeCloseTo(wanted, 4);
      expect(plan.plaza.polygon.length, brief.name).toBe(settings.plaza.sides);
      expect(pointInPolygon([0, 0], plan.plaza.polygon), brief.name).toBe(true);
      for (const corner of plan.plaza.polygon) {
        if (plan.river) expect(plan.river.gap(corner), brief.name).toBeGreaterThan(0);
        if (plan.coast) expect(plan.coast.gap(corner), brief.name).toBeGreaterThan(0);
      }
      if (plan.wall) for (const corner of plan.plaza.polygon) expect(plan.wall.inside(corner), brief.name).toBe(true);
    }
    expect(count).toBe(26);
  });

  it('a castle stands in every town flagged for a citadel: inside the wall, off the plaza, clear of every road and of water', () => {
    let count = 0;
    for (const { brief, plan } of everyPlan()) {
      expect(plan.castle !== undefined, brief.name).toBe(brief.flags.citadel);
      const castle = plan.castle;
      if (!castle) continue;
      count++;
      const rules = settings.castle;
      const wanted = specialArea(plan.buildings, settings, rules);
      expect(wanted, brief.name).toBeLessThanOrEqual(rules.max);
      expect(polygonArea(castle.polygon), brief.name).toBeCloseTo(wanted, 4);
      expect(castle.polygon.length, brief.name).toBe(rules.sides);
      if (plan.wall) {
        for (const corner of castle.polygon) expect(plan.wall.inside(corner), brief.name).toBe(true);
        for (const part of plan.wall.parts) expect(distancePolygonToPolyline(castle.polygon, lineOf(part)), brief.name).toBeGreaterThanOrEqual(rules.fromWall);
      } else for (const corner of castle.polygon) expect(Math.hypot(...corner), brief.name).toBeLessThan(1.5 * plan.radius);
      for (const highway of plan.highways) expect(distancePolygonToPolyline(castle.polygon, highway.points), brief.name).toBeGreaterThanOrEqual(settings.widths.highway / 2 + rules.fromRoad);
      for (const street of plan.mainStreets) expect(distancePolygonToPolyline(castle.polygon, street), brief.name).toBeGreaterThanOrEqual(settings.widths.mainStreet / 2 + rules.fromRoad);
      if (plan.river) expect(distancePolygonToPolyline(castle.polygon, plan.river.line) - plan.river.width / 2, brief.name).toBeGreaterThanOrEqual(rules.fromWater);
      if (plan.coast) for (const corner of castle.polygon) expect(plan.coast.gap(corner), brief.name).toBeGreaterThanOrEqual(rules.fromWater);
      if (plan.plaza) expect(distanceBetweenPolygons(castle.polygon, plan.plaza.polygon), brief.name).toBeGreaterThan(settings.widths.wardBorder);
    }
    expect(count).toBe(102);
  });

  it('a village has a green and a tower house: both scale down with the ground the town needs', () => {
    const smallest = everyPlan().filter(({ plan }) => plan.castle).sort((a, b) => a.plan.buildings - b.plan.buildings)[0] as { plan: TownPlan };
    expect(smallest.plan.buildings).toBeLessThan(60);
    expect(smallest.plan.castle?.area).toBeCloseTo(settings.castle.groundShare * smallest.plan.buildings * settings.extent.perBuilding, 6);
    expect(smallest.plan.castle?.area).toBeLessThan(settings.castle.min);
  });
});

describe('named towns', () => {
  it('Karlen, beside its river: the river closes the wall, with a gate at each bridge, a plaza and a castle', () => {
    const { plan } = named('Karlen');
    expect(plan.wall?.farDropped).toBe(true);
    expect(plan.wall?.gates.filter((gate) => gate.bridge !== undefined).map((gate) => gate.bridge).sort()).toEqual([0, 1]);
    expect(plan.wall?.gates.length).toBe(4);
    expect(plan.plaza && plan.castle).toBeDefined();
  });

  it('Cevilefon, a sea port: one closed ring with a gate for each road, the quay outside it', () => {
    const { plan } = named('Cevilefon');
    expect(plan.wall?.parts.map((part) => part.closed)).toEqual([true]);
    expect(plan.wall?.gates.length).toBe(4);
    for (const point of plan.harbour?.quay ?? []) expect(pointInPolygon(point, plan.wall?.ring ?? [])).toBe(false);
  });

  it('Badanos has no wall, plaza or castle; drawn as if flagged, its wall is an oval along its one through road', () => {
    const { brief, plan } = named('Badanos');
    expect([plan.wall, plan.plaza, plan.castle]).toEqual([undefined, undefined, undefined]);
    const flagged = planTown({ ...brief, flags: { ...brief.flags, walls: true, plaza: true, citadel: true } }, plan.buildings, pack);
    expect((flagged.wall?.long ?? 0) / (flagged.wall?.short ?? 1)).toBeCloseTo(settings.wall.long, 9);
    expect(flagged.wall?.farDropped).toBe(true);
    expect(flagged.wall?.gates.length).toBe(4);
    expect(flagged.castle).toBeDefined();
    // Nothing earlier moved.
    expect(JSON.stringify([flagged.river?.line, flagged.highways, flagged.bridges])).toBe(JSON.stringify([plan.river?.line, plan.highways, plan.bridges]));
  });
});

describe('determinism and pack edits', () => {
  it('the same brief, pack and seed give the same wall and wards, and another seed different ones', () => {
    const brief = settlement(named('Karlen').brief.id);
    const drawn = (plan: TownPlan) => JSON.stringify([plan.wall?.ring, plan.wall?.parts, plan.wall?.gates, plan.plaza, plan.castle]);
    expect(drawn(planTown(brief, 2007, pack))).toBe(drawn(planTown(brief, 2007, pack)));
    expect(drawn(planTown(brief, 2007, pack, brief.seed + 1))).not.toBe(drawn(planTown(brief, 2007, pack)));
  });

  it('a larger share in a copy of the pack makes a larger ring, and a larger castle rule a larger castle', () => {
    const raw = rawMedievalPack();
    raw.layout.staged.wall.share = 0.7;
    raw.layout.staged.castle.min = 5000;
    const brief = settlement(named('Vereceldo').brief.id);
    const before = planTown(brief, 400, pack);
    const after = planTown(brief, 400, parsePack(raw));
    expect(polygonArea(after.wall?.ring ?? []) / polygonArea(before.wall?.ring ?? [])).toBeGreaterThan(1.2);
    const citadel = { ...brief, flags: { ...brief.flags, citadel: true } };
    expect(planTown(citadel, 400, parsePack(raw)).castle?.area).toBe(5000);
    expect(planTown(citadel, 400, pack).castle?.area).toBe(3500);
  });
});
