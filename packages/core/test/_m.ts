import { createLife, createPlanChecker, generateCity, generateLayout, startOfDay } from '../src/index.ts';
import { medievalPack, settlement } from './pack.ts';
const pack = medievalPack();
const brief = settlement(process.argv[2] ?? 'settlement-641');
const city = generateCity(brief, pack);
const layout = generateLayout(city, brief, pack);
const life = createLife({ city, layout, pack });
const t0 = performance.now();
life.plansForDay(1);
console.log('day 1 ms', Math.round(performance.now() - t0));
const checker = createPlanChecker({ city, layout, pack });
const problems: string[] = [];
let prev: any;
for (let day = 1; day <= 9; day++) {
  const plans = life.plansForDay(day);
  plans.forEach((p, i) => { problems.push(...checker.check(p)); if (prev) problems.push(...checker.checkContinuity(prev[i], p)); });
  prev = plans;
}
console.log('problems', problems.length, problems.slice(0, 8));
const at = (d: number, h: number, m = 0) => startOfDay(d) + h * 3600 + m * 60;
const all = (t: number) => city.people.map((p) => ({ p, w: life.whereabouts(p.id, t) }));
const show = (label: string, t: number) => {
  const ws = all(t);
  const by: Record<string, number> = {};
  for (const { w } of ws) { const k = w.kind === 'travel' ? 'walking' : (w as any).outside ? `outside:${w.kind}:${(w as any).visitId ?? ''}` : w.kind === 'visit' ? `visit:${(w as any).visitId}` : w.kind; by[k] = (by[k] ?? 0) + 1; }
  console.log(label, JSON.stringify(by));
};
show('d1 12:30', at(1, 12, 30)); show('d1 15:00', at(1, 15)); show('d1 20:30', at(1, 20, 30)); show('d2 03:00', at(2, 3)); show('d6 14:30', at(6, 14, 30)); show('d7 10:30', at(7, 10, 30)); show('d7 14:30', at(7, 14, 30));
const watch = city.people.filter((p) => p.occupationId === 'watchman');
console.log('watch', watch.length, 'at 12:30', watch.filter((p) => life.whereabouts(p.id, at(1, 12, 30)).kind === 'work').length, 'at 03:00', watch.filter((p) => life.whereabouts(p.id, at(2, 3)).kind === 'work').length);
for (const day of [1, 7]) {
  const visits: Record<string, number> = {};
  for (const plan of life.plansForDay(day)) for (const a of plan.activities) if (a.kind === 'visit' && a.start > startOfDay(day)) visits[a.visitId!] = (visits[a.visitId!] ?? 0) + 1;
  console.log('visits day', day, JSON.stringify(visits), 'trips', life.daySummary(day).trips);
}
console.log(life.daySummary(1).hours.map((h) => `${h.hour}: out ${Math.round(h.outside)} walk ${Math.round(h.travelling)} visit ${Math.round(h.visiting)}`).join(' | '));
