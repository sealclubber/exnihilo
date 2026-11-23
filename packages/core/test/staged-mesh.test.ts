/**
 * Phase 6E, step 3: the staged generator's ground, mesh, main streets and
 * wards, checked for every settlement of Lomia.
 */
import { describe, expect, it } from 'vitest';
import { generateCity, parsePack } from '../src/index.ts';
import { boxOf, crossingsOfPolyline, distance, distanceBetweenPolygons, distancePolygonToPolyline, distanceToPolyline, pointAlongPolyline, pointInPolygon, polygonArea, polylineLength } from '../src/layout/geometry.ts';
import { crossingsAlong } from '../src/layout/staged/lines.ts';
import { cellPolygon, wardCells } from '../src/layout/staged/mesh.ts';
import { type WardPlan as TownPlan, planSite, planWards, stagedSettings } from '../src/layout/staged/plan.ts';
import type { SettingPack } from '../src/index.ts';
import type { Point, SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const planTown = (brief: SettlementBrief, buildings: number, with_: SettingPack, seed?: number) => planWards(planSite(brief, buildings, with_, seed), with_);
const settings = stagedSettings(pack);
let plans: Array<{ brief: SettlementBrief; plan: TownPlan }> | undefined;
/** Every settlement's plan, made once. */
function everyPlan() {
  return (plans ??= lomiaWorld().settlements.map((brief) => ({ brief, plan: planTown(brief, generateCity(brief, pack).buildings.length, pack) })));
}
const named = (name: string) => everyPlan().find(({ brief }) => brief.name === name) as { brief: SettlementBrief; plan: TownPlan };
const ordinary = (plan: TownPlan) => plan.wards.filter((ward) => ward.kind === 'ordinary');
const wallLines = (plan: TownPlan) => (plan.wall ? plan.wall.parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points)) : []);
const across = (plan: TownPlan, point: Point) => plan.river !== undefined && crossingsOfPolyline([0, 0], point, plan.river.line) % 2 === 1;
const half = settings.widths.wardBorder / 2;

describe('ground', () => {
  it('is the pack multiple of what the buildings need, unless water leaves less', () => {
    const wanted = (plan: TownPlan) => settings.ground.factor * plan.buildings * settings.extent.perBuilding;
    let short = 0;
    for (const { brief, plan } of everyPlan()) {
      expect(plan.ground.area / wanted(plan), brief.name).toBeGreaterThan(0.6);
      // Filling hollows adds some.
      expect(plan.ground.area / wanted(plan), brief.name).toBeLessThan(1.6);
      if (plan.ground.area < 0.9 * wanted(plan)) short++;
      expect(plan.ground.has([0, 0], plan.ground.step), brief.name).toBe(true);
    }
    expect(short).toBeLessThan(30);
  });

  it('is dry, and lies on the far bank of a river only where a bridge leads there', () => {
    for (const { brief, plan } of everyPlan()) {
      const { ground } = plan;
      for (let row = 0; row < ground.rows; row += 3) {
        for (let column = 0; column < ground.columns; column += 3) {
          const point: Point = [ground.minX + (column + 0.5) * ground.step, ground.minY + (row + 0.5) * ground.step];
          if (!ground.has(point)) continue;
          // Squares are coarse: one may reach a square's width over the line drawn for it.
          if (plan.river) expect(plan.river.gap(point), brief.name).toBeGreaterThan(-ground.step);
          if (plan.coast) expect(plan.coast.gap(point), brief.name).toBeGreaterThan(-ground.step);
          if (plan.river && !plan.farBank && plan.river.gap(point) > ground.step) expect(across(plan, point), brief.name).toBe(false);
        }
      }
    }
  });

  it('draws a town of one road out along it, and a town of several roads round', () => {
    const along = (plan: TownPlan) => {
      const { ground } = plan;
      let most = 0;
      for (let row = 0; row < ground.rows; row++) {
        for (let column = 0; column < ground.columns; column++) {
          const point: Point = [ground.minX + (column + 0.5) * ground.step, ground.minY + (row + 0.5) * ground.step];
          if (ground.has(point)) most = Math.max(most, Math.hypot(...point));
        }
      }
      return most / Math.sqrt(ground.area / Math.PI);
    };
    expect(named('Badanos').plan.ground.weights).toEqual({ highway: settings.ground.single.highway, centre: settings.ground.single.centre });
    expect(named('Cevilefon').plan.ground.weights).toEqual({ highway: settings.ground.several.highway, centre: settings.ground.several.centre });
    expect(along(named('Badanos').plan)).toBeGreaterThan(along(named('Cevilefon').plan));
  });
});

