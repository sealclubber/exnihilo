/**
 * Phase 6C, change 1: each route exit of a brief says which settlement is next along the route.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RouteLeadSchema, importAfmg } from '../src/index.ts';
import { loadLomia } from './fixture.ts';
import { lomiaWorld, settlement } from './pack.ts';

const world = lomiaWorld();
const briefs = new Map(world.settlements.map((brief) => [brief.id, brief]));

describe('where each route leads', () => {
  it('takes the Pusztaszian trail from Badanos to Pusztaszi at bearing 227 and to Veszfetaros at bearing 61', () => {
    const exits = settlement('settlement-641').routes;
    expect(exits.map((exit) => [exit.name, exit.bearing, exit.leadsTo?.name])).toEqual([
      ['Pusztaszian trail', 61, 'Veszfetaros'],
      ['Pusztaszian trail', 227, 'Pusztaszi'],
    ]);
    expect(exits[1]!.leadsTo).toEqual({ settlementId: 'settlement-350', name: 'Pusztaszi', sizeGroup: 'town', population: 3788, culture: briefs.get('settlement-350')!.culture.name, state: briefs.get('settlement-350')!.state.name, distance: exits[1]!.leadsTo!.distance });
    // Pusztaszi is the next cell along; Veszfetaros is four cells off.
    expect(exits[1]!.leadsTo!.distance).toBeGreaterThan(0);
    expect(exits[0]!.leadsTo!.distance).toBeGreaterThan(2 * exits[1]!.leadsTo!.distance);
  });

  it('names only settlements that exist, as they are, and leads back along the same route', () => {
    let leads = 0;
    let none = 0;
    for (const brief of world.settlements) {
      for (const exit of brief.routes) {
        const lead = exit.leadsTo;
        if (!lead) {
          none++;
          continue;
        }
        leads++;
        expect(RouteLeadSchema.safeParse(lead).success).toBe(true);
        const there = briefs.get(lead.settlementId);
        expect(there, `${brief.id} by ${exit.routeId}`).toBeDefined();
        expect(lead).toMatchObject({ name: there!.name, sizeGroup: there!.sizeGroup, population: there!.population, culture: there!.culture.name, state: there!.state.name });
        expect(lead.settlementId).not.toBe(brief.id);
        // From there, the same route leads here, and it is as far.
        const back = there!.routes.filter((other) => other.routeId === exit.routeId && other.leadsTo?.settlementId === brief.id);
        // A route that loops may lead back by both of its ends; one of them is this stretch, and as long.
        expect(back.length, `${lead.settlementId} back to ${brief.id} by ${exit.routeId}`).toBeGreaterThanOrEqual(1);
        expect(back.map((other) => other.leadsTo!.distance)).toContain(lead.distance);
      }
    }
    // 1,566 of Lomia's 1,794 exits lead to a settlement; the rest run on to a junction with another route, or off the map.
    expect([leads, none]).toEqual([1566, 228]);
    expect(importAfmg(loadLomia()).report.warnings.filter((warning) => warning.code === 'route-misses-exit')).toEqual([]);
  });

  it('leaves the field out where a route reaches no settlement', () => {
    const exit = world.settlements.flatMap((brief) => brief.routes).find((entry) => entry.leadsTo === undefined)!;
    expect('leadsTo' in exit).toBe(false);
  });

  it('changes nothing else in any brief', () => {
    const baseline = JSON.parse(readFileSync(new URL('./baselines/streets-before-6c.json', import.meta.url), 'utf8')) as { briefs: string };
    const without = world.settlements.map((brief) => ({ ...brief, routes: brief.routes.map(({ leadsTo: _leadsTo, ...exit }) => exit) }));
    expect(createHash('sha256').update(JSON.stringify(without)).digest('hex')).toBe(baseline.briefs);
    expect(world.settlements.some((brief) => brief.routes.some((exit) => exit.leadsTo !== undefined))).toBe(true);
  });
});
