import { describe, expect, it } from 'vitest';
import type { CitySummary, PackLabels } from '@worldsim/core';
import { legendEntries } from '../src/legend.ts';
import { foldAllLabel, foldedLine } from '../src/pane.ts';

const labels = {
  categories: [
    { id: 'food', name: 'Food' },
    { id: 'military', name: 'Military' },
    { id: 'trade', name: 'Trade' },
  ],
  occupations: { watchman: { name: 'Watchman', category: 'military' }, tanner: { name: 'Tanner', category: 'trade' }, baker: { name: 'Baker', category: 'food' } },
  roleColours: { food: '#111111', military: '#c62828', trade: '#333333', 'keeping-house': '#444444', 'not-working': '#555555' },
} as unknown as PackLabels;
const summary = (over: Partial<Record<'food' | 'military' | 'trade', number>>, occupations: Record<string, number> = {}, keepingHouse = 5, notWorking = 7) =>
  ({ categories: { food: 3, military: 2, trade: 4, ...over }, occupations, workforce: { working: 9, keepingHouse, notWorking } }) as unknown as CitySummary;

describe('the legend', () => {
  it('lists the colour of every role that has anyone in it, in the pack\'s order', () => {
    expect(legendEntries(summary({}), labels)).toEqual([
      { role: 'food', name: 'Food', colour: '#111111' },
      { role: 'military', name: 'Military', colour: '#c62828' },
      { role: 'trade', name: 'Trade', colour: '#333333' },
      { role: 'keeping-house', name: 'Keeping house', colour: '#444444' },
      { role: 'not-working', name: 'Not working', colour: '#555555' },
    ]);
  });

  it('leaves out a role nobody is in', () => {
    const roles = legendEntries(summary({ military: 0 }, {}, 0), labels).map((entry) => entry.role);
    expect(roles).toEqual(['food', 'trade', 'not-working']);
  });

  it('lists an occupation with a colour of its own, and its category only if others are left in it', () => {
    const own = { ...labels, roleColours: { ...labels.roleColours, watchman: '#000001', tanner: '#000002', baker: '#000003' } } as PackLabels;
    // Both soldiers are watchmen, so nobody is drawn in the military colour; two of four in trade are tanners; nobody bakes.
    const entries = legendEntries(summary({}, { watchman: 2, tanner: 2 }), own);
    expect(entries.map((entry) => entry.role)).toEqual(['food', 'trade', 'watchman', 'tanner', 'keeping-house', 'not-working']);
    expect(entries.find((entry) => entry.role === 'watchman')).toEqual({ role: 'watchman', name: 'Watchman', colour: '#000001' });
  });
});

describe('panes', () => {
  it('show a folded pane as its title and a short summary', () => {
    expect(foldedLine('Around you', '4')).toBe('Around you: 4');
    expect(foldedLine('Legend', '')).toBe('Legend');
  });

  it('offer to fold everything, unless everything is folded already', () => {
    expect(foldAllLabel([false, false])).toBe('Fold all');
    expect(foldAllLabel([true, false])).toBe('Fold all');
    expect(foldAllLabel([true, true])).toBe('Unfold all');
    expect(foldAllLabel([])).toBe('Fold all');
  });
});
