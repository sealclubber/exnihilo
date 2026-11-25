/**
 * The layout invariants, tested on small layouts built by hand: no generator
 * is involved, and none of the shapes need be a rectangle.
 */
import { describe, expect, it } from 'vitest';
import {
  type City,
  type Layout,
  type Point,
  type SettingPack,
  type SettlementBrief,
  LAYOUT_VERSION,
  LayoutSchema,
  checkLayout,
  geometry,
} from '../src/index.ts';
import { medievalPack, settlement } from './pack.ts';

const pack = medievalPack();

/** A settlement of two buildings in one district, with one road leaving east. */
function fixture(): { layout: Layout; city: City; brief: SettlementBrief } {
  const brief: SettlementBrief = {
    ...structuredClone(settlement('settlement-641')),
    id: 'settlement-1',
    population: 10,
    routes: [{ routeId: 'route-1', name: 'East road', kind: 'road', towardCellId: 'cell-1', bearing: 90 }],
    coast: { isCoastal: false },
  };
  delete brief.river;
  const city = {
    people: Array.from({ length: 10 }, () => ({})),
    households: [],
    buildings: [
      { id: 'building-1-000001', type: 'cottage', kind: 'dwelling', districtId: 'district-1-001', householdIds: [], workerIds: [] },
      { id: 'building-1-000002', type: 'cottage', kind: 'dwelling', districtId: 'district-1-001', householdIds: [], workerIds: [] },
    ],
    districts: [{ id: 'district-1-001', name: 'Old Town', kind: 'centre', buildingIds: ['building-1-000001', 'building-1-000002'] }],
  } as unknown as City;

  const layout: Layout = {
    junctions: [
      { id: 'junction-1-000001', position: [-50, 0], kind: 'dead-end' },
      { id: 'junction-1-000002', position: [0, 0], kind: 'crossing' },
      { id: 'junction-1-000003', position: [60, 0], kind: 'exit' },
    ],
    segments: [
      { id: 'segment-1-000001', fromJunctionId: 'junction-1-000001', toJunctionId: 'junction-1-000002', points: [[-50, 0], [0, 0]], kind: 'street', width: 6 },
      { id: 'segment-1-000002', fromJunctionId: 'junction-1-000002', toJunctionId: 'junction-1-000003', points: [[0, 0], [30, -4], [60, 0]], kind: 'arterial', width: 10, name: 'East road', routeId: 'route-1' },
    ],
    exits: [{ id: 'exit-1-001', junctionId: 'junction-1-000003', routeId: 'route-1', name: 'East road', kind: 'road', bearing: 90 }],
    waters: [],
    lots: [
      // A five-sided lot and a four-sided one that is not a rectangle, side by side south of the street.
      { id: 'lot-1-000001', buildingId: 'building-1-000001', polygon: [[-40, 5], [-30, 5], [-30, 25], [-35, 28], [-40, 25]], districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000001', point: [-35, 0] }, footprints: [[[-40, 5], [-34, 5], [-34, 15], [-40, 15]], [[-33, 18], [-31, 18], [-31, 24], [-34, 26]]] },
      { id: 'lot-1-000002', buildingId: 'building-1-000002', polygon: [[-30, 5], [-20, 5], [-18, 25], [-30, 25]], districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000001', point: [-25, 0] }, footprints: [] },
    ],
    districtAreas: [{ districtId: 'district-1-001', polygons: [[[-50, 0], [0, 0], [0, 30], [-50, 30]]], labelPoint: [-25, 15] }],
    walls: [],
    places: [],
    summary: {
      settlementId: 'settlement-1',
      counts: { junctions: 3, segments: 2, exits: 1, waters: 0, lots: 2, districtAreas: 1, walls: 0, gates: 0, places: 0 },
      outlineArea: 1500,
      bounds: { minX: -50, minY: -4, maxX: 60, maxY: 28 },
      builtArea: 0,
      residentsPerHectare: 0,
      ringShare: 0,
      roadsOut: 1,
      layoutVersion: LAYOUT_VERSION,
      generator: 'by-hand',
      pack: { name: 'medieval', version: pack.pack.version },
      seed: 1,
    },
  };
  return { layout: summarise(layout, city), city, brief };
}

/** Brings the summary's derived figures up to date after a layout has been edited. */
function summarise(layout: Layout, city: City): Layout {
  const builtArea = layout.lots.reduce((sum, lot) => sum + geometry.polygonArea(lot.polygon), 0);
  layout.summary.builtArea = builtArea;
  layout.summary.residentsPerHectare = city.people.length / (builtArea / 10_000);
  layout.summary.counts = {
    junctions: layout.junctions.length,
    segments: layout.segments.length,
    exits: layout.exits.length,
    waters: layout.waters.length,
    lots: layout.lots.length,
    districtAreas: layout.districtAreas.length,
    walls: layout.walls.length,
    gates: layout.walls.reduce((sum, wall) => sum + wall.gates.length, 0),
    places: layout.places.length,
  };
  return layout;
}

/** A block behind the street holding both lots, with a courtyard behind them that both back onto. */
const withCourtyard = (layout: Layout): Layout => {
  layout.blocks = [{ id: 'block-1-000001', polygon: [[-45, 3], [-15, 3], [-15, 40], [-45, 40]], districtId: 'district-1-001', growthRank: 0 }];
  layout.courtyards = [{ id: 'courtyard-1-000001', blockId: 'block-1-000001', polygon: [[-40, 30], [-20, 30], [-20, 38], [-40, 38]], lotIds: ['lot-1-000001', 'lot-1-000002'] }];
  return layout;
};
const river = (x: number) => ({ id: 'water-1-001', kind: 'river' as const, centreLine: [[x, -300], [x, 300]] as Point[], width: 12 });
const sea = (shore: number) => ({ id: 'water-1-001', kind: 'sea' as const, polygon: [[shore, -500], [shore, 500], [shore - 500, 500], [shore - 500, -500]] as Point[] });

describe('a sound layout built by hand', () => {
  it('fits the format and breaks no rule', () => {
    const { layout, city, brief } = fixture();
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
  });

  it('may have a courtyard behind its lots', () => {
    const { layout, city, brief } = fixture();
    withCourtyard(layout);
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
  });

  it('may have a river that the streets do not cross', () => {
    const { layout, city, brief } = fixture();
    layout.waters.push(river(95));
    brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 180 } };
    expect(checkLayout(summarise(layout, city), city, brief, pack)).toEqual([]);
  });

  it('may have the sea on the side of the brief\'s water bearing', () => {
    const { layout, city, brief } = fixture();
    layout.waters.push(sea(-80));
    brief.coast = { isCoastal: true, waterBearing: 270 };
    expect(checkLayout(summarise(layout, city), city, brief, pack)).toEqual([]);
  });
});

