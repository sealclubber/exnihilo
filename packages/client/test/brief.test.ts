import { beforeAll, describe, expect, it } from 'vitest';
import { type SettlementBrief, type SettlementDraw, type World, importAfmg } from '@worldsim/core';
import { loadLomia } from '../../core/test/fixture.ts';
import { type BriefText, compassPoint, describeBrief, formatNumber } from '../src/brief.ts';
import { markerScale, soften } from '../src/render.ts';

let world: World;
const brief = (id: string): SettlementBrief => world.settlements.find((entry) => entry.id === id)!;
const rows = (text: BriefText, heading: string) =>
  Object.fromEntries(text.sections.find((section) => section.heading.startsWith(heading))?.rows ?? []);
const lines = (text: BriefText, heading: string) =>
  text.sections.find((section) => section.heading.startsWith(heading))?.lines ?? [];

beforeAll(() => {
  world = importAfmg(loadLomia()).world;
});

describe('compassPoint', () => {
  it('names the nearest of sixteen points', () => {
    expect(compassPoint(0)).toBe('north');
    expect(compassPoint(61)).toBe('east-northeast');
    expect(compassPoint(152)).toBe('south-southeast');
    expect(compassPoint(227)).toBe('southwest');
    expect(compassPoint(270)).toBe('west');
    expect(compassPoint(349)).toBe('north');
    expect(compassPoint(359)).toBe('north');
  });
});

describe('describeBrief for Badanos', () => {
  let text: BriefText;
  beforeAll(() => {
    text = describeBrief(brief('settlement-641'), world.info);
  });

  it('titles the panel with the name, size, state and date', () => {
    expect(text.title).toBe('Badanos');
    expect(text.subtitle).toBe('City in Monzian Empire, 848 Thatcking Era');
  });

  it('shows the overview values', () => {
    expect(rows(text, 'Overview')).toEqual({
      'Size group': 'City',
      Population: '9,607',
      'Rural population': '4,495',
      State: 'Monzian Empire (state-4)',
      Province: 'Badanos County (province-24), seat of the province',
      Culture: 'Vengrian (culture-8)',
      Religion: 'Klakkrova Pantheon (religion-14)',
    });
  });

  it('shows all seven flags as No', () => {
    const flags = rows(text, 'Features');
    expect(Object.keys(flags)).toEqual(['Capital', 'Port', 'Citadel', 'Walls', 'Plaza', 'Temple', 'Shanty town']);
    expect(new Set(Object.values(flags))).toEqual(new Set(['No']));
  });

  it('shows specialties, river, routes, coast and climate', () => {
    expect(lines(text, 'Specialties')).toEqual(['leather, arms']);
    expect(rows(text, 'River')).toEqual({
      Name: 'Hegyes (river-85)',
      Arrives: 'From the south-southeast (152°), cell-2237',
      Leaves: 'Toward the east-northeast (61°), cell-2029',
    });
    expect(text.sections.some((section) => section.heading === 'Routes (2 exits)')).toBe(true);
    expect(lines(text, 'Routes')).toEqual([
      'Pusztaszian trail, a trail (route-34), toward the east-northeast (61°), cell-2029, leading to Veszfetaros (village, 93.6 mi)',
      'Pusztaszian trail, a trail (route-34), toward the southwest (227°), cell-2236, leading to Pusztaszi (town, 28.9 mi)',
    ]);
    // Without the world there is no unit to give the distance in.
    expect(lines(describeBrief(brief('settlement-641')), 'Routes')[1]).toMatch(/leading to Pusztaszi \(town, 28\.9\)$/);
    expect(lines(text, 'Coast')).toEqual(['Not coastal']);
    expect(rows(text, 'Climate')).toEqual({
      Biome: 'Tropical seasonal forest',
      Height: '25 of 100',
      Temperature: '33 °C',
    });
  });

  it('shows the reference values', () => {
    expect(rows(text, 'Reference')).toMatchObject({ ID: 'settlement-641', Cell: 'cell-2134', Position: '931.35, 422.9' });
  });
});