describe('the mesh', () => {
  it('has cells that share their corners, each border between at most two', () => {
    for (const { brief, plan } of everyPlan()) {
      const { mesh } = plan;
      expect(mesh.spacing, brief.name).toBeGreaterThanOrEqual(settings.mesh.min);
      expect(mesh.spacing, brief.name).toBeLessThanOrEqual(settings.mesh.max);
      expect(mesh.cells.length, brief.name).toBe(mesh.seeds.length);
      for (const edge of mesh.edges) expect(edge.cells.length, brief.name).toBeLessThanOrEqual(2);
      const cells = wardCells(mesh, plan.ground, settings);
      expect(cells.length, brief.name).toBeGreaterThan(0);
      for (const cell of cells) expect(cell.corners.length, brief.name).toBeGreaterThanOrEqual(3);
    }
  });

  it('has the castle and the plaza as cells of their own', () => {
    let exact = 0;
    let wards = 0;
    for (const { brief, plan } of everyPlan()) {
      for (const ward of [plan.plaza, plan.castle]) {
        if (!ward) continue;
        wards++;
        const cell = plan.mesh.cells.find((entry) => entry.special === ward.kind);
        expect(cell, brief.name).toBeDefined();
        if (!cell) continue;
        expect(distance(plan.mesh.seeds[cell.seed] as Point, ward.centre), brief.name).toBe(0);
        // The cell is the ward's own shape, but where the castle and the plaza stand close they share a side's cell.
        if (Math.abs(polygonArea(cellPolygon(plan.mesh, cell)) - ward.area) < 1) exact++;
      }
    }
    expect(wards).toBe(128);
    expect(exact / wards).toBeGreaterThan(0.7);
  });
});

describe('main streets', () => {
  it('leave a highway, and never cross water, the wall, a highway, the plaza or the castle', () => {
    let count = 0;
    for (const { brief, plan } of everyPlan()) {
      const roads = [...plan.highways.map((highway) => highway.points), ...plan.mainStreets];
      for (const street of plan.streets.slice(plan.mainStreets.length)) {
        count++;
        expect(street.points.length, brief.name).toBeGreaterThanOrEqual(settings.mainStreets.least);
        expect(Math.min(...roads.map((road) => distanceToPolyline(street.points[0] as Point, road))), brief.name).toBeLessThan(1e-6);
        if (plan.river) expect(crossingsAlong(street.points, plan.river.line).length, brief.name).toBe(0);
        for (const line of wallLines(plan)) expect(crossingsAlong(street.points, line).length, brief.name).toBe(0);
        const length = polylineLength(street.points);
        for (let at = 0; at <= length; at += 5) {
          const point = pointAlongPolyline(street.points, at);
          if (plan.river) expect(plan.river.gap(point), brief.name).toBeGreaterThan(0);
          if (plan.coast) expect(plan.coast.gap(point), brief.name).toBeGreaterThan(0);
          for (const ward of [plan.plaza, plan.castle]) if (ward) expect(pointInPolygon(point, ward.polygon), brief.name).toBe(false);
        }
        // Beyond its first border it keeps clear of the highways.
        for (const point of street.points.slice(2)) expect(plan.ground.toRoad(point), brief.name).toBeGreaterThan(settings.widths.highway);
      }
    }
    expect(count).toBeGreaterThan(2500);
  });

  it('are not laid in a place of fewer buildings than the pack says', () => {
    for (const { brief, plan } of everyPlan()) if (plan.buildings < settings.mainStreets.skipBelow) expect(plan.streets.length, brief.name).toBe(plan.mainStreets.length);
  });
});

