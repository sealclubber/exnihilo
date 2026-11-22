/**
 * Phase 6C, change 8: civic buildings that the pack spreads, such as wells, stand apart inside a district.
 */
import { describe, expect, it } from 'vitest';
import { type City, type Layout, LAYOUT_VERSION, generateCity, generateLayout } from '../src/index.ts';
import { lomiaWorld, medievalPack, settlement } from './pack.ts';

const pack = medievalPack();
const spreadCivic = new Set(pack.landmarks.filter((landmark) => landmark.spread).map((landmark) => landmark.id));

/** For each district and spread civic type: how many of the type open onto each segment, and how many segments the district's lots open onto. */
function spacing(city: City, layout: Layout) {
  const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
  const segmentsOf = new Map<string, Set<string>>();
  const counts = new Map<string, Map<string, number>>();
  for (const lot of layout.lots) {
    segmentsOf.set(lot.districtId, (segmentsOf.get(lot.districtId) ?? new Set()).add(lot.entrance.segmentId));
    const type = typeOf.get(lot.buildingId)!;
    if (!spreadCivic.has(type)) continue;
    const key = `${lot.districtId}|${type}`;
    const onSegment = counts.get(key) ?? new Map<string, number>();
    onSegment.set(lot.entrance.segmentId, (onSegment.get(lot.entrance.segmentId) ?? 0) + 1);
    counts.set(key, onSegment);
  }
  return [...counts].map(([key, onSegment]) => {
    const [districtId, type] = key.split('|') as [string, string];
    return { districtId, type, onSegment: [...onSegment.values()], segments: segmentsOf.get(districtId)!.size };
  });
}

describe('civic buildings of a spread type', () => {
  it('are wells and public ovens in the medieval pack, at layout version 4', () => {
    expect([...spreadCivic].sort()).toEqual(['public-oven', 'well']);
    expect(LAYOUT_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('open onto streets of their own in Mill Row, where four of six wells shared one stretch of street', () => {
    const brief = settlement('settlement-641');
    const city = generateCity(brief, pack);
    const millRow = city.districts.find((district) => district.name === 'Mill Row')!;
    const wells = spacing(city, generateLayout(city, brief, pack)).find((entry) => entry.districtId === millRow.id && entry.type === 'well')!;
    expect(wells.onSegment.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...wells.onSegment)).toBe(1);
  });

  it('never has two on one segment of a district while another of its segments has none, in any settlement of Lomia', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const brief of lomiaWorld().settlements) {
      const city = generateCity(brief, pack);
      for (const { districtId, type, onSegment, segments } of spacing(city, generateLayout(city, brief, pack))) {
        checked += onSegment.reduce((sum, count) => sum + count, 0);
        if (Math.max(...onSegment) > 1 && onSegment.length < segments) failures.push(`${brief.id}: ${districtId} has ${onSegment.join(', ')} of ${type} on its segments, and ${segments - onSegment.length} segments with none`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  });
});
