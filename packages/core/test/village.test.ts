/**
 * Phase 6E, Villages: the village generator for settlements under the pack's `village.below` residents, step by
 * step. Steps 1 to 3: water, the road, and the anchors. Steps 4 to 6: central forks, plots outward from the
 * centre, and lanes added until every building has a plot. Steps 7 and 8: the palisade and the fields.
 */
import { describe, expect, it } from 'vitest';
import { type City, VILLAGE_GENERATOR, checkLayout, createLife, createPlanChecker, generateCity, generateLayout, geometry } from '../src/index.ts';
import { SpatialIndex, bearingDifference, boxOf, distancePolygonToPolyline, polygonWithin, polygonsOverlap, projectOnPolyline } from '../src/layout/geometry.ts';
import { crossingsAlong } from '../src/layout/staged/lines.ts';
import { armsOf } from '../src/layout/village/forks.ts';
import { isVillage, planVillage, villageInput } from '../src/layout/village/plan.ts';
import type { SettlementBrief } from '../src/schema.ts';
import { lomiaWorld, medievalPack } from './pack.ts';

const pack = medievalPack();
const settings = pack.layout.village!;
const villages: Array<{ brief: SettlementBrief; city: City }> = lomiaWorld()
  .settlements.filter((brief) => isVillage(brief, pack))
  .map((brief) => ({ brief, city: generateCity(brief, pack) }));
const named = (name: string) => villages.find(({ brief }) => brief.name === name)!;
/** Every village planned once, for all the tests that read the plans. */
let planned: Array<{ brief: SettlementBrief; city: City; plan: ReturnType<typeof planVillage> }> | undefined;
const allPlans = () => (planned ??= villages.map(({ brief, city }) => ({ brief, city, plan: planVillage(brief, villageInput(city), pack) })));

describe('which settlements are villages', () => {
  it('is every settlement under 1,000 residents: 136 in Lomia, the smallest with 50 buildings', () => {
    expect(villages).toHaveLength(136);
    expect(Math.min(...villages.map(({ city }) => city.buildings.length))).toBe(50);
    for (const { brief } of villages) expect(brief.population).toBeLessThan(settings.below);
  });
});

