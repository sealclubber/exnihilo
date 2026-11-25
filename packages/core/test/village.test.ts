/**
 * Phase 6E, Villages: the village generator for settlements under the pack's `village.below` residents, step by
 * step. Steps 1 to 3: water, the road, and the anchors. Steps 4 and 5: central forks, and plots outward from the
 * centre.
 */
import { describe, expect, it } from 'vitest';
import { type City, generateCity } from '../src/index.ts';
import { SpatialIndex, bearingDifference, boxOf, distancePolygonToPolyline, polygonWithin, polygonsOverlap, projectOnPolyline } from '../src/layout/geometry.ts';
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

describe('which settlements are villages', () => {
  it('is every settlement under 1,000 residents: 136 in Lomia, the smallest with 50 buildings', () => {
    expect(villages).toHaveLength(136);
    expect(Math.min(...villages.map(({ city }) => city.buildings.length))).toBe(50);
    for (const { brief } of villages) expect(brief.population).toBeLessThan(settings.below);
  });
});

describe('steps 1 to 3 in every village', () => {
  const plans = villages.map(({ brief, city }) => ({ brief, plan: planVillage(brief, villageInput(city), pack) }));

  it('picks a shape from the brief, first match wins', () => {
    const count = { shore: 0, crossroads: 0, green: 0, street: 0 };
    for (const { brief, plan } of plans) {
      count[plan.shape]++;
      if (brief.coast.isCoastal) expect(plan.shape).toBe('shore');
      else if (plan.ways.filter((way) => way.kind === 'road').length >= 2) expect(plan.shape).toBe('crossroads');
    }
    console.log(`Village shapes in Lomia: ${JSON.stringify(count)}`);
    expect(count.shore).toBe(villages.filter(({ brief }) => brief.coast.isCoastal).length);
  });

  it('lays every land route as a road from the centre, opposite exits as one through road', () => {
    for (const { brief, plan } of plans) {
      const carried = plan.ways.flatMap((way) => way.routes).sort((a, b) => a - b);
      const land = brief.routes.flatMap((route, at) => (route.kind === 'sea-route' ? [] : [at]));
      expect(carried, brief.name).toEqual(land);
      for (const way of plan.ways.filter((one) => one.kind === 'road')) {
        expect(way.width).toBe(settings.widths.road);
        if (way.routes.length === 2) expect(bearingDifference(brief.routes[way.routes[0]!]!.bearing, brief.routes[way.routes[1]!]!.bearing)).toBeGreaterThan(settings.road.through);
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
      const plots = plan.anchors.sites.filter((site) => site.role !== 'landing' && site.role !== 'well' && site.role !== 'green');
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

describe('steps 4 and 5 in every village', () => {
  const plans = villages.map(({ brief, city }) => ({ brief, city, plan: planVillage(brief, villageInput(city), pack) }));

  it('forks lanes off the road near the centre from 90 buildings, two under 150 and three above', () => {
    const lanes = { small: 0, middle: 0, large: 0 };
    for (const { brief, plan } of plans) {
      const extra = plan.ways.filter((way) => way.kind === 'lane').length - plan.anchors.lanes.length;
      if (plan.buildings < settings.forks.from) expect(extra, brief.name).toBe(0);
      else if (plan.shape !== 'crossroads') expect(extra, brief.name).toBeLessThanOrEqual(plan.buildings < 150 ? 2 : 3);
      lanes[plan.buildings < settings.forks.from ? 'small' : plan.buildings < 150 ? 'middle' : 'large'] += extra;
    }
    console.log(`Forks and links laid: ${JSON.stringify(lanes)}`);
  });

  it('places every building at most once, on a plot clear of every other, of the ways, the water and the anchors', () => {
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
    console.log(`After step 5, ${placed} of ${all} buildings in Lomia's villages have a plot or an anchor`);
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