describe('broken layouts', () => {
  type Parts = ReturnType<typeof fixture>;
  const cases: Array<[string, (parts: Parts) => void, RegExp]> = [
    ['a building without a lot', ({ layout }) => layout.lots.pop(), /building-1-000002 has no lot/],
    ['two lots for one building', ({ layout }) => (layout.lots[1]!.buildingId = 'building-1-000001'), /building-1-000001 has more than one lot/],
    ['a lot for a building that does not exist', ({ layout }) => (layout.lots[1]!.buildingId = 'building-1-000009'), /belongs to building-1-000009, which does not exist/],
    ['a lot in a district other than its building\'s', ({ layout, city }) => { city.districts.push({ ...city.districts[0]!, id: 'district-1-002' }); layout.lots[1]!.districtId = 'district-1-002'; }, /lot-1-000002 is in district-1-002 but its building building-1-000002 is in district-1-001/],
    ['a footprint that reaches outside its lot', ({ layout }) => (layout.lots[0]!.footprints[0] = [[-40, 5], [-28, 5], [-28, 15], [-40, 15]]), /lot-1-000001 has a footprint that does not lie inside the lot/],
    ['a footprint that pokes through the lot\'s slanted side', ({ layout }) => (layout.lots[1]!.footprints = [[[-22, 20], [-18, 20], [-18, 24], [-22, 24]]]), /lot-1-000002 has a footprint that does not lie inside the lot/],
    ['footprints that overlap on one lot', ({ layout }) => (layout.lots[0]!.footprints[1] = [[-36, 10], [-31, 10], [-31, 24], [-36, 24]]), /lot-1-000001 has footprints that overlap each other/],
    ['a footprint with no area', ({ layout }) => (layout.lots[1]!.footprints = [[[-28, 10], [-25, 10], [-22, 10]]]), /lot-1-000002 has a footprint with no area/],
    ['lots that overlap', ({ layout }) => (layout.lots[1]!.polygon = [[-33, 5], [-20, 5], [-18, 25], [-33, 25]]), /lot-1-000001 overlaps lot-1-000002/],
    ['a lot on the roadway', ({ layout }) => (layout.lots[0]!.polygon = [[-40, 2], [-30, 2], [-30, 25], [-40, 25]]), /lot-1-000001 overlaps the roadway of segment-1-000001/],
    ['a lot under a curved street', ({ layout }) => { layout.lots[1]!.polygon = [[20, -30], [40, -30], [40, -8], [20, -8]]; layout.districtAreas[0]!.polygons = [[[-50, -40], [50, -40], [50, 30], [-50, 30]]]; }, /lot-1-000002 overlaps the roadway of segment-1-000002/],
    ['an entrance that is not on its segment', ({ layout }) => (layout.lots[0]!.entrance.point = [-35, 1]), /lot-1-000001 has an entrance point that is not on segment-1-000001/],
    ['an entrance on a segment that does not border the lot', ({ layout }) => (layout.lots[0]!.entrance.point = [-5, 0]), /lot-1-000001 does not border segment-1-000001/],
    ['an entrance on a segment that does not exist', ({ layout }) => (layout.lots[0]!.entrance.segmentId = 'segment-1-000009'), /opens onto segment-1-000009, which does not exist/],
    ['a street graph in two parts', ({ layout }) => { layout.junctions.push({ id: 'junction-1-000004', position: [0, 80], kind: 'dead-end' }, { id: 'junction-1-000005', position: [40, 80], kind: 'dead-end' }); layout.segments.push({ id: 'segment-1-000003', fromJunctionId: 'junction-1-000004', toJunctionId: 'junction-1-000005', points: [[0, 80], [40, 80]], kind: 'lane', width: 4 }); }, /the street graph is not connected: 2 junctions/],
    ['a segment that names a missing junction', ({ layout }) => (layout.segments[0]!.fromJunctionId = 'junction-1-000009'), /segment-1-000001 names junction-1-000009, which does not exist/],
    ['a segment that does not start at its junction', ({ layout }) => (layout.segments[0]!.points[0] = [-50, 3]), /segment-1-000001 does not start at the position of junction-1-000001/],
    ['a missing exit', ({ layout }) => { layout.exits.pop(); layout.junctions[2]!.kind = 'dead-end'; }, /there are 0 exits but the brief has 1 route exits/],
    ['an exit far from its bearing', ({ layout }) => { layout.junctions[2]!.position = [40, -40]; layout.segments[1]!.points = [[0, 0], [40, -40]]; }, /exit-1-001 lies at bearing 45\.0 from the centre, more than 20 degrees from the brief's 90/],
    ['an exit that does not match the brief', ({ layout }) => (layout.exits[0]!.routeId = 'route-7'), /exit-1-001 does not match the brief's route exit 1: route-1 at bearing 90/],
    ['an exit junction not marked as one', ({ layout }) => (layout.junctions[2]!.kind = 'crossing'), /exit-1-001 is at junction-1-000003, which is not marked as an exit/],
    ['a river the brief does not have', ({ layout }) => layout.waters.push(river(95)), /there are 1 rivers but the brief has none/],
    ['no river where the brief has one', ({ brief }) => (brief.river = { id: 'river-1', name: 'Test', leavesToward: { cellId: 'cell-3', bearing: 180 } }), /there are 0 rivers but the brief has one/],
    ['a river leaving at the wrong bearing', ({ layout, brief }) => { layout.waters.push(river(95)); brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 90 } }; }, /water-1-001 leaves at bearing 162\.4, more than 20 degrees from the brief's 90/],
    ['a river that stops short of the town\'s edge', ({ layout, brief }) => { layout.waters.push({ ...river(95), centreLine: [[2, -20], [95, 0], [95, 300]] }); brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 180 } }; }, /water-1-001 arrives 20 m from the centre, short of the town's edge/],
    ['a street that crosses the river without a bridge', ({ layout, brief }) => { layout.waters.push(river(30)); brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 180 } }; }, /segment-1-000002, which is not a bridge, enters water-1-001, the river/],
    ['a lot in the river', ({ layout, brief }) => { layout.waters.push(river(-25)); brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 180 } }; }, /lot-1-000002 overlaps water-1-001, the river/],
    ['a coastal settlement with no sea', ({ brief }) => (brief.coast = { isCoastal: true, waterBearing: 270 }), /there are 0 seas but the brief says the settlement is coastal/],
    ['the sea on the wrong side', ({ layout, brief }) => { layout.waters.push(sea(-80)); brief.coast = { isCoastal: true, waterBearing: 90 }; }, /water-1-001 is not in the direction of the brief's water bearing, 90\n.*also lies opposite/],
    ['a street running into the sea', ({ layout, brief }) => { layout.waters.push(sea(-45)); brief.coast = { isCoastal: true, waterBearing: 270 }; }, /segment-1-000001, which is not a bridge, enters water-1-001, the sea/],
    ['a lot in the sea', ({ layout, brief }) => { layout.waters.push(sea(-35)); brief.coast = { isCoastal: true, waterBearing: 270 }; }, /lot-1-000001 overlaps water-1-001, the sea/],
    ['a district with lots but no area', ({ layout }) => layout.districtAreas.pop(), /district-1-001 has lots but no district area/],
    ['a bridge link over a segment that is no bridge', ({ layout }) => (layout.bridgeLinks = [{ segmentId: layout.segments[0]!.id, from: 'district-1-001', to: 'district-1-001' }]), /a bridge link names segment-1-000001, which is not a bridge/],
    ['a courtyard over a lot', ({ layout }) => (withCourtyard(layout).courtyards![0]!.polygon = [[-40, 20], [-20, 20], [-20, 38], [-40, 38]]), /courtyard-1-000001 overlaps lot-1-000001/],
    ['a courtyard on the roadway', ({ layout }) => { withCourtyard(layout).blocks![0]!.polygon = [[-50, -5], [-15, -5], [-15, 40], [-50, 40]]; layout.courtyards![0]!.polygon = [[-48, -2], [-42, -2], [-42, 4], [-48, 4]]; }, /courtyard-1-000001 overlaps the roadway of segment-1-000001/],
    ['a courtyard outside its block', ({ layout }) => (withCourtyard(layout).courtyards![0]!.polygon = [[-40, 30], [-20, 30], [-20, 45], [-40, 45]]), /courtyard-1-000001 does not lie inside block-1-000001/],
    ['a courtyard in a block the layout does not have', ({ layout }) => (withCourtyard(layout).courtyards![0]!.blockId = 'block-1-000009'), /courtyard-1-000001 is in block-1-000009, which the layout does not have/],
    ['a courtyard backed by a lot that does not exist', ({ layout }) => withCourtyard(layout).courtyards![0]!.lotIds.push('lot-1-000009'), /courtyard-1-000001 names lot-1-000009, which does not exist/],
    ['a lot backing onto two courtyards', ({ layout }) => withCourtyard(layout).courtyards!.push({ id: 'courtyard-1-000002', blockId: 'block-1-000001', polygon: [[-44, 30], [-42, 30], [-42, 38], [-44, 38]], lotIds: ['lot-1-000001'] }), /lot-1-000001 backs onto both courtyard-1-000001 and courtyard-1-000002/],
    ['a passage along a segment that does not exist', ({ layout }) => (withCourtyard(layout).courtyards![0]!.passage = 'segment-1-000009'), /courtyard-1-000001 has its passage along segment-1-000009, which does not exist/],
    ['district areas that overlap', ({ layout, city }) => { city.districts.push({ ...city.districts[0]!, id: 'district-1-002', buildingIds: [] }); layout.districtAreas.push({ districtId: 'district-1-002', polygons: [[[-10, 10], [40, 10], [40, 60], [-10, 60]]], labelPoint: [20, 40] }); }, /the areas of district-1-001 and district-1-002 overlap/],
    ['a label point outside the area', ({ layout }) => (layout.districtAreas[0]!.labelPoint = [200, 200]), /the label point of district-1-001 is outside its area/],
    // The fixture's brief has 10 residents, which makes it a village: the pack's village limits apply.
    ['too few residents for the built area', ({ city }) => (city.people.length = 1), /residents per hectare of built area, outside the pack's limits of 30 to 700/],
    ['too many residents for the built area', ({ city }) => (city.people.length = 400), /residents per hectare of built area, outside the pack's limits/],
    ['records out of ID order', ({ layout }) => layout.lots.reverse(), /lot lot-1-000001 is out of ID order or repeated/],
    ['a repeated ID', ({ layout }) => (layout.junctions[1]!.id = 'junction-1-000001'), /junction junction-1-000001 is out of ID order or repeated/],
    ['a summary that miscounts', ({ layout }) => (layout.summary.counts.lots = 7), /the summary counts 7 lots but there are 2/],
    ['a summary with the wrong built area', ({ layout }) => (layout.summary.builtArea += 50), /the summary gives a built area/],
    ['bounds that leave something out', ({ layout }) => (layout.summary.bounds.maxX = 10), /the summary's bounds do not contain every lot and segment/],
    ['a layout for another settlement', ({ layout }) => (layout.summary.settlementId = 'settlement-2'), /the summary names settlement-2, not settlement-1/],
  ];
  it.each(cases)('reports %s', (name, damage, expected) => {
    const parts = fixture();
    damage(parts);
    // Keep the summary's derived figures honest unless the case is about the summary itself.
    if (!name.includes('summary') && !name.includes('residents') && !name.includes('bounds')) summarise(parts.layout, parts.city);
    if (name.includes('residents')) parts.layout.summary.residentsPerHectare = parts.city.people.length / (parts.layout.summary.builtArea / 10_000);
    expect(checkLayout(parts.layout, parts.city, parts.brief, pack).join('\n')).toMatch(expected);
  });

  it('holds a town to the town\'s density limits and a village to the village\'s', () => {
    // 2 residents on the fixture's two lots, about 0.04 ha: under 50 a hectare, enough for a village but not a town.
    for (const [population, people, expected] of [[10, 2, []], [5000, 2, ["outside the pack's limits of 60 to 700"]]] as const) {
      const { layout, city, brief } = fixture();
      brief.population = population;
      city.people.length = people;
      summarise(layout, city);
      const found = checkLayout(layout, city, brief, pack).filter((problem) => problem.includes('residents per hectare'));
      expect(found.map((problem) => problem.replace(/.*(outside.*)/, '$1')), String(population)).toEqual(expected);
    }
  });

  it('accepts a bridge where a plain street would be refused', () => {
    const { layout, city, brief } = fixture();
    layout.waters.push(river(30));
    brief.river = { id: 'river-1', name: 'Test', arrivesFrom: { cellId: 'cell-2', bearing: 0 }, leavesToward: { cellId: 'cell-3', bearing: 180 } };
    layout.segments[1]!.kind = 'bridge';
    expect(checkLayout(summarise(layout, city), city, brief, pack)).toEqual([]);
  });

  it('wants a port\'s waterside district to touch the water', () => {
    const port = (shore: number, packUsed: SettingPack = pack) => {
      const { layout, city, brief } = fixture();
      city.districts[0]!.kind = 'harbour';
      brief.flags = { ...brief.flags, port: true };
      brief.coast = { isCoastal: true, waterBearing: 270 };
      layout.waters.push(sea(shore));
      return checkLayout(summarise(layout, city), city, brief, packUsed);
    };
    expect(port(-80)).toEqual([]);
    expect(port(-200).join('\n')).toMatch(/district-1-001 is a waterside district but lies 150\.0 m from the water, beyond the pack's reach of 40 m/);
    const generous = structuredClone(pack);
    generous.layout.watersideReach = 200;
    expect(port(-200, generous)).toEqual([]);
    // A port with no waterside district at all.
    const { layout, city, brief } = fixture();
    brief.flags = { ...brief.flags, port: true };
    expect(checkLayout(layout, city, brief, pack).join('\n')).toMatch(/the settlement is a port but has no waterside district/);
  });
});
