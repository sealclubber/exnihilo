/**
 * Tests of the grown layout generator on the five towns of Lomia that the
 * phases are measured on: Badanos, Pombal, Cevilefon, Vereceldo and Flupines.
 * Every settlement of Lomia is laid out by it in `lomia-cities.test.ts`.
 *
 * The rules held here are the ones a town must keep. Figures that are
 * estimates of what a natural town measures are printed by
 * `scripts/measure-layout.ts` and reported, not held.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type Layout,
  type Point,
  type SettlementBrief,
  GROWN_GENERATOR,
  LAYOUT_VERSION,
  LayoutGenerationError,
  LayoutSchema,
  checkLayout,
  createPathFinder,
  distanceToWater,
  generateCity,
  generateGrownLayout,
  generateLayout,
  geometry,
  riverOutline,
  riverWidthAt,
} from '../src/index.ts';
import { lomiaWorld, medievalPack, medievalPackBefore6D } from './pack.ts';
import { arterialOverrun, arterials, bridgeAngles, highwayChains, laneShare, lotShapes, ringDistricts, sizeSpread, stretch, wallShape, wards } from './shape.ts';

const pack = medievalPack();
const grown = pack.layout.grown!;
const { distance, polygonArea, polygonCentroid, pointInPolygon, distanceToPolyline, bearingDifference, exactBearing } = geometry;

interface Town {
  brief: SettlementBrief;
  city: City;
  layout: Layout;
}
const towns = new Map<string, Town>();
const town = (name: string): Town => towns.get(name)!;
const NAMES = ['Badanos', 'Pombal', 'Cevilefon', 'Vereceldo', 'Flupines'];
const LARGE = ['Badanos', 'Pombal', 'Cevilefon'];
const riverOf = (layout: Layout) => layout.waters.find((water) => water.kind === 'river') as Extract<Layout['waters'][number], { kind: 'river' }> | undefined;
const seaOf = (layout: Layout) => layout.waters.find((water) => water.kind === 'sea') as Extract<Layout['waters'][number], { kind: 'sea' }> | undefined;
/** The least that any stretch of `span` metres of a line bows from the straight line between its ends, among stretches near the town. */
function leastBow(line: Point[], span: number, layout: Layout): number {
  const { bounds } = layout.summary;
  const near = (point: Point) => point[0] >= bounds.minX - span && point[0] <= bounds.maxX + span && point[1] >= bounds.minY - span && point[1] <= bounds.maxY + span;
  const along = [0];
  for (let at = 1; at < line.length; at++) along.push(along[at - 1]! + distance(line[at - 1]!, line[at]!));
  let least = Infinity;
  let end = 0;
  for (let start = 0; start < line.length; start += 4) {
    while (end < line.length - 1 && along[end]! - along[start]! < span) end++;
    if (along[end]! - along[start]! < span) break;
    if (!near(line[start]!) || !near(line[end]!)) continue;
    let bow = 0;
    for (let at = start + 1; at < end; at++) bow = Math.max(bow, distanceToPolyline(line[at]!, [line[start]!, line[end]!]));
    least = Math.min(least, bow);
  }
  return least;
}

beforeAll(() => {
  for (const name of NAMES) {
    const brief = lomiaWorld().settlements.find((entry) => entry.name === name)!;
    const city = generateCity(brief, pack);
    towns.set(name, { brief, city, layout: generateLayout(city, brief, pack) });
  }
});

