// Measurements of a town's day, for the before-and-after table. Usage: node _measure.ts [out.json]
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createLife, createPathFinder, createRng, generateCity, generateLayout, startOfDay } from '../src/index.ts';
import { medievalPack, settlement } from './pack.ts';
const pack = medievalPack();
const brief = settlement('settlement-641');
const city = generateCity(brief, pack);
const layout = generateLayout(city, brief, pack);
const finder = createPathFinder(layout);
const t0 = performance.now();
const life = createLife({ city, layout, pack });
life.plansForDay(1);
const planSeconds = (performance.now() - t0) / 1000;
const at = (d: number, h: number, m = 0) => startOfDay(d) + h * 3600 + m * 60;
const out: any = { planSeconds: +planSeconds.toFixed(2), residents: city.people.length, buildings: city.buildings.length, days: {} };
const rng = createRng(100);
const { minX, minY, maxX, maxY } = layout.summary.bounds;
const points = Array.from({ length: 100 }, () => finder.nearestPosition([minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)]).point);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const watch = new Set(city.people.filter((p) => p.occupationId === 'watchman').map((p) => p.id));
for (const day of [1, 7]) {
  const s = life.daySummary(day);
  const walkingAt = (t: number) => city.people.filter((p) => life.whereabouts(p.id, t).kind === 'travel').length;
  const onStreet = (t: number) => [...watch].filter((id) => { const w: any = life.whereabouts(id, t); return w.kind === 'travel' || w.kind === 'street'; }).length;
  out.days[day] = {
    planHash: createHash('sha256').update(JSON.stringify(life.plansForDay(day))).digest('hex'),
    trips: s.trips,
    tripsPerResident: +(s.trips / city.people.length).toFixed(3),
    walkingByHour: s.hours.map((h) => +h.travelling.toFixed(1)),
    walkingAt0750: walkingAt(at(day, 7, 50)),
    walkingAt1230: walkingAt(at(day, 12, 30)),
    medianPerceivedAt1230: median(points.map((p) => life.nearby(p, pack.avatar.perceptionRadius, at(day, 12, 30)).length)),
    meanPerceivedAt1230: +(points.reduce((sum, p) => sum + life.nearby(p, pack.avatar.perceptionRadius, at(day, 12, 30)).length, 0) / 100).toFixed(2),
    watchOnStreetsByHour: Array.from({ length: 24 }, (_, h) => onStreet(at(day, h))),
    busiestSegments: life.segmentLoads(day).slice(0, 10),
  };
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const [day, d] of Object.entries<any>(out.days)) console.log(day, d.planHash.slice(0, 12), 'trips', d.trips, d.tripsPerResident, '07:50', d.walkingAt0750, '12:30', d.walkingAt1230, 'median', d.medianPerceivedAt1230, 'mean', d.meanPerceivedAt1230, 'watch', d.watchOnStreetsByHour.join(','), '\n  walking', d.walkingByHour.join(' '));
console.log('plan s', out.planSeconds, 'buildings', out.buildings);