describe('steps 1 to 3 in every village', () => {
  const plans = allPlans();

  it('picks a shape from the brief, first match wins, and gives a share of villages a green', () => {
    const count = { shore: 0, crossroads: 0, street: 0 };
    let greens = 0;
    for (const { brief, plan } of plans) {
      count[plan.shape]++;
      const land = brief.routes.filter((route) => route.kind !== 'sea-route').length;
      const through = plan.ways.filter((way) => way.kind === 'road' && way.routes.length === 2 && bearingDifference(brief.routes[way.routes[0]!]!.bearing, brief.routes[way.routes[1]!]!.bearing) > settings.road.through).length;
      expect(plan.shape, brief.name).toBe(brief.coast.isCoastal ? 'shore' : land >= 3 || through >= 2 ? 'crossroads' : 'street');
      // Two exits that are not opposite are one road with a bend.
      if (land === 2) expect(plan.ways.filter((way) => way.kind === 'road'), brief.name).toHaveLength(1);
      if (brief.flags.plaza) expect(plan.anchors.green, brief.name).toBeDefined();
      if (plan.anchors.green) greens++;
      // The well stands on the green, at its edge by the road.
      const well = plan.anchors.sites.find((site) => site.role === 'well');
      if (plan.anchors.green && well) expect(geometry.polygonWithin(well.outline, plan.anchors.green.outline), brief.name).toBe(true);
    }
    console.log(`Village shapes in Lomia: ${JSON.stringify(count)}; ${greens} have a green`);
    expect(count.shore).toBe(villages.filter(({ brief }) => brief.coast.isCoastal).length);
    expect(greens / plans.length).toBeGreaterThan(0.3);
  });

  it('lays every land route as a road from the centre, opposite exits as one through road', () => {
    for (const { brief, plan } of plans) {
      const carried = plan.ways.flatMap((way) => way.routes).sort((a, b) => a - b);
      const land = brief.routes.flatMap((route, at) => (route.kind === 'sea-route' ? [] : [at]));
      expect(carried, brief.name).toEqual(land);
      for (const way of plan.ways.filter((one) => one.kind === 'road')) {
        expect(way.width).toBe(settings.widths.road);
        if (way.routes.length === 2 && land.length > 2) expect(bearingDifference(brief.routes[way.routes[0]!]!.bearing, brief.routes[way.routes[1]!]!.bearing)).toBeGreaterThan(settings.road.through);
      }
    }
  });

  it('bridges the stream wherever a road crosses it', () => {
    for (const { brief, plan } of plans) {
      if (!plan.river) continue;
      for (const bridge of plan.bridges) expect(plan.river.gap(bridge.a) > 0 && plan.river.gap(bridge.b) > 0, brief.name).toBe(true);
    }
  });

  it('gives every flag its anchor, each clear of the water, the ways and every other anchor', () => {
    const problems: string[] = [];
    for (const { brief, plan } of plans) {
      const roles = plan.anchors.sites.map((site) => site.role);
      if (brief.flags.citadel && !roles.includes('manor')) problems.push(`${brief.name}: no manor`);
      if (brief.flags.plaza && !roles.includes('green')) problems.push(`${brief.name}: no green`);
      if (brief.flags.port && !roles.includes('landing')) problems.push(`${brief.name}: no landing`);
      if (plan.river && !roles.includes('mill')) problems.push(`${brief.name}: no mill`);
      if (!roles.includes('well')) problems.push(`${brief.name}: no well`);
      const plots = plan.anchors.sites.filter((site) => site.role !== 'well' && site.role !== 'green');
      for (const site of plots) {
        for (const way of plan.ways) if (distancePolygonToPolyline(site.outline, way.points) < way.width / 2 - 0.05) problems.push(`${brief.name}: the ${site.role} is on a way`);
        for (const corner of site.outline) if ((plan.river && plan.river.gap(corner) < -0.01) || (plan.coast && plan.coast.gap(corner) < -0.01)) problems.push(`${brief.name}: the ${site.role} is in the water`);
        for (const other of plots) if (other !== site && polygonsOverlap(site.outline, other.outline)) problems.push(`${brief.name}: the ${site.role} overlaps the ${other.role}`);
      }
      const held = plan.anchors.sites.flatMap((site) => (site.building === undefined ? [] : [site.building]));
      expect(new Set(held).size, brief.name).toBe(held.length);
    }
    expect(problems).toEqual([]);
  });

  it('is the same plan from the same seed', () => {
    const { brief, city } = named('Monhas');
    expect(JSON.stringify(planVillage(brief, villageInput(city), pack))).toBe(JSON.stringify(planVillage(brief, villageInput(city), pack)));
    expect(JSON.stringify(planVillage(brief, villageInput(city), pack, 7))).not.toBe(JSON.stringify(planVillage(brief, villageInput(city), pack)));
  });

  it('puts a green, a manor and a landing where the brief is flagged for them', () => {
    const { brief: found } = named('Monhas');
    const brief = { ...found, flags: { ...found.flags, plaza: true, citadel: true, port: true } };
    const plan = planVillage(brief, villageInput(generateCity(brief, pack)), pack);
    expect(plan.anchors.sites.map((site) => site.role).sort()).toEqual(['church', 'green', 'landing', 'manor', 'mill', 'well']);
    expect(plan.anchors.green?.pond.length).toBeGreaterThan(3);
    expect(plan.notes.filter((note) => /green|manor|landing|church|mill|well/.test(note))).toEqual([]);
  });
});

