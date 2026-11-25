/**
 * Phase 6E, Villages: the village generator for settlements under the pack's `village.below` residents, step by
 * step. Steps 1 to 3: water, the road, and the anchors.
 */
import { describe, expect, it } from 'vitest';
import { type City, generateCity } from '../src/index.ts';
import { bearingDifference, distancePolygonToPolyline, polygonsOverlap } from '../src/layout/geometry.ts';
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
    expect(plan.notes).toEqual([]);
  });
});