describe('wards', () => {
  it('every settlement has wards, with ground enough between them for more houses than it has', () => {
    for (const { brief, plan } of everyPlan()) {
      const wards = ordinary(plan);
      expect(wards.length, brief.name).toBeGreaterThan(0);
      for (const ward of wards) {
        expect(ward.area, brief.name).toBeGreaterThanOrEqual(settings.wards.least);
        expect(polygonArea(ward.polygon), brief.name).toBeCloseTo(ward.area, 6);
        expect(ward.polygon.length, brief.name).toBeGreaterThanOrEqual(3);
      }
      expect(wards.reduce((sum, ward) => sum + ward.area, 0) / (plan.buildings * settings.extent.perBuilding), brief.name).toBeGreaterThan(1.5);
    }
  });

  it('keep a border apart, and clear of highways, main streets, water, the wall, the plaza and the castle', () => {
    // Rounded ends and corners are drawn in short straight pieces, which fall a little inside the true curve.
    const slack = 0.1;
    for (const { brief, plan } of everyPlan()) {
      const wards = ordinary(plan).map((ward) => ({ ward, box: boxOf(ward.polygon, settings.widths.wardBorder) }));
      wards.forEach((one, at) => {
        for (const other of wards.slice(at + 1)) {
          if (one.box.minX > other.box.maxX || other.box.minX > one.box.maxX || one.box.minY > other.box.maxY || other.box.minY > one.box.maxY) continue;
          // Two pieces of one cell, pinched apart where it narrows, have no border between them: they need only be apart.
          const least = one.ward.seed === other.ward.seed ? 0 : settings.widths.wardBorder - slack;
          expect(distanceBetweenPolygons(one.ward.polygon, other.ward.polygon), brief.name).toBeGreaterThan(least);
        }
        const { polygon } = one.ward;
        for (const highway of plan.highways) expect(distancePolygonToPolyline(polygon, highway.points), brief.name).toBeGreaterThan(settings.widths.highway / 2 + settings.wards.highwayVerge + half - slack);
        for (const street of plan.streets) expect(distancePolygonToPolyline(polygon, street.points), brief.name).toBeGreaterThan(settings.widths.mainStreet / 2 + settings.wards.mainStreetVerge - slack);
        if (plan.river) expect(distancePolygonToPolyline(polygon, plan.river.line) - plan.river.width / 2, brief.name).toBeGreaterThan(settings.wards.fromWater + half - slack);
        if (plan.coast) for (const corner of polygon) expect(plan.coast.gap(corner), brief.name).toBeGreaterThan(settings.wards.fromWater + half - slack);
        for (const line of wallLines(plan)) expect(distancePolygonToPolyline(polygon, line), brief.name).toBeGreaterThan(settings.wards.fromWall + half - slack);
        if (plan.plaza) expect(distanceBetweenPolygons(polygon, plan.plaza.polygon), brief.name).toBeGreaterThan(settings.widths.wardBorder + settings.wards.roundPlaza - slack);
        if (plan.castle) expect(distanceBetweenPolygons(polygon, plan.castle.polygon), brief.name).toBeGreaterThan(settings.widths.wardBorder + settings.wards.roundCastle - slack);
        if (plan.river && !plan.farBank) expect(across(plan, polygon[0] as Point), brief.name).toBe(false);
      });
    }
  });

  it('include the plaza and the castle, each exactly the shape it was given, and carry a growth rank', () => {
    for (const { brief, plan } of everyPlan()) {
      expect(plan.wards.filter((ward) => ward.kind === 'plaza').map((ward) => ward.polygon), brief.name).toEqual(plan.plaza ? [plan.plaza.polygon] : []);
      expect(plan.wards.filter((ward) => ward.kind === 'castle').map((ward) => ward.polygon), brief.name).toEqual(plan.castle ? [plan.castle.polygon] : []);
      for (const ward of plan.wards) expect(Number.isFinite(ward.growthRank) && ward.growthRank >= 0, brief.name).toBe(true);
      expect(plan.notes.filter((note) => note.includes('hole')), brief.name).toEqual([]);
    }
  });
});

describe('named towns, determinism and pack edits', () => {
  it('Badanos: wards on both banks, strung out along its one road', () => {
    const { plan } = named('Badanos');
    expect(ordinary(plan).length).toBe(46);
    expect(plan.streets.length).toBe(7);
    expect(ordinary(plan).filter((ward) => across(plan, ward.polygon[0] as Point)).length).toBeGreaterThan(8);
  });

  it('the same brief, pack and seed give the same wards, and another seed different ones', () => {
    const brief = settlement(named('Badanos').brief.id);
    const drawn = (plan: TownPlan) => JSON.stringify([plan.mesh.seeds, plan.streets, plan.wards]);
    expect(drawn(planTown(brief, 1825, pack))).toBe(drawn(planTown(brief, 1825, pack)));
    expect(drawn(planTown(brief, 1825, pack, brief.seed + 1))).not.toBe(drawn(planTown(brief, 1825, pack)));
  });

  it('a finer mesh in a copy of the pack makes more wards, and more ground more still', () => {
    const brief = settlement(named('Badanos').brief.id);
    const raw = rawMedievalPack();
    raw.layout.staged.mesh.spacing = 0.4;
    const finer = planTown(brief, 1825, parsePack(raw));
    expect(ordinary(finer).length).toBeGreaterThan(1.5 * ordinary(named('Badanos').plan).length);
    raw.layout.staged.ground.factor = 4;
    expect(planTown(brief, 1825, parsePack(raw)).ground.area).toBeGreaterThan(1.3 * finer.ground.area);
  });
});