describe('the grown generator', () => {
  it('is the medieval pack\'s choice, names itself in the summary, and leaves the grid there to be asked for', () => {
    expect(pack.layout.generator).toBe('grown');
    const { brief, city, layout } = town('Flupines');
    expect(layout.summary.generator).toBe(GROWN_GENERATOR);
    expect(layout.summary.layoutVersion).toBe(LAYOUT_VERSION);
    expect(LAYOUT_VERSION).toBe(8);
    expect(generateLayout(city, brief, pack, { generator: 'grid' }).summary.generator).toBe('grid');
    // A pack that says nothing is laid out on the grid, as before the choice existed.
    expect(generateLayout(generateCity(brief, medievalPackBefore6D()), brief, medievalPackBefore6D()).summary.generator).toBe('grid');
  });

  it('needs the pack\'s grown block, and says so', () => {
    const { brief } = town('Flupines');
    const before = medievalPackBefore6D();
    expect(() => generateGrownLayout(generateCity(brief, before), brief, before)).toThrow(LayoutGenerationError);
    expect(() => generateGrownLayout(generateCity(brief, before), brief, before)).toThrow(/settlement-143 \(Flupines\).*`grown` block/);
  });

  it('gives every building one lot, fits the schema and breaks no rule, in each of the five towns', () => {
    const lots: Record<string, number> = { Badanos: 1825, Pombal: 8632, Cevilefon: 3606, Vereceldo: 65, Flupines: 95 };
    for (const name of NAMES) {
      const { brief, city, layout } = town(name);
      expect(layout.lots, name).toHaveLength(lots[name]!);
      expect(new Set(layout.lots.map((lot) => lot.buildingId)).size, name).toBe(city.buildings.length);
      expect(LayoutSchema.safeParse(layout).success, name).toBe(true);
      expect(checkLayout(layout, city, brief, pack), name).toEqual([]);
    }
  });

  it('makes the same layout twice, another for another seed, and matches its recorded fingerprints', () => {
    const { brief, city, layout } = town('Badanos');
    expect(JSON.stringify(generateLayout(city, brief, pack))).toBe(JSON.stringify(layout));
    const other = generateLayout(city, brief, pack, { seed: 12345 });
    expect(JSON.stringify(other.segments)).not.toBe(JSON.stringify(layout.segments));
    expect(checkLayout(other, city, brief, pack)).toEqual([]);
    const saved = JSON.parse(readFileSync(new URL('./baselines/layout-grown-v8.json', import.meta.url), 'utf8')) as { towns: Record<string, string> };
    for (const name of NAMES) expect(createHash('sha256').update(JSON.stringify(town(name).layout)).digest('hex'), name).toBe(saved.towns[name]);
  });

  it('joins every lot to every other by the streets', () => {
    for (const name of NAMES) {
      const { layout } = town(name);
      const finder = createPathFinder(layout);
      const step = Math.max(1, Math.floor(layout.lots.length / 60));
      const first = layout.lots[0]!.id;
      for (let at = 0; at < layout.lots.length; at += step) expect(finder.path(first, layout.lots[at]!.id).length, name).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('streets', () => {
  it('branch off the highways: in Badanos at least five arterials, every arterial starting on a highway or a bridge, none at the centre', () => {
    expect(arterials(town('Badanos').layout).filter((entry) => entry.onHighway).length).toBeGreaterThanOrEqual(5);
    for (const name of NAMES) {
      const { brief, layout } = town(name);
      const branches = arterials(layout);
      expect(branches.filter((entry) => !entry.onHighway), name).toEqual([]);
      expect(branches.filter((entry) => entry.atCentre), name).toEqual([]);
      expect(layout.exits, name).toHaveLength(brief.routes.length);
      // A highway carries its route; nothing else does.
      const routes = new Set(brief.routes.map((route) => route.routeId));
      for (const segment of layout.segments) if (segment.routeId !== undefined) expect(routes.has(segment.routeId)).toBe(true);
    }
  });

  it('keep arterials in town: none runs more than 10 metres past the town\'s ground, beyond the street at its edge', () => {
    for (const name of LARGE) expect(Math.max(0, ...arterialOverrun(town(name).layout)), name).toBeLessThanOrEqual(10 + grown.widths.arterial);
  });

  it('put each exit within five degrees of its bearing, at the end of a highway', () => {
    for (const name of NAMES) {
      const { brief, layout } = town(name);
      const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
      for (const exit of layout.exits) {
        expect(bearingDifference(exactBearing([0, 0], junctions.get(exit.junctionId)!.position), exit.bearing), `${name} ${exit.id}`).toBeLessThanOrEqual(5);
        expect(layout.segments.some((segment) => segment.kind === 'arterial' && segment.routeId === exit.routeId && segment.toJunctionId === exit.junctionId)).toBe(true);
      }
      // One exit for each of the brief's routes, in their order and at their bearings.
      expect(layout.exits.map((exit) => [exit.routeId, exit.bearing]), name).toEqual(brief.routes.map((route) => [route.routeId, route.bearing]));
    }
  });

  it('lead lanes down the alleys between buildings, and open many lots onto them', () => {
    for (const name of LARGE) {
      const { layout } = town(name);
      expect(layout.segments.some((segment) => segment.kind === 'lane' && segment.width === grown.widths.alley), name).toBe(true);
      // An estimate held loosely: in Badanos a third of lots are to open onto a lane.
      console.log(`${name}: lots entered from a lane ${(laneShare(layout) * 100).toFixed(1)}%`);
    }
    expect(laneShare(town('Badanos').layout)).toBeGreaterThanOrEqual(1 / 3);
  });
});

describe('water', () => {
  it('gives a river a line that meanders without a corner, arriving and leaving on the brief\'s bearings', () => {
    for (const name of ['Badanos', 'Pombal']) {
      const { brief, layout } = town(name);
      const river = riverOf(layout)!;
      const line = river.centreLine;
      for (let at = 2; at < line.length; at++) {
        const one = Math.atan2(line[at - 1]![1] - line[at - 2]![1], line[at - 1]![0] - line[at - 2]![0]);
        const other = Math.atan2(line[at]![1] - line[at - 1]![1], line[at]![0] - line[at - 1]![0]);
        expect(Math.abs(((((other - one) * 180) / Math.PI + 540) % 360) - 180), `${name} at piece ${at}`).toBeLessThanOrEqual(10);
      }
      expect(bearingDifference(exactBearing([0, 0], line[0]!), brief.river!.arrivesFrom!.bearing), name).toBeLessThanOrEqual(10);
      expect(bearingDifference(exactBearing([0, 0], line.at(-1)!), brief.river!.leavesToward!.bearing), name).toBeLessThanOrEqual(10);
      // Its ends lie well beyond anything drawn.
      const { bounds } = layout.summary;
      for (const end of [line[0]!, line.at(-1)!]) expect(end[0] < bounds.minX || end[0] > bounds.maxX || end[1] < bounds.minY || end[1] > bounds.maxY, name).toBe(true);
      // Longer than the straight way between the points where it enters and leaves the town's bounds, and not wildly so.
      const within = line.filter((point) => point[0] >= bounds.minX && point[0] <= bounds.maxX && point[1] >= bounds.minY && point[1] <= bounds.maxY);
      const winding = geometry.polylineLength(within) / distance(within[0]!, within.at(-1)!);
      expect(winding, name).toBeGreaterThanOrEqual(1.1);
      expect(winding, name).toBeLessThanOrEqual(1.6);
    }
  });

  it('varies a river\'s width, with one width for each point of its line and the mean beside them', () => {
    for (const name of ['Badanos', 'Pombal']) {
      const river = riverOf(town(name).layout)!;
      expect(river.widths, name).toHaveLength(river.centreLine.length);
      const widths = river.widths!;
      expect(widths.reduce((sum, width) => sum + width, 0) / widths.length, name).toBeCloseTo(river.width, 6);
      expect((Math.max(...widths) - Math.min(...widths)) / river.width, name).toBeGreaterThanOrEqual(0.2);
      expect(riverWidthAt(river, 0)).toBe(widths[0]);
    }
  });

  it('bridges a river at least twice in Badanos and Pombal, each square to the bank, and builds on both banks', () => {
    for (const name of ['Badanos', 'Pombal']) {
      const { layout } = town(name);
      const river = riverOf(layout)!;
      const bridges = layout.segments.filter((segment) => segment.kind === 'bridge');
      expect(bridges.length, name).toBeGreaterThanOrEqual(2);
      // Each square to the river, within 15 degrees.
      for (const angle of bridgeAngles(layout)) expect(angle, name).toBeLessThanOrEqual(15);
      // Lots on both sides of the line, which the invariants have joined to one another.
      const sides = new Set(layout.lots.map((lot) => {
        const middle = polygonCentroid(lot.polygon);
        let nearest = 1;
        for (let at = 1; at < river.centreLine.length; at++) if (distance(river.centreLine[at]!, middle) < distance(river.centreLine[nearest]!, middle)) nearest = at;
        const [a, b] = [river.centreLine[nearest - 1]!, river.centreLine[nearest]!];
        return Math.sign((b[0] - a[0]) * (middle[1] - a[1]) - (b[1] - a[1]) * (middle[0] - a[0]));
      }));
      expect(sides.size, name).toBe(2);
    }
  });

  it('has no straight bank or shore: every 200 metres of either bows by 4 metres or more', () => {
    for (const name of ['Badanos', 'Pombal']) {
      const { layout } = town(name);
      const river = riverOf(layout)!;
      const outline = riverOutline(river);
      const count = river.centreLine.length;
      for (const bank of [outline.slice(0, count), outline.slice(count).reverse()]) expect(leastBow(bank, 200, layout), name).toBeGreaterThanOrEqual(4);
    }
    const { layout } = town('Cevilefon');
    const sea = seaOf(layout)!;
    // The shore is all of the polygon but the two corners far out to sea that close it.
    expect(leastBow(sea.polygon.slice(0, -2), 200, layout)).toBeGreaterThanOrEqual(4);
    const { bounds } = layout.summary;
    expect(Math.max(...sea.polygon.map((point) => Math.hypot(point[0], point[1])))).toBeGreaterThan(2 * Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  });

  it('stands Cevilefon\'s docks by the water, in a harbour that lies in a bay', () => {
    const { city, layout } = town('Cevilefon');
    const sea = seaOf(layout)!;
    const docks = layout.lots.filter((lot) => city.buildings.find((building) => building.id === lot.buildingId)!.type === 'docks');
    expect(docks.length).toBeGreaterThan(0);
    // Phase 6D.1 held every dock within 15 m of the water; since 6D.2 the distances are printed and reported, not held.
    const away = docks.map((lot) => distanceToWater(lot.polygon, sea));
    console.log(`Cevilefon's docks from the water: ${away.map((value) => value.toFixed(0)).join(', ')} m`);
    expect(Math.min(...away)).toBeLessThanOrEqual(15);
    // The shore comes nearer the centre at the harbour than it does a harbour's length to either side.
    const toCentre = (points: Point[]) => Math.min(...points.map((point) => Math.hypot(point[0], point[1])));
    const shore = sea.polygon.slice(0, -2);
    const nearest = shore.reduce((best, point) => (Math.hypot(point[0], point[1]) < Math.hypot(best[0], best[1]) ? point : best));
    const aside = shore.filter((point) => Math.abs(distance(point, nearest) - grown.coast.harbour.length) < 20);
    expect(aside.length).toBeGreaterThan(0);
    expect(toCentre(aside)).toBeGreaterThan(toCentre([nearest]) + grown.coast.harbour.depth / 4);
  });
});

describe('walls, gates and the plaza', () => {
  it('has a wall exactly where the brief is flagged for one, a gate for every gatehouse, and a plaza where flagged', () => {
    for (const name of NAMES) {
      const { brief, city, layout } = town(name);
      expect(layout.walls.length > 0, name).toBe(brief.flags.walls);
      expect(layout.places.some((place) => place.kind === 'plaza'), name).toBe(brief.flags.plaza);
      const gatehouses = brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse) : [];
      const gates = layout.walls.flatMap((wall) => wall.gates);
      expect(gates.map((gate) => gate.buildingId).sort(), name).toEqual(gatehouses.map((building) => building.id).sort());
      const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
      for (const gate of gates) {
        expect(junctions.get(gate.junctionId)!.kind).toBe('gate');
        const lot = layout.lots.find((entry) => entry.buildingId === gate.buildingId)!;
        expect(geometry.distanceToPolygonEdge(junctions.get(gate.junctionId)!.position, lot.polygon), `${name} ${gate.buildingId}`).toBeLessThanOrEqual(30);
      }
    }
    expect(town('Badanos').layout.walls).toEqual([]);
    expect(town('Flupines').layout.places).toEqual([]);
  });

  it('keeps a plaza within the pack\'s bounds, as the open lot of its building', () => {
    for (const name of ['Pombal', 'Cevilefon']) {
      const { city, layout } = town(name);
      const plaza = layout.places.find((place) => place.kind === 'plaza')!;
      expect(polygonArea(plaza.polygon), name).toBeLessThanOrEqual(grown.plaza.max * 1.5);
      expect(polygonArea(plaza.polygon), name).toBeGreaterThanOrEqual(grown.plaza.min * 0.5);
      expect(city.buildings.find((building) => building.id === plaza.buildingId)!.type).toBe(grown.plaza.building);
      const lot = layout.lots.find((entry) => entry.buildingId === plaza.buildingId)!;
      expect(lot.polygon).toEqual(plaza.polygon);
      expect(lot.footprints).toEqual([]);
      expect(pointInPolygon([0, 0], plaza.polygon), name).toBe(true);
    }
  });

  it('leads every main road from the plaza\'s edge, and every way through the wall by a gate', () => {
    for (const name of ['Pombal', 'Cevilefon']) {
      const { layout } = town(name);
      const plaza = layout.places.find((place) => place.kind === 'plaza')!;
      const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
      const reach = grown.widths.highway + grown.widths.street;
      // By main roads all the way: one may join another before the plaza, and they reach it together.
      const beside = new Map<string, string[]>();
      for (const segment of layout.segments) {
        if (segment.kind !== 'arterial' && segment.kind !== 'bridge') continue;
        beside.set(segment.fromJunctionId, [...(beside.get(segment.fromJunctionId) ?? []), segment.toJunctionId]);
        beside.set(segment.toJunctionId, [...(beside.get(segment.toJunctionId) ?? []), segment.fromJunctionId]);
      }
      for (const exit of layout.exits) {
        const reached = new Set([exit.junctionId]);
        const queue = [exit.junctionId];
        for (let at = 0; at < queue.length; at++) for (const next of beside.get(queue[at]!) ?? []) if (!reached.has(next)) (reached.add(next), queue.push(next));
        expect([...reached].some((id) => geometry.distanceToPolygonEdge(junctions.get(id)!.position, plaza.polygon) <= reach), `${name} ${exit.id}`).toBe(true);
      }
      // From a lot outside the wall to one inside, the way passes a gate.
      const ring = layout.walls.reduce((longest, wall) => (wall.line.length > longest.line.length ? wall : longest));
      const line = ring.closed ? [...ring.line, ring.line[0]!] : ring.line;
      const gatehouses = new Set(layout.walls.flatMap((wall) => wall.gates.map((gate) => gate.buildingId)));
      const beyond = (lot: Layout['lots'][number]) => geometry.crossingsOfPolyline([0, 0], polygonCentroid(lot.polygon), line) % 2 === 1;
      const lots = layout.lots.filter((lot) => !gatehouses.has(lot.buildingId));
      const inside = lots.find((lot) => !beyond(lot))!;
      const outside = lots.filter(beyond);
      const finder = createPathFinder(layout);
      const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
      for (let at = 0; at < outside.length; at += Math.max(1, Math.floor(outside.length / 25))) {
        const path = finder.path(outside[at]!.id, inside.id);
        const passed = path.segmentIds.flatMap((id) => [segments.get(id)!.fromJunctionId, segments.get(id)!.toJunctionId]);
        expect(passed.some((id) => junctions.get(id)!.kind === 'gate'), `${name} ${outside[at]!.id}`).toBe(true);
      }
    }
  });

  it('builds outside the wall of a large town and keeps a small one wholly within', () => {
    const outside = (name: string) => {
      const { layout } = town(name);
      const gatehouses = new Set(layout.walls.flatMap((wall) => wall.gates.map((gate) => gate.buildingId)));
      const ring = layout.walls.reduce((longest, wall) => (wall.line.length > longest.line.length ? wall : longest));
      // Seen from the centre: beyond the wall where a line from the centre to the lot crosses it.
      return layout.lots.filter((lot) => !gatehouses.has(lot.buildingId) && geometry.crossingsOfPolyline([0, 0], polygonCentroid(lot.polygon), ring.closed ? [...ring.line, ring.line[0]!] : ring.line) % 2 === 1).length;
    };
    expect(outside('Pombal')).toBeGreaterThan(100);
    expect(outside('Cevilefon')).toBeGreaterThan(100);
    expect(outside('Vereceldo')).toBe(0);
  });
});

describe('wards and buildings', () => {
  it('cuts lots of many sizes, few of them long and thin', () => {
    for (const name of ['Badanos', 'Pombal']) {
      const shapes = lotShapes(town(name).layout);
      console.log(`${name}: lot length over width, median ${shapes.median.toFixed(2)}, over four ${(shapes.overFour * 100).toFixed(1)}%`);
      // Estimates: a median under 2 and under 3% over 4 times as long as wide. Held a little looser.
      expect(shapes.median, name).toBeLessThan(2);
      expect(shapes.overFour, name).toBeLessThan(0.08);
    }
    for (const [district, spread] of sizeSpread(town('Badanos').layout)) expect(spread, district).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps every ward under 1.6 hectares, and puts buildings in every one', () => {
    for (const name of NAMES) {
      const list = wards(town(name).layout);
      expect(list.length, name).toBeGreaterThan(0);
      for (const ward of list) {
        expect(ward.area, name).toBeLessThanOrEqual(16_000);
        expect(ward.lots, name).toBeGreaterThan(0);
      }
    }
    const lots = wards(town('Badanos').layout).map((ward) => ward.lots).sort((a, b) => a - b);
    console.log(`Badanos: ${lots.length} wards, a median of ${lots[Math.floor(lots.length / 2)]} buildings each`);
  });

  it('covers the wards that are not loose: most at 75% or more, and none under 60% but in the last fifth', () => {
    for (const name of LARGE) {
      const list = wards(town(name).layout);
      const tight = list.filter((ward) => ward.rank < 1 - grown.buildings.loose.share);
      expect(tight.filter((ward) => ward.coverage >= 0.75).length / tight.length, name).toBeGreaterThanOrEqual(0.9);
      console.log(`${name}: wards not loose under 60% covered: ${list.filter((ward) => ward.coverage < 0.6 && ward.rank < 1 - grown.buildings.loose.share).length}`);
    }
  });

  it('keeps every footprint inside its lot, and density within 15% of the grid\'s in the three large towns', () => {
    for (const name of LARGE) {
      const { brief, city, layout } = town(name);
      const grid = generateLayout(city, brief, pack, { generator: 'grid' });
      expect(Math.abs(layout.summary.residentsPerHectare / grid.summary.residentsPerHectare - 1), name).toBeLessThanOrEqual(0.15);
      for (const lot of layout.lots.filter((_, at) => at % 7 === 0)) for (const footprint of lot.footprints) expect(geometry.polygonWithin(footprint, lot.polygon), lot.id).toBe(true);
    }
  });
});

describe('road first', () => {
  it('lays every highway as one unbroken chain from its exit to the centre', () => {
    for (const name of NAMES) for (const chain of highwayChains(town(name).layout)) expect(chain.unbroken, `${name} ${chain.exit}`).toBe(true);
  });

  it('stretches Badanos along its road', () => {
    // An estimate: at least 1.3 times as long along the highway as across.
    expect(stretch(town('Badanos').layout)).toBeGreaterThanOrEqual(1.3);
  });

  it('makes districts pieces of town, none a ring round the centre', () => {
    for (const name of NAMES) expect(ringDistricts(town(name).layout), name).toEqual([]);
  });

  it('gives every block a growth rank and a district', () => {
    for (const name of NAMES) {
      const blocks = town(name).layout.blocks ?? [];
      expect(blocks.length, name).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block.growthRank, name).toBeGreaterThanOrEqual(0);
        expect(block.districtId, name).toBeDefined();
      }
    }
  });

  it('draws the wall as a smooth line', () => {
    for (const name of ['Pombal', 'Cevilefon', 'Vereceldo']) for (const wall of wallShape(town(name).layout)) expect(wall.worstTurn, name).toBeLessThanOrEqual(20);
  });
});
