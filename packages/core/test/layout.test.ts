/**
 * Tests of the grid layout generator and the path function on single
 * settlements of Lomia.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type City,
  type Layout,
  type Point,
  type SettingPack,
  type SettlementBrief,
  BEARING_TOLERANCE,
  GENERATOR_VERSION,
  GRID_GENERATOR,
  LAYOUT_VERSION,
  LayoutPathError,
  LayoutPathSchema,
  LayoutSchema,
  checkLayout,
  createPathFinder,
  distanceToWater,
  footprintCoverageOf,
  placeFlagsOf,
  generateCity,
  generateLayout,
  geometry,
  lotSizeOf,
  parsePack,
  shortestPath,
} from '../src/index.ts';
import { BEFORE_6B5, lomiaWorld, medievalPack, medievalPackBefore6B, rawMedievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const { bearingDifference, exactBearing, distanceBetweenPolylines, crossingsOfPolyline, polylineLength, projectOnPolyline, distance } = geometry;

interface Town {
  brief: SettlementBrief;
  city: City;
  layout: Layout;
}
const town = (id: string, packUsed: SettingPack = pack, seed?: number): Town => {
  const brief = settlement(id);
  const city = generateCity(brief, packUsed);
  return { brief, city, layout: generateLayout(city, brief, packUsed, seed === undefined ? {} : { seed }) };
};
const junctionOf = (layout: Layout, id: string) => layout.junctions.find((junction) => junction.id === id)!;
const riverOf = (layout: Layout) => layout.waters.find((water) => water.kind === 'river') as Extract<Layout['waters'][number], { kind: 'river' }>;
const seaOf = (layout: Layout) => layout.waters.find((water) => water.kind === 'sea') as Extract<Layout['waters'][number], { kind: 'sea' }>;
const edited = (edit: (raw: any) => void): SettingPack => {
  const raw = rawMedievalPack();
  edit(raw);
  return parsePack(raw);
};

let badanos: Town;
beforeAll(() => {
  badanos = town('settlement-641');
});

describe('Badanos', () => {
  it('has 1,825 lots, one for each building', () => {
    expect(badanos.city.buildings).toHaveLength(1825);
    expect(badanos.layout.lots).toHaveLength(1825);
    expect(badanos.layout.lots.map((lot) => lot.buildingId)).toEqual(badanos.city.buildings.map((building) => building.id));
    expect(badanos.layout.lots[122]!.id).toBe('lot-641-000123');
  });

  it('has two exits on the Pusztaszian trail, near bearings 61 and 227', () => {
    const { exits } = badanos.layout;
    expect(exits.map((exit) => [exit.routeId, exit.name, exit.kind, exit.bearing])).toEqual([
      ['route-34', 'Pusztaszian trail', 'trail', 61],
      ['route-34', 'Pusztaszian trail', 'trail', 227],
    ]);
    for (const exit of exits) {
      const junction = junctionOf(badanos.layout, exit.junctionId);
      expect(junction.kind).toBe('exit');
      expect(bearingDifference(exactBearing([0, 0], junction.position), exit.bearing)).toBeLessThanOrEqual(BEARING_TOLERANCE);
    }
  });

  it('has the river arrive near bearing 152 and leave near 61, passing beside the centre', () => {
    const river = riverOf(badanos.layout);
    expect(river.width).toBe(pack.layout.riverWidth);
    expect(bearingDifference(exactBearing([0, 0], river.centreLine[0]!), 152)).toBeLessThan(1);
    expect(bearingDifference(exactBearing([0, 0], river.centreLine.at(-1)!), 61)).toBeLessThan(1);
    const fromCentre = geometry.distanceToPolyline([0, 0], river.centreLine);
    expect(fromCentre).toBeGreaterThan(river.width / 2);
    expect(fromCentre).toBeLessThan(200);
  });

  it('keeps the arterial toward 61 out of the water, though the river leaves the same way', () => {
    const river = riverOf(badanos.layout);
    const arterials = badanos.layout.segments.filter((segment) => segment.kind === 'arterial');
    expect(arterials.length).toBeGreaterThan(10);
    for (const segment of arterials) {
      expect(segment.routeId).toBe('route-34');
      expect(segment.name).toBe('Pusztaszian trail');
      expect(distanceBetweenPolylines(segment.points, river.centreLine), segment.id).toBeGreaterThanOrEqual(river.width / 2 + segment.width / 2);
    }
    // The last stretch to the exit at 61 is an arterial, and it is dry.
    const exit = junctionOf(badanos.layout, badanos.layout.exits[0]!.junctionId);
    const last = badanos.layout.segments.find((segment) => segment.toJunctionId === exit.id)!;
    expect(last.kind).toBe('arterial');
    expect(geometry.distanceToPolyline(exit.position, river.centreLine)).toBeGreaterThan(river.width / 2 + last.width / 2);
  });

  it('is connected across the river, by bridge', () => {
    const river = riverOf(badanos.layout);
    const bridges = badanos.layout.segments.filter((segment) => segment.kind === 'bridge');
    expect(bridges.length).toBeGreaterThanOrEqual(1);
    for (const bridge of bridges) {
      expect(crossingsOfPolyline(bridge.points[0]!, bridge.points.at(-1)!, river.centreLine)).toBeGreaterThan(0);
      expect(junctionOf(badanos.layout, bridge.fromJunctionId).kind).toBe('bridge-end');
      expect(junctionOf(badanos.layout, bridge.toJunctionId).kind).toBe('bridge-end');
    }
    // Lots stand on both banks.
    const first = badanos.layout.lots[0]!;
    const across = badanos.layout.lots.filter((lot) => crossingsOfPolyline(first.entrance.point, lot.entrance.point, river.centreLine) % 2 === 1);
    expect(across.length).toBeGreaterThan(50);
    expect(badanos.layout.lots.length - across.length).toBeGreaterThan(50);
    expect(checkLayout(badanos.layout, badanos.city, badanos.brief, pack)).toEqual([]);
  });

  it('fits the format', () => {
    expect(LayoutSchema.safeParse(badanos.layout).success).toBe(true);
    expect(badanos.layout.junctions[11]!.id).toBe('junction-641-000012');
    expect(badanos.layout.segments[33]!.id).toBe('segment-641-000034');
  });

  it('summarises itself and names what made it', () => {
    const { summary, lots, segments, junctions } = badanos.layout;
    expect(summary).toMatchObject({
      settlementId: 'settlement-641',
      counts: { lots: 1825, exits: 2, waters: 1, segments: segments.length, junctions: junctions.length, districtAreas: 6 },
      layoutVersion: LAYOUT_VERSION,
      generator: GRID_GENERATOR,
      pack: { name: 'medieval', version: pack.pack.version },
      seed: badanos.brief.seed,
    });
    expect(summary.builtArea).toBeCloseTo(lots.reduce((sum, lot) => sum + geometry.polygonArea(lot.polygon), 0), 6);
    expect(summary.residentsPerHectare).toBeCloseTo(9607 / (summary.builtArea / 10_000), 9);
    expect(summary.residentsPerHectare).toBeGreaterThan(pack.layout.density.min);
    expect(summary.residentsPerHectare).toBeLessThan(pack.layout.density.max);
    expect(summary.bounds.minX).toBeLessThan(0);
    expect(summary.bounds.maxY).toBeGreaterThan(0);
  });
});

describe('the lots', () => {
  it('have the size the pack gives their building type', () => {
    const types = new Map(badanos.city.buildings.map((building) => [building.id, building.type]));
    for (const lot of badanos.layout.lots) {
      const size = lotSizeOf(types.get(lot.buildingId)!, pack);
      expect(geometry.polygonArea(lot.polygon)).toBeCloseTo(size.frontage * size.depth, 6);
    }
    // A dwelling for several households has a larger lot than one for a single household.
    expect(pack.layout.lots.tenement!.frontage * pack.layout.lots.tenement!.depth).toBeGreaterThan(pack.layout.lots.cottage!.frontage * pack.layout.lots.cottage!.depth);
  });

  it('are entered from a point on a street that is not a bridge', () => {
    const segments = new Map(badanos.layout.segments.map((segment) => [segment.id, segment]));
    for (const lot of badanos.layout.lots) {
      const segment = segments.get(lot.entrance.segmentId)!;
      expect(segment.kind).not.toBe('bridge');
      expect(geometry.distanceToPolyline(lot.entrance.point, segment.points)).toBeLessThan(1e-9);
    }
  });

  it('lie within their district\'s area, and districts sit where the pack places them', () => {
    const { layout, city } = badanos;
    expect(layout.districtAreas.map((area) => area.districtId)).toEqual(city.districts.map((district) => district.id));
    const reach = (districtId: string) => {
      const mine = layout.lots.filter((lot) => lot.districtId === districtId);
      return mine.reduce((sum, lot) => sum + distance([0, 0], lot.entrance.point), 0) / mine.length;
    };
    const placement = (kind: string) => pack.districts.kinds.find((entry) => entry.id === kind)!.placement;
    const mean = (wanted: string) => {
      const chosen = city.districts.filter((district) => placement(district.kind) === wanted);
      return chosen.reduce((sum, district) => sum + reach(district.id), 0) / chosen.length;
    };
    expect(mean('centre')).toBeLessThan(mean('middle'));
    expect(mean('centre')).toBeLessThan(mean('edge'));
  });

  it('put landmarks first and gatehouses on the side of their district toward an exit', () => {
    const { brief, city, layout } = town('settlement-2');
    expect(brief.flags.walls).toBe(true);
    const gatehouses = city.buildings.filter((building) => building.type === 'gatehouse');
    expect(gatehouses.length).toBeGreaterThanOrEqual(2);
    const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    gatehouses.forEach((gatehouse, turn) => {
      const exit = brief.routes[turn % brief.routes.length]!;
      const toward = geometry.bearingVector(exit.bearing);
      const along = (point: Point) => point[0] * toward[0] + point[1] * toward[1];
      const district = layout.lots.filter((lot) => lot.districtId === gatehouse.districtId);
      const average = district.reduce((sum, lot) => sum + along(lot.entrance.point), 0) / district.length;
      expect(along(lotOf.get(gatehouse.id)!.entrance.point), gatehouse.id).toBeGreaterThan(average);
    });
  });
});

describe('named settlements', () => {
  it('Pombal lays out in under 5 seconds, with its docks in a harbour district that touches the water', () => {
    const brief = settlement('settlement-5');
    const city = generateCity(brief, pack);
    const started = performance.now();
    const layout = generateLayout(city, brief, pack);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(city.people).toHaveLength(47603);
    expect(layout.lots).toHaveLength(city.buildings.length);

    // The gameplan calls Pombal a coastal port. In the Lomia export it is a river port: its
    // cell is not coastal, and its sea routes follow the river. So its harbour touches the river.
    expect(brief.flags.port).toBe(true);
    expect(brief.coast.isCoastal).toBe(false);
    expect(layout.waters.map((water) => water.kind)).toEqual(['river']);
    const harbour = city.districts.find((district) => district.kind === 'harbour')!;
    const docks = city.buildings.filter((building) => building.type === 'docks');
    expect(docks.length).toBeGreaterThan(0);
    const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    for (const dock of docks) expect(lotOf.get(dock.id)!.districtId).toBe(harbour.id);
    const area = layout.districtAreas.find((entry) => entry.districtId === harbour.id)!;
    const gap = Math.min(...area.polygons.map((polygon) => distanceToWater(polygon, layout.waters[0]!)));
    expect(gap).toBeLessThanOrEqual(pack.layout.watersideReach);
  });

  it('a coastal port has its docks in a harbour district that touches the sea', () => {
    const { brief, city, layout } = town('settlement-3');
    expect(brief).toMatchObject({ name: 'Cevilefon', flags: { port: true }, coast: { isCoastal: true, waterBearing: 159 } });
    const sea = seaOf(layout);
    const harbour = city.districts.find((district) => district.kind === 'harbour')!;
    const area = layout.districtAreas.find((entry) => entry.districtId === harbour.id)!;
    const gap = Math.min(...area.polygons.map((polygon) => distanceToWater(polygon, sea)));
    // Only a street lies between the harbour and the shore.
    expect(gap).toBeLessThanOrEqual(Math.max(...layout.segments.map((segment) => segment.width)));
    const lotOf = new Map(layout.lots.map((lot) => [lot.buildingId, lot]));
    for (const dock of city.buildings.filter((building) => building.type === 'docks')) expect(lotOf.get(dock.id)!.districtId).toBe(harbour.id);
    // The sea-route exit is on the shore, at its bearing.
    const exit = layout.exits.find((entry) => entry.kind === 'sea-route')!;
    const junction = junctionOf(layout, exit.junctionId);
    expect(bearingDifference(exactBearing([0, 0], junction.position), exit.bearing)).toBeLessThan(1);
    expect(distanceToWater([junction.position, junction.position, junction.position], sea)).toBeLessThan(10);
    // No lot or street is in the sea, and none of the town lies beyond it.
    const toward = geometry.bearingVector(159);
    const shore = Math.min(...sea.polygon.map((point) => point[0] * toward[0] + point[1] * toward[1]));
    for (const lot of layout.lots) for (const point of lot.polygon) expect(point[0] * toward[0] + point[1] * toward[1]).toBeLessThan(shore);
  });

  it('Vereceldo lays out with a single district and passes every invariant', () => {
    const { brief, city, layout } = town('settlement-455');
    expect(city.people).toHaveLength(253);
    expect(layout.districtAreas).toHaveLength(1);
    expect(layout.waters).toEqual([]);
    expect(layout.lots).toHaveLength(city.buildings.length);
    expect(layout.exits).toHaveLength(brief.routes.length);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    // A handful of blocks is a valid town.
    expect(layout.summary.bounds.maxX - layout.summary.bounds.minX).toBeLessThan(1500);
  });

  it('Karlen, where a river ends, lays out and passes every invariant', () => {
    const { brief, city, layout } = town('settlement-8');
    expect(brief.river!.arrivesFrom).toBeDefined();
    expect(brief.river!.leavesToward).toBeUndefined();
    expect(brief.coast.isCoastal).toBe(false);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
    // Not coastal, so the river runs on to the town's edge opposite its arrival.
    const river = riverOf(layout);
    const arrival = brief.river!.arrivesFrom!.bearing;
    expect(bearingDifference(exactBearing([0, 0], river.centreLine[0]!), arrival)).toBeLessThan(1);
    expect(bearingDifference(exactBearing([0, 0], river.centreLine.at(-1)!), arrival + 180)).toBeLessThan(1);
  });
});

describe('the cases Lomia contains', () => {
  const find = (wanted: (brief: SettlementBrief) => boolean) => lomiaWorld().settlements.find(wanted)!;

  it('skips the water for a town with no river and no coast', () => {
    const brief = find((entry) => !entry.river && !entry.coast.isCoastal && entry.sizeGroup === 'town');
    const { layout, city } = town(brief.id);
    expect(layout.waters).toEqual([]);
    expect(layout.segments.filter((segment) => segment.kind === 'bridge')).toEqual([]);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
  });

  it('starts a river that rises here inside the town and runs it out at its bearing', () => {
    const brief = find((entry) => entry.river !== undefined && !entry.river.arrivesFrom && entry.river.leavesToward !== undefined);
    const { layout } = town(brief.id);
    const river = riverOf(layout);
    const radius = Math.max(...layout.lots.flatMap((lot) => lot.polygon.map((point) => distance([0, 0], point))));
    expect(distance([0, 0], river.centreLine[0]!)).toBeLessThan(radius);
    expect(distance([0, 0], river.centreLine.at(-1)!)).toBeGreaterThan(radius);
    expect(bearingDifference(exactBearing([0, 0], river.centreLine.at(-1)!), brief.river!.leavesToward!.bearing)).toBeLessThan(1);
  });

  it('lets a river meet the sea', () => {
    const brief = find((entry) => entry.river !== undefined && entry.coast.isCoastal);
    const { layout, city } = town(brief.id);
    expect(layout.waters.map((water) => water.kind)).toEqual(['river', 'sea']);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
  });

  it('gives a settlement with one route exit one arterial, and one with six all six', () => {
    const single = find((entry) => entry.routes.length === 1);
    const one = town(single.id).layout;
    expect(one.exits).toHaveLength(1);
    expect(one.segments.filter((segment) => segment.kind === 'arterial').every((segment) => segment.routeId === single.routes[0]!.routeId)).toBe(true);
    const six = find((entry) => entry.routes.length === 6);
    const all = town(six.id).layout;
    expect(all.exits.map((exit) => exit.bearing)).toEqual(six.routes.map((route) => route.bearing));
    expect(new Set(all.exits.map((exit) => exit.junctionId)).size).toBe(6);
  });

  it('runs an arterial from the centre to every exit', () => {
    const { layout } = badanos;
    const centre = layout.junctions.find((junction) => junction.position[0] === 0 && junction.position[1] === 0)!;
    const carrying = layout.segments.filter((segment) => segment.routeId !== undefined);
    const linked = new Map<string, string[]>();
    for (const segment of carrying) {
      linked.set(segment.fromJunctionId, [...(linked.get(segment.fromJunctionId) ?? []), segment.toJunctionId]);
      linked.set(segment.toJunctionId, [...(linked.get(segment.toJunctionId) ?? []), segment.fromJunctionId]);
    }
    const reached = new Set([centre.id]);
    const queue = [centre.id];
    for (let at = 0; at < queue.length; at++) {
      for (const next of linked.get(queue[at]!) ?? []) if (!reached.has(next)) queue.push(next), reached.add(next);
    }
    for (const exit of layout.exits) expect(reached.has(exit.junctionId), exit.id).toBe(true);
    expect(carrying.every((segment) => segment.kind === 'arterial' || segment.kind === 'bridge')).toBe(true);
  });
});

describe('determinism and isolation', () => {
  it('gives a byte-identical layout for the same city, brief, pack and seed', () => {
    const again = generateLayout(badanos.city, badanos.brief, pack);
    expect(JSON.stringify(again)).toBe(JSON.stringify(badanos.layout));
    const fresh = town('settlement-641', parsePack(rawMedievalPack()));
    expect(JSON.stringify(fresh.layout)).toBe(JSON.stringify(badanos.layout));
  });

  it('does not change the city or the brief it was given', () => {
    const brief = settlement('settlement-641');
    const city = generateCity(brief, pack);
    const cityBefore = JSON.stringify(city);
    const briefBefore = JSON.stringify(brief);
    generateLayout(city, brief, pack);
    expect(JSON.stringify(city)).toBe(cityBefore);
    expect(JSON.stringify(brief)).toBe(briefBefore);
  });

  it('leaves the city generator at version 2', () => {
    expect(GENERATOR_VERSION).toBe(5);
    expect(badanos.city.summary.generatorVersion).toBe(5);
    expect(LAYOUT_VERSION).toBe(4);
  });

  it('gives a different layout for a different seed, which still passes every invariant', () => {
    const other = generateLayout(badanos.city, badanos.brief, pack, { seed: 12345 });
    expect(other.summary.seed).toBe(12345);
    expect(JSON.stringify(other.lots)).not.toBe(JSON.stringify(badanos.layout.lots));
    expect(other.lots).toHaveLength(1825);
    expect(checkLayout(other, badanos.city, badanos.brief, pack)).toEqual([]);
    // The brief's facts do not move with the seed.
    expect(other.exits).toEqual(badanos.layout.exits.map((exit, index) => ({ ...exit, junctionId: other.exits[index]!.junctionId })));
    expect(riverOf(other).centreLine[1]).toEqual(riverOf(badanos.layout).centreLine[1]);
  });
});

describe('footprints', () => {
  const typeOf = (town: Town) => {
    const types = new Map(town.city.buildings.map((building) => [building.id, building.type]));
    return (lot: Layout['lots'][number]) => types.get(lot.buildingId) as string;
  };
  const built = (lot: Layout['lots'][number]) => lot.footprints.reduce((sum, footprint) => sum + geometry.polygonArea(footprint), 0);

  it('give each lot one rectangle across its street frontage, as deep as the pack\'s coverage', () => {
    const type = typeOf(badanos);
    const { coverage, types } = pack.layout.footprints!;
    let checked = 0;
    for (const lot of badanos.layout.lots) {
      const share = footprintCoverageOf(type(lot), pack);
      if (share === 0) {
        expect(lot.footprints, lot.id).toEqual([]);
        continue;
      }
      expect(lot.footprints, lot.id).toHaveLength(1);
      const footprint = lot.footprints[0]!;
      expect(footprint).toHaveLength(4);
      expect(geometry.polygonWithin(footprint, lot.polygon)).toBe(true);
      expect(built(lot) / geometry.polygonArea(lot.polygon)).toBeCloseTo(share, 9);
      // Against the frontage: the footprint's edge nearest the entrance is the lot's own.
      expect(geometry.distanceToPolygonEdge(lot.entrance.point, footprint)).toBeCloseTo(geometry.distanceToPolygonEdge(lot.entrance.point, lot.polygon), 9);
      // And as wide as the lot.
      const xs = (points: Point[]) => [Math.min(...points.map((point) => point[0])), Math.max(...points.map((point) => point[0]))];
      expect(xs(footprint)).toEqual(xs(lot.polygon));
      checked++;
    }
    expect(checked).toBeGreaterThan(1500);
    expect(footprintCoverageOf('cottage', pack)).toBe(coverage);
    expect(footprintCoverageOf('tenement', pack)).toBe(types.tenement);
  });

  it('leave an open-air building type its open ground: none, or a small footprint where the pack says so', () => {
    const type = typeOf(badanos);
    const openAir = badanos.layout.lots.filter((lot) => placeFlagsOf(type(lot), pack).openAir);
    expect(openAir.length).toBeGreaterThan(100);
    for (const lot of openAir) expect(built(lot), lot.id).toBeLessThan(geometry.polygonArea(lot.polygon) * 0.5);
    expect(openAir.filter((lot) => type(lot) === 'market-stall').every((lot) => lot.footprints.length === 0)).toBe(true);
    expect(openAir.filter((lot) => type(lot) === 'stockyard').every((lot) => lot.footprints.length === 1)).toBe(true);
    expect(footprintCoverageOf('market-stall', pack)).toBe(0);
    expect(footprintCoverageOf('stockyard', pack)).toBe(pack.layout.footprints!.types.stockyard);
  });

  it('leave junctions, segments, lots and entrances as they were at layout version 1', () => {
    // The fingerprint is of Badanos as the city generator made it at version 2, before civic buildings:
    // a pack without them gives that city again, and so the same streets, lots and entrances.
    const before = settlement('settlement-641');
    const was = generateCity(before, medievalPackBefore6B());
    const without = { layout: generateLayout(was, before, medievalPackBefore6B(), BEFORE_6B5) };
    const baseline = JSON.parse(readFileSync(new URL('./baselines/layout-v1.json', import.meta.url), 'utf8')) as { badanos: string };
    const { summary, ...rest } = without.layout;
    const text = JSON.stringify({ ...rest, lots: rest.lots.map(({ footprints: _footprints, ...lot }) => lot) });
    expect(createHash('sha256').update(text).digest('hex')).toBe(baseline.badanos);
    expect(summary.layoutVersion).toBe(4);
    expect(without.layout.lots).toHaveLength(1772);
  });

  it('change in area, and in nothing else, when a coverage value changes', () => {
    const strip = (layout: Layout) => JSON.stringify({ ...layout, lots: layout.lots.map(({ footprints: _footprints, ...lot }) => lot) });
    const roomy = town('settlement-641', edited((raw) => (raw.layout.footprints.coverage = 0.3)));
    expect(strip(roomy.layout)).toBe(strip(badanos.layout));
    const type = typeOf(badanos);
    let changed = 0;
    badanos.layout.lots.forEach((lot, index) => {
      const other = roomy.layout.lots[index]!;
      if (type(lot) in pack.layout.footprints!.types || placeFlagsOf(type(lot), pack).openAir) return expect(other.footprints).toEqual(lot.footprints);
      expect(built(other)).toBeCloseTo(built(lot) / 2, 6);
      changed++;
    });
    expect(changed).toBeGreaterThan(1000);
    // One type's own figure changes that type alone.
    const sheds = town('settlement-641', edited((raw) => (raw.layout.footprints.types['market-stall'] = 0.5)));
    sheds.layout.lots.forEach((lot, index) => {
      if (type(lot) === 'market-stall') expect(built(lot)).toBeCloseTo(geometry.polygonArea(lot.polygon) / 2, 6);
      else expect(lot.footprints).toEqual(badanos.layout.lots[index]!.footprints);
    });
  });

  it('are left out altogether by a pack that says nothing of them', () => {
    const bare = town('settlement-455', edited((raw) => delete raw.layout.footprints));
    expect(bare.layout.lots.every((lot) => lot.footprints.length === 0)).toBe(true);
    expect(checkLayout(bare.layout, bare.city, bare.brief, edited((raw) => delete raw.layout.footprints))).toEqual([]);
  });
});

describe('pack edits take effect', () => {
  it('widens the river in Badanos when the pack does', () => {
    const wide = town('settlement-641', edited((raw) => (raw.layout.riverWidth = 40)));
    expect(riverOf(wide.layout).width).toBe(40);
    expect(riverOf(badanos.layout).width).toBe(14);
    expect(wide.layout.lots).toHaveLength(1825);
    // The bridges are longer for it.
    const span = (layout: Layout) => Math.min(...layout.segments.filter((segment) => segment.kind === 'bridge').map((segment) => polylineLength(segment.points)));
    expect(span(wide.layout)).toBeGreaterThanOrEqual(span(badanos.layout));
  });

  it('enlarges the built area when the default lot is enlarged', () => {
    const roomy = town('settlement-641', edited((raw) => (raw.layout.defaultLot = { frontage: 12, depth: 22 })));
    expect(roomy.layout.summary.builtArea).toBeGreaterThan(badanos.layout.summary.builtArea * 1.05);
    expect(roomy.layout.summary.residentsPerHectare).toBeLessThan(badanos.layout.summary.residentsPerHectare);
  });

  it('follows street widths and block dimensions', () => {
    const changed = town('settlement-641', edited((raw) => {
      raw.layout.streetWidths = { arterial: 14, street: 8, lane: 5, bridge: 9 };
      raw.layout.block = { length: 100, depth: 44 };
    }));
    expect(new Set(changed.layout.segments.map((segment) => `${segment.kind}:${segment.width}`))).toEqual(new Set(['arterial:14', 'street:8', 'lane:5', 'bridge:9']));
    expect(changed.layout.junctions[1]!.position[0] - changed.layout.junctions[0]!.position[0]).toBe(114);
  });

  it('rejects a layout that falls outside the pack\'s density limits', () => {
    const strict = edited((raw) => (raw.layout.density = { min: 400, max: 700 }));
    expect(() => generateLayout(badanos.city, badanos.brief, strict)).toThrow(/settlement-641 \(Badanos\).*residents per hectare of built area, outside the pack's limits of 400 to 700/s);
  });
});

describe('the path function', () => {
  it('finds a path of zero length from a lot to itself', () => {
    const lot = badanos.layout.lots[10]!;
    const path = shortestPath(badanos.layout, lot.id, lot.id);
    expect(path.length).toBe(0);
    expect(path.segmentIds).toEqual([lot.entrance.segmentId]);
    // The one point of the path is the entrance, to within the rounding of projecting it onto its segment.
    expect(path.points).toHaveLength(1);
    expect(geometry.distance(path.points[0]!, lot.entrance.point)).toBeLessThan(1e-9);
    expect(LayoutPathSchema.safeParse(path).success).toBe(true);
  });

  it('walks straight along the street between two lots on one segment', () => {
    const [a, b] = badanos.layout.lots.filter((lot) => lot.entrance.segmentId === badanos.layout.lots[0]!.entrance.segmentId);
    const path = shortestPath(badanos.layout, a!.id, b!.id);
    expect(path.segmentIds).toEqual([a!.entrance.segmentId]);
    expect(path.length).toBeCloseTo(distance(a!.entrance.point, b!.entrance.point), 9);
  });

  it('has a length equal to its whole segments plus the partial segments at its ends', () => {
    const { layout } = badanos;
    const finder = createPathFinder(layout);
    const segments = new Map(layout.segments.map((segment) => [segment.id, segment]));
    const lots = layout.lots;
    for (const [from, to] of [[0, 1771], [100, 900], [1500, 3], [640, 641], [77, 1200]] as const) {
      const a = lots[from]!;
      const b = lots[to]!;
      const path = finder.path(a.id, b.id);
      expect(path.segmentIds[0]).toBe(a.entrance.segmentId);
      expect(path.segmentIds.at(-1)).toBe(b.entrance.segmentId);
      expect(path.points[0]).toEqual(a.entrance.point);
      expect(path.points.at(-1)).toEqual(b.entrance.point);
      // Each segment in turn shares a junction with the next.
      for (let at = 1; at < path.segmentIds.length; at++) {
        const one = segments.get(path.segmentIds[at - 1]!)!;
        const two = segments.get(path.segmentIds[at]!)!;
        expect([one.fromJunctionId, one.toJunctionId].some((id) => id === two.fromJunctionId || id === two.toJunctionId)).toBe(true);
      }
      if (path.segmentIds.length < 2) continue;
      const whole = path.segmentIds.slice(1, -1).reduce((sum, id) => sum + polylineLength(segments.get(id)!.points), 0);
      // The partial segment at each end runs from the entrance to the junction shared with the next segment.
      const partial = (lot: typeof a, own: string, next: string) => {
        const segment = segments.get(own)!;
        const other = segments.get(next)!;
        const along = projectOnPolyline(segment.points, lot.entrance.point).along;
        const viaStart = [other.fromJunctionId, other.toJunctionId].includes(segment.fromJunctionId);
        return viaStart ? along : polylineLength(segment.points) - along;
      };
      const ends = partial(a, path.segmentIds[0]!, path.segmentIds[1]!) + partial(b, path.segmentIds.at(-1)!, path.segmentIds.at(-2)!);
      expect(path.length).toBeCloseTo(whole + ends, 6);
      expect(path.length).toBeCloseTo(polylineLength(path.points), 6);
      // No path is shorter than the straight line, and the same path runs both ways.
      expect(path.length).toBeGreaterThanOrEqual(distance(a.entrance.point, b.entrance.point) - 1e-9);
      expect(finder.path(b.id, a.id).length).toBeCloseTo(path.length, 6);
    }
  });

  it('crosses a bridge between lots on opposite banks, and only then', () => {
    const { layout } = badanos;
    const river = riverOf(layout);
    const finder = createPathFinder(layout);
    const kinds = new Map(layout.segments.map((segment) => [segment.id, segment.kind]));
    const first = layout.lots[0]!;
    const opposite = (lot: (typeof layout.lots)[number]) => crossingsOfPolyline(first.entrance.point, lot.entrance.point, river.centreLine) % 2 === 1;
    let across = 0;
    let same = 0;
    for (const lot of layout.lots.filter((_, index) => index % 40 === 7)) {
      const crosses = finder.path(first.id, lot.id).segmentIds.some((id) => kinds.get(id) === 'bridge');
      expect(crosses, lot.id).toBe(opposite(lot));
      if (crosses) across++;
      else same++;
    }
    expect(across).toBeGreaterThan(3);
    expect(same).toBeGreaterThan(3);
  });

  it('reads only the format: it follows a curved segment by its length', () => {
    // Bend one street of a small town into a long detour; paths over it grow by exactly the added length.
    const { layout } = town('settlement-455');
    const lot = layout.lots[0]!;
    const other = layout.lots.find((entry) => entry.entrance.segmentId !== lot.entrance.segmentId)!;
    const before = shortestPath(layout, lot.id, lot.id).length + shortestPath(layout, layout.lots[0]!.id, other.id).length;
    const bent = structuredClone(layout);
    for (const segment of bent.segments) {
      const [start, end] = [segment.points[0]!, segment.points.at(-1)!];
      const middle: Point = [(start[0] + end[0]) / 2 + 1, (start[1] + end[1]) / 2 + 1];
      segment.points = [start, middle, end];
    }
    for (const entry of bent.lots) {
      const segment = bent.segments.find((candidate) => candidate.id === entry.entrance.segmentId)!;
      entry.entrance.point = projectOnPolyline(segment.points, entry.entrance.point).point;
    }
    const after = shortestPath(bent, lot.id, other.id);
    expect(after.length).toBeGreaterThan(before);
    expect(after.length).toBeCloseTo(polylineLength(after.points), 6);
    expect(after.points.length).toBeGreaterThan(shortestPath(layout, lot.id, other.id).points.length);
  });

  it('fails with a message for a lot that does not exist', () => {
    expect(() => shortestPath(badanos.layout, 'lot-641-999999', badanos.layout.lots[0]!.id)).toThrow(LayoutPathError);
    expect(() => shortestPath(badanos.layout, badanos.layout.lots[0]!.id, 'nowhere')).toThrow(/there is no lot with the ID "nowhere"/);
  });
});
