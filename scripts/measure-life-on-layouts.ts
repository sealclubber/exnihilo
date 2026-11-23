/**
 * Measures daily life in Badanos on each layout generator: the "Life on the new streets" table of phase 6D.
 *
 * Usage: node scripts/measure-life-on-layouts.ts
 *
 * Day 1 and the work days 8 to 13: trips per resident, how long a trip is, who is to be seen at noon, the
 * travellers in town, how far apart wells stand, and where vagrants sleep.
 */
import { createLife, createPathFinder, generateCity, generateLayout, geometry, sleepingPlacesAt, startOfDay } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const pack = medievalPack();
const brief = lomiaWorld().settlements.find((entry) => entry.name === 'Badanos')!;
const city = generateCity(brief, pack);
const DAYS = [1, 8, 9, 10, 11, 12, 13];
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
for (const generator of ['grid', 'grown'] as const) {
  const layout = generateLayout(city, brief, pack, { generator });
  const life = createLife({ city, layout, pack, brief });
  const residents = city.people.length;
  const trips = DAYS.map((day) => life.daySummary(day).trips / residents);
  const lengths: number[] = [];
  const durations: number[] = [];
  for (const day of [1, 8]) {
    for (const person of city.people) {
      for (const activity of life.plan(person.id, day).activities) {
        if (activity.kind !== 'travel') continue;
        lengths.push(activity.path.length);
        durations.push(activity.arriveAt - activity.departAt);
      }
    }
  }
  const seen = DAYS.map((day) => {
    const time = startOfDay(day) + 12 * 3600;
    const ids = [...city.people.map((person) => person.id), ...(life.outsiders?.inTown(day).map((entry) => entry.id) ?? [])];
    return ids.filter((id) => {
      const where = life.whereabouts(id, time);
      return where.kind !== 'away' && (where.kind === 'travel' || where.kind === 'street' || where.outside === true);
    }).length;
  });
  const travellers = [1, 2, 3, 4, 5, 6].map((day) => life.outsiders!.inTown(day).filter((entry) => entry.group === 'traveller').length);
  const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
  const wells = layout.lots.filter((lot) => typeOf.get(lot.buildingId) === 'well');
  let nearest = Infinity;
  for (const one of wells) {
    for (const other of wells) {
      if (one.id >= other.id) continue;
      const away = geometry.distance(geometry.polygonCentroid(one.polygon), geometry.polygonCentroid(other.polygon));
      nearest = Math.min(nearest, away);
    }
  }
  const finder = createPathFinder(layout);
  const vagrants = life.outsiders!.vagrants();
  const night = startOfDay(2) + 3 * 3600;
  const asleep = vagrants.map((vagrant) => life.whereabouts(vagrant.id, night)).filter((where) => where.kind === 'street');
  const places = new Map<string, number>();
  for (const where of asleep) {
    const position = finder.nearestPosition((where as { point: [number, number] }).point);
    const kinds = sleepingPlacesAt(layout, position, pack.visits.streetReach ?? 0);
    const key = kinds.length === 0 ? 'none of the pack\'s places' : kinds.join('+');
    places.set(key, (places.get(key) ?? 0) + 1);
  }
  console.log(`\nBadanos on the ${generator} layout`);
  console.log(`  trips per resident: day 1 ${trips[0]!.toFixed(2)}; days 8 to 13 ${trips.slice(1).map((value) => value.toFixed(2)).join(', ')}; mean ${mean(trips).toFixed(2)}`);
  console.log(`  a trip, days 1 and 8: mean ${mean(lengths).toFixed(0)} m and ${(mean(durations) / 60).toFixed(1)} minutes, of ${lengths.length.toLocaleString('en')} trips`);
  console.log(`  to be seen at 12:00: day 1 ${seen[0]}; days 8 to 13 ${seen.slice(1).join(', ')}; mean ${mean(seen).toFixed(0)}`);
  console.log(`  travellers in town, days 1 to 6: ${travellers.join(', ')}`);
  console.log(`  wells: ${wells.length}, the nearest two ${nearest.toFixed(0)} m apart`);
  console.log(`  vagrants: ${vagrants.length}, asleep on a street at 03:00 ${asleep.length}: ${[...places].map(([kind, count]) => `${count} at ${kind}`).join(', ')}`);
}