describe('describeBrief for other settlements', () => {
  it('describes a coastal capital port', () => {
    const text = describeBrief(brief('settlement-1'));
    expect(text.subtitle).toBe('Capital in See of Klaukia');
    expect(rows(text, 'Features')).toMatchObject({ Capital: 'Yes', Port: 'Yes', Plaza: 'Yes', Temple: 'No' });
    expect(lines(text, 'Coast')[0]).toMatch(/^Coastal, open water to the [a-z-]+ \(\d+°\)$/);
  });

  it('says so when there is no river, and when a river rises or ends in the cell', () => {
    const dry = world.settlements.find((entry) => !entry.river)!;
    expect(lines(describeBrief(dry), 'River')).toEqual(['None']);
    const source = world.settlements.find((entry) => entry.river && !entry.river.arrivesFrom)!;
    expect(rows(describeBrief(source), 'River').Arrives).toBe('Rises here');
    const mouth = world.settlements.find((entry) => entry.river && !entry.river.leavesToward)!;
    expect(rows(describeBrief(mouth), 'River').Leaves).toBe('Ends here');
  });

  it('says where every route leads, or that it leads to no settlement', () => {
    const exits = world.settlements.flatMap((entry) => entry.routes.map((exit, index) => [exit, lines(describeBrief(entry, world.info), 'Routes')[index]!] as const));
    expect(exits.length).toBeGreaterThan(100);
    for (const [exit, line] of exits) {
      if (exit.leadsTo) expect(line).toContain(`leading to ${exit.leadsTo.name} (${exit.leadsTo.sizeGroup}, `);
      else expect(line.endsWith('leading to no settlement')).toBe(true);
    }
  });

  it('shows the draw with what each term adds, only when the draw is given', () => {
    const draw: SettlementDraw = {
      draw: { total: 14.607, floor: 6, attracts: true, terms: [{ term: 'provinceSeat', value: 4 }, { term: 'walls', value: 1 }, { term: 'population', value: 9.607 }, { term: 'specialties', value: 2 }] },
      expectedTravellers: 23.46,
      quarterAt: 22,
      hasQuarter: false,
    };
    const text = describeBrief(brief('settlement-641'), world.info, draw);
    expect(text.sections.find((section) => section.heading === 'Draw')?.rows).toEqual([
      ['Total', '14.61, at or above the floor of 6'],
      ['Seat of the province', '+4'],
      ['Walls', '+1'],
      ['Population', '+9.61'],
      ['Specialties', '+2'],
      ['Travellers expected', '23.5 a day'],
      ['Visitors\' quarter', 'No, at a draw of 22'],
    ]);
    // Below the floor, and from a pack with no visitors' quarter.
    const quiet = describeBrief(brief('settlement-641'), world.info, { draw: { total: 1.2, floor: 6, attracts: false, terms: [{ term: 'population', value: 1.2 }] }, expectedTravellers: 0, hasQuarter: false });
    expect(quiet.sections.find((section) => section.heading === 'Draw')?.rows).toEqual([['Total', '1.2, below the floor of 6'], ['Population', '+1.2'], ['Travellers expected', '0 a day']]);
    expect(describeBrief(brief('settlement-641'), world.info).sections.some((section) => section.heading === 'Draw')).toBe(false);
  });

  it('describes unnamed routes and sea routes in words', () => {
    const all = world.settlements.flatMap((entry) => lines(describeBrief(entry), 'Routes'));
    expect(all.some((line) => line.startsWith('Unnamed trail (route-'))).toBe(true);
    expect(all.some((line) => line.includes('sea route (route-'))).toBe(true);
    expect(all.some((line) => line.includes('sea-route'))).toBe(false);
  });

  it('produces text for every settlement without blanks', () => {
    for (const entry of world.settlements) {
      const text = describeBrief(entry, world.info);
      const values = text.sections.flatMap((section) => [
        ...(section.rows ?? []).map(([, value]) => value),
        ...(section.lines ?? []),
      ]);
      expect(values.every((value) => value.trim() !== '' && !/undefined|NaN|null/.test(value)), entry.id).toBe(true);
    }
  });
});

describe('small helpers', () => {
  it('formats numbers with thousands separators', () => {
    expect(formatNumber(9607)).toBe('9,607');
    expect(formatNumber(0)).toBe('0');
  });

  it('draws markers smaller on the whole map than when zoomed in, within limits', () => {
    expect(markerScale(1)).toBe(0.5);
    expect(markerScale(0.1)).toBe(0.5);
    expect(markerScale(4)).toBeGreaterThan(markerScale(1));
    expect(markerScale(40)).toBe(1.6);
  });

  it('softens a hex colour toward white and leaves other colours alone', () => {
    expect(soften('#000000', 0.5)).toBe('rgb(128, 128, 128)');
    expect(soften('#ffffff')).toBe('rgb(255, 255, 255)');
    expect(soften('url(#hatch1)')).toBe('url(#hatch1)');
  });
});