describe('steps 4 to 6 in every village', () => {
  const plans = allPlans();

  it('forks lanes off the road near the centre from 90 buildings, two under 150 and three above', () => {
    const lanes = { small: 0, middle: 0, large: 0 };
    for (const { brief, plan } of plans) {
      const extra = plan.lanes.forks;
      if (plan.buildings < settings.forks.from) expect(extra, brief.name).toBe(0);
      else if (plan.shape !== 'crossroads') expect(extra, brief.name).toBeLessThanOrEqual(plan.buildings < 150 ? 2 : 3);
      lanes[plan.buildings < settings.forks.from ? 'small' : plan.buildings < 150 ? 'middle' : 'large'] += extra;
    }
    console.log(`Forks and links laid: ${JSON.stringify(lanes)}`);
  });

  it('places every building exactly once, on a plot clear of every other, of the ways, the water and the anchors', () => {
    const problems: string[] = [];
    let placed = 0;
    let all = 0;
    for (const { brief, city, plan } of plans) {
      all += city.buildings.length;
      const held = plan.anchors.sites.flatMap((site) => (site.building === undefined ? [] : [site.building]));
      const ids = [...held, ...plan.plots.map((plot) => plot.building), ...plan.unplaced].sort();
      expect(ids, brief.name).toEqual(city.buildings.map((building) => building.id).sort());
      placed += held.length + plan.plots.length;
      const index = new SpatialIndex<number>(40);
      plan.plots.forEach((plot, at) => index.add(boxOf(plot.outline), at));
      const anchors = [...plan.anchors.sites.filter((site) => site.role !== 'landing').map((site) => site.outline), ...(plan.anchors.green ? [plan.anchors.green.outline] : [])];
      plan.plots.forEach((plot, at) => {
        for (const other of index.near(boxOf(plot.outline))) if (other > at && polygonsOverlap(plot.outline, plan.plots[other]!.outline)) problems.push(`${brief.name}: two plots overlap`);
        for (const way of plan.ways) if (distancePolygonToPolyline(plot.outline, way.points) < way.width / 2 - 0.05) problems.push(`${brief.name}: a plot is on a way`);
        for (const corner of plot.outline) if ((plan.river && plan.river.gap(corner) < 0) || (plan.coast && plan.coast.gap(corner) < 0)) problems.push(`${brief.name}: a plot is in the water`);
        for (const anchor of anchors) if (polygonsOverlap(plot.outline, anchor)) problems.push(`${brief.name}: a plot overlaps an anchor`);
        for (const footprint of [...plot.footprints, ...plot.drawing]) if (!polygonWithin(footprint, plot.outline)) problems.push(`${brief.name}: a house or barn reaches out of its plot`);
      });
    }
    const scales = plans.map(({ plan }) => plan.lanes.reachScale).sort((a, b) => a - b);
    console.log(`After step 6, ${placed} of ${all} buildings in Lomia's villages have a plot or an anchor; ${plans.reduce((sum, { plan }) => sum + plan.lanes.thickened, 0)} lanes added, ${plans.reduce((sum, { plan }) => sum + plan.lanes.displaced, 0)} plots laid again; the lanes reached past the pack's reach in ${scales.filter((scale) => scale > 1).length} villages, by ${scales[scales.length >> 1]!.toFixed(2)} at the median and ${scales[scales.length - 1]!.toFixed(2)} at most`);
    expect(placed).toBe(all);
    for (const { brief, plan } of plans) expect(plan.unplaced, brief.name).toEqual([]);
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('builds a road no farther than the cap each way from the centre', () => {
    for (const { brief, plan } of plans) {
      for (const plot of plan.plots) {
        const way = plan.ways[plot.way]!;
        if (way.kind !== 'road') continue;
        const middle: [number, number] = [(plot.front[0][0] + plot.front[1][0]) / 2, (plot.front[0][1] + plot.front[1][1]) / 2];
        const along = projectOnPolyline(way.points, middle).along - projectOnPolyline(way.points, [0, 0]).along;
        expect(Math.abs(along), brief.name).toBeLessThanOrEqual(plan.cap + settings.plots.width.max);
      }
    }
  });

  it('joins the houses of the centre into terraced rows from 140 buildings, and gives larger lots wider plots', () => {
    for (const { brief, city, plan } of plans) {
      const rows = plan.plots.filter((plot) => plot.row).length;
      if (plan.buildings < settings.plots.row.from) expect(rows, brief.name).toBe(0);
      const widths = new Map(plan.plots.filter((plot) => !plot.row).map((plot) => [plot.building, Math.hypot(plot.front[1][0] - plot.front[0][0], plot.front[1][1] - plot.front[0][1])]));
      const types = new Map(city.buildings.map((building) => [building.id, building.type]));
      const areaOf = (id: string) => { const lot = pack.layout.lots[types.get(id)!] ?? pack.layout.defaultLot; return lot.frontage * lot.depth; };
      const sized = [...widths].sort((a, b) => areaOf(b[0]) - areaOf(a[0]));
      if (sized.length < 10) continue;
      const mean = (part: typeof sized) => part.reduce((sum, [, width]) => sum + width, 0) / part.length;
      expect(mean(sized.slice(0, Math.floor(sized.length / 3))), brief.name).toBeGreaterThan(mean(sized.slice(-Math.floor(sized.length / 3))));
    }
    expect(armsOf(plans.find(({ brief }) => brief.name === 'Monhas')!.plan.ways).length).toBe(2);
  });
});

describe('steps 7 and 8, and the village whole', () => {
  const plans = allPlans();

  it('fronts every plot onto its way, and makes the ways one network', () => {
    for (const { brief, plan } of plans) {
      for (const plot of plan.plots) {
        const way = plan.ways[plot.way]!;
        // Its front's corners stand the gap back from the way's edge; on a bend the middle of the front may not.
        expect(Math.min(...plot.front.map((corner) => projectOnPolyline(way.points, corner).distance)), brief.name).toBeLessThan(way.width / 2 + settings.gap + 0.1);
      }
      // Ways that meet or touch are joined; every way is reached from the first.
      const reached = new Set([0]);
      const queue = [0];
      while (queue.length > 0) {
        const at = queue.pop()!;
        plan.ways.forEach((other, index) => {
          if (reached.has(index)) return;
          const ends = [other.points[0]!, other.points[other.points.length - 1]!];
          const mine = plan.ways[at]!;
          const touches = crossingsAlong(mine.points, other.points).length > 0 || ends.some((end) => projectOnPolyline(mine.points, end).distance < 0.5) || [mine.points[0]!, mine.points[mine.points.length - 1]!].some((end) => projectOnPolyline(other.points, end).distance < 0.5);
          if (touches) {
            reached.add(index);
            queue.push(index);
          }
        });
      }
      expect(reached.size, brief.name).toBe(plan.ways.length);
    }
  });

  it('has a palisade exactly where the brief is flagged walls, with every plot inside it and no field touching it', () => {
    for (const { brief, plan } of plans) {
      expect(plan.palisade !== undefined, brief.name).toBe(brief.flags.walls);
      if (!plan.palisade) continue;
      for (const plot of plan.plots) for (const corner of plot.outline) expect(geometry.pointInPolygon(corner, plan.palisade.ring), brief.name).toBe(true);
      for (const field of plan.countryside.fields) for (const line of plan.palisade.lines) expect(distancePolygonToPolyline(field.outline, line), brief.name).toBeGreaterThan(0);
    }
  });

  it('lays fields outside the village, clear of plots, roads and water', () => {
    let fields = 0;
    const kinds: Record<string, number> = {};
    for (const { brief, plan } of plans) {
      for (const field of plan.countryside.fields) {
        fields++;
        kinds[field.kind] = (kinds[field.kind] ?? 0) + 1;
        for (const corner of field.outline) {
          expect(geometry.pointInPolygon(corner, plan.countryside.envelope) && geometry.distanceToPolygonEdge(corner, plan.countryside.envelope) > 0.01, brief.name).toBe(false);
          if (plan.river) expect(plan.river.gap(corner), brief.name).toBeGreaterThan(0);
          if (plan.coast) expect(plan.coast.gap(corner), brief.name).toBeGreaterThan(0);
        }
        for (const way of plan.ways) if (way.kind === 'road') expect(distancePolygonToPolyline(field.outline, way.points), brief.name).toBeGreaterThan(way.width / 2);
      }
    }
    console.log(`Fields about Lomia's villages: ${fields}, ${JSON.stringify(kinds)}`);
    expect(fields).toBeGreaterThan(plans.length * 10);
  });
});

describe('village layouts', () => {
  it('lays out all 136 villages in the layout format by the pack\'s generator, every one keeping every invariant', () => {
    const problems: string[] = [];
    let walled = 0;
    for (const { brief, city } of villages) {
      const layout = generateLayout(city, brief, pack, { check: false });
      expect(layout.summary.generator, brief.name).toBe(VILLAGE_GENERATOR);
      expect(layout.lots).toHaveLength(city.buildings.length);
      problems.push(...checkLayout(layout, city, brief, pack).map((problem) => `${brief.name}: ${problem}`));
      if (layout.walls.length > 0) walled++;
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(walled).toBe(villages.filter(({ brief }) => brief.flags.walls).length);
  });

  it('is byte-identical from the same seed', () => {
    const { brief, city } = named('Vereceldo');
    expect(JSON.stringify(generateLayout(city, brief, pack))).toBe(JSON.stringify(generateLayout(city, brief, pack)));
  });

  it('carries daily life: every plan keeps its rules, and trips per resident are reported', () => {
    for (const name of ['Vereceldo', 'Monhas']) {
      const { brief, city } = named(name);
      const layout = generateLayout(city, brief, pack);
      const life = createLife({ city, layout, pack });
      const checker = createPlanChecker({ city, layout, pack });
      const plans = life.plansForDay(1);
      const problems = plans.flatMap((plan) => checker.check(plan).map((problem) => `${plan.personId}: ${problem}`));
      expect(problems.slice(0, 5), name).toEqual([]);
      const trips = plans.reduce((sum, plan) => sum + plan.activities.filter((activity) => activity.kind === 'travel').length, 0);
      console.log(`${name}, a village of ${city.buildings.length} buildings: ${(trips / city.people.length).toFixed(2)} trips per resident on day 1`);
      expect(trips).toBeGreaterThan(0);
    }
  });
});
