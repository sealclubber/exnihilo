/**
 * Measures people on the streets of Badanos, Pombal and Vereceldo: hour by hour, and by phase 6B's target
 * figures. Used to record the baseline before phase 6C and to repeat the measurement after it.
 *
 * Usage: node scripts/measure-streets.ts <out.json> [--outsiders]
 *
 * The six work days measured are days 1 to 6. With --outsiders the brief is given to daily life, so travellers
 * and vagrants are counted with the residents; without it the town is its residents alone.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { GENERATOR_VERSION, LAYOUT_VERSION, LIFE_VERSION, createLife, createPathFinder, createRng, generateCity, generateLayout, startOfDay } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const [out, flag] = process.argv.slice(2);
if (!out) throw new Error('Usage: node scripts/measure-streets.ts <out.json> [--outsiders]');
const withOutsiders = flag === '--outsiders';
const pack = medievalPack();
const world = lomiaWorld();
const at = (day: number, hours: number, minutes = 0) => startOfDay(day) + hours * 3600 + minutes * 60;
const WORK_DAYS = [1, 2, 3, 4, 5, 6];

const towns: Record<string, unknown> = {};
for (const name of ['Badanos', 'Pombal', 'Vereceldo']) {
  const brief = world.settlements.find((entry) => entry.name === name)!;
  const city = generateCity(brief, pack);
  const layout = generateLayout(city, brief, pack);
  const life = createLife({ city, layout, pack, ...(withOutsiders && { brief }) });
  const residents = city.people.length;
  const everyone = (day: number): string[] => {
    const ids = city.people.map((person) => person.id);
    return life.outsiders ? [...ids, ...life.outsiders.inTown(day).map((entry) => entry.id)] : ids;
  };
  const kindAt = (id: string, time: number) => life.whereabouts(id, time).kind;
  const walking = (time: number, ids: string[]) => ids.filter((id) => kindAt(id, time) === 'travel').length;
  // On the hour through day 1: walking, stopped at a point on a street, and outside at a building.
  const people = everyone(1);
  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const time = at(1, hour);
    let walkers = 0;
    let street = 0;
    let outside = 0;
    let outsiders = 0;
    for (const id of people) {
      const where = life.whereabouts(id, time);
      if (where.kind === 'away') continue;
      const seen = where.kind === 'travel' || where.kind === 'street' || where.outside === true;
      if (where.kind === 'travel') walkers++;
      else if (where.kind === 'street') street++;
      else if (where.outside) outside++;
      if (seen && where.outsider) outsiders++;
    }
    return { hour, walking: walkers, onAStreet: street, outsideAtABuilding: outside, ...(withOutsiders && { ofWhomOutsiders: outsiders }) };
  });
  const travellers = life.outsiders ? WORK_DAYS.map((day) => life.outsiders!.inTown(day).filter((entry) => entry.group === 'traveller').length) : undefined;
  const middays = WORK_DAYS.map((day) => walking(at(day, 12, 30), everyone(day)));
  const finder = createPathFinder(layout);
  const rng = createRng(100);
  const { minX, minY, maxX, maxY } = layout.summary.bounds;
  const points = Array.from({ length: 100 }, () => finder.nearestPosition([minX + rng.next() * (maxX - minX), minY + rng.next() * (maxY - minY)]).point);
  const counts = WORK_DAYS.flatMap((day) => points.map((point) => life.nearby(point, pack.avatar.perceptionRadius, at(day, 12, 30)).length)).sort((a, b) => a - b);
  const watch = city.people.filter((person) => person.occupationId === 'watchman');
  const watchByHour = Array.from({ length: 24 }, (_, hour) => watch.filter((person) => ['travel', 'street'].includes(kindAt(person.id, at(1, hour)))).length);
  const summary = life.daySummary(1);
  towns[name] = {
    settlementId: brief.id,
    residents,
    buildings: city.buildings.length,
    ...(life.outsiders && { travellersInTownOnWorkDays: travellers, vagrants: life.outsiders.vagrants().length, draw: life.outsiders.draw.total }),
    onTheStreetsByHour: byHour,
    targets: {
      walkingAt1230: { meanOfSixWorkDays: middays.reduce((sum, count) => sum + count, 0) / middays.length, byDay: middays },
      walkingAt0750: walking(at(1, 7, 50), people),
      perceivedFrom100PointsAt1230: {
        shareSeeingSomeone: counts.filter((count) => count > 0).length / counts.length,
        mean: counts.reduce((sum, count) => sum + count, 0) / counts.length,
        median: counts[Math.floor(counts.length / 2)],
      },
      watchOnTheStreetsOnTheHour: { min: watch.length === 0 ? 0 : Math.min(...watchByHour), max: watch.length === 0 ? 0 : Math.max(...watchByHour), watchmen: watch.length },
      tripsPerResident: summary.trips / residents,
      tripsBegun: summary.trips,
    },
  };
  console.log(name, JSON.stringify((towns[name] as any).targets));
}
const briefs = createHash('sha256').update(JSON.stringify(world.settlements)).digest('hex');
writeFileSync(out, `${JSON.stringify({ note: '', versions: { generator: GENERATOR_VERSION, layout: LAYOUT_VERSION, life: LIFE_VERSION, pack: pack.pack.version }, outsiders: withOutsiders, briefs, towns }, null, 2)}\n`);
