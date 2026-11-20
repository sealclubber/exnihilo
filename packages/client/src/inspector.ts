/**
 * The city inspector: a generated city's summary, its districts, a searchable
 * list of households, and views of one household or one building.
 */
import type { BuildingDetail, CitySummary, District, HouseholdDetail, HouseholdListItem, HouseholdNow, OccupantsNow, PackLabels, PersonNow, PersonPlan } from '@worldsim/core';
import {
  fetchBuilding,
  fetchCitySummary,
  fetchClock,
  fetchDistricts,
  fetchHousehold,
  fetchHouseholdNow,
  fetchHouseholds,
  fetchLayout,
  fetchOccupants,
  fetchPackLabels,
  fetchPath,
  fetchPersonNow,
  fetchPersonPlan,
  fetchTrips,
  postClock,
  watchClock,
} from './api.ts';
import {
  type BarSection,
  type HouseholdFilters,
  buildingKindName,
  buildingTypeName,
  describeKin,
  describeMember,
  describeRowMember,
  districtLabel,
  filterChips,
  formatNumber,
  summaryBars,
  workName,
  workplaceText,
} from './city-format.ts';
import { ClockSync, clockFace } from './clock.ts';
import { createClockBar } from './clock-bar.ts';
import { h, link } from './dom.ts';
import { activityWord, describeWhereabouts, timeline } from './life-format.ts';
import { createTownMap } from './town-map.ts';

const PAGE = 100;
const OCCUPATIONS_SHOWN = 12;
const SEARCH_DELAY = 250;

/** Which summary section sets which filter when one of its bars is clicked. */
const FILTER_OF: Partial<Record<BarSection['key'], keyof HouseholdFilters>> = {
  category: 'category',
  occupation: 'occupation',
  status: 'status',
  district: 'district',
};

export interface Inspector {
  open(settlementId: string): Promise<void>;
  close(): void;
}

export function createInspector(root: HTMLElement, onClose: () => void): Inspector {
  const title = h('h2');
  const subtitle = h('p', { class: 'subtitle' });
  const summaryBox = h('div', { class: 'column summary' });
  const listHeading = h('h3');
  const search = h('input', { attrs: { type: 'search', placeholder: 'Search by family or personal name', 'aria-label': 'Search households' } });
  const chipBox = h('div', { class: 'chips' });
  const listBox = h('ul', { class: 'households' });
  const more = h('button', { class: 'more', attrs: { type: 'button' } }, 'Show more');
  const detailBox = h('div', { class: 'column detail' });
  const mapBox = h('div', { class: 'column town-map' });

  // The world clock: kept in step with the server's over a socket, and shown with its controls.
  const sync = new ClockSync(() => performance.now());
  const clockBar = createClockBar(sync, { change: postClock, changed: () => townMap.clockChanged() });
  const heard = (state: Parameters<ClockSync['apply']>[0]) => {
    sync.apply(state);
    clockBar.refresh();
    townMap.clockChanged();
  };
  watchClock(heard);
  void fetchClock().then(heard, () => undefined);
  void fetchPackLabels().then((known) => clockBar.setCalendar(known.calendar), () => undefined);
  /** The game time now, in whole seconds, for asking the server about this moment. */
  const gameNow = () => Math.floor(sync.now() ?? 0);

  root.replaceChildren(
    h('header', {}, h('button', { class: 'back', onClick: onClose, attrs: { type: 'button' } }, '← Map'), h('div', {}, title, subtitle), clockBar.element),
    h(
      'div',
      { class: 'columns' },
      summaryBox,
      mapBox,
      h('div', { class: 'column list' }, listHeading, search, chipBox, listBox, more),
      detailBox,
    ),
  );

  let settlementId = '';
  let labels: PackLabels;
  let districts: District[] = [];
  let filters: HouseholdFilters = {};
  let shown: HouseholdListItem[] = [];
  let total = 0;
  let selected: string | undefined;
  let allOccupations = false;
  let summary: CitySummary;
  /** Counts requests so that a slow answer to an old question is dropped. */
  let listRequest = 0;
  let detailRequest = 0;

  const hint = (text: string, kind = 'hint') => h('p', { class: kind }, text);
  // Clicking a lot shows its building; choosing a household or building shows its lot.
  const townMap = createTownMap(mapBox, {
    onLotClick: (lot) => void showBuilding(lot.buildingId),
    findPath: (from, to) => fetchPath(settlementId, from, to),
    now: () => sync.now(),
    rate: () => sync.current?.rate ?? 1,
    isLight: (time) => (labels ? clockFace(time, labels.calendar).isLight : true),
    loadTrips: async (from, to, region) => (await fetchTrips(settlementId, from, to, region)).trips,
    onPersonClick: (personId) => void showPerson(personId),
  });
  /** A moment in words, for saying when an answer was true. */
  const asOf = (time: number) => {
    const shown = clockFace(time, labels.calendar);
    return `${shown.dayName} ${shown.time}`;
  };
  const districtName = (id: string) => districts.find((district) => district.id === id)?.name ?? id;
  const tierName = (id: string) => labels.statusTiers.find((tier) => tier.id === id)?.name ?? id;

  function setFilter(key: keyof HouseholdFilters, value: string | undefined): void {
    filters = { ...filters };
    if (value === undefined || filters[key] === value) delete filters[key];
    else filters[key] = value;
    renderSummary();
    void loadHouseholds(false);
  }

  function renderSummary(): void {
    const totals = h(
      'dl',
      { class: 'totals' },
      ...(
        [
          ['Residents', summary.population],
          ['Households', summary.households],
          ['Buildings', summary.buildings],
          ['Districts', summary.districts],
        ] as const
      ).flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, formatNumber(value))]),
    );
    const sections = summaryBars(summary, districts, labels).map((section) => {
      const filterKey = FILTER_OF[section.key];
      const limited = section.key === 'occupation' && !allOccupations;
      const bars = limited ? section.bars.slice(0, OCCUPATIONS_SHOWN) : section.bars;
      const rows = bars.map((bar) => {
        const active = filterKey !== undefined && bar.id !== undefined && filters[filterKey] === bar.id;
        const label = filterKey && bar.id !== undefined
          ? link(bar.label, () => setFilter(filterKey, bar.id), 'Show the households this covers')
          : h('span', {}, bar.label);
        return h(
          'li',
          { class: active ? 'bar active' : 'bar' },
          h('div', { class: 'bar-text' }, label, h('span', { class: 'bar-value' }, formatNumber(bar.value), bar.note ? h('small', {}, ` ${bar.note}`) : undefined)),
          h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', attrs: { style: `width: ${(Math.min(bar.length, 1) * 100).toFixed(2)}%` } })),
        );
      });
      const toggle =
        section.key === 'occupation' && section.bars.length > OCCUPATIONS_SHOWN
          ? link(allOccupations ? 'Show fewer' : `Show all ${section.bars.length}`, () => {
              allOccupations = !allOccupations;
              renderSummary();
            })
          : undefined;
      return h('section', {}, h('h3', {}, section.title), h('ul', { class: 'bars' }, ...rows), toggle);
    });
    const scroll = summaryBox.scrollTop;
    summaryBox.replaceChildren(
      totals,
      ...sections,
      hint(`Generator version ${summary.generatorVersion}, pack ${summary.pack.name} ${summary.pack.version}, seed ${summary.seed}`),
    );
    summaryBox.scrollTop = scroll;
  }

  function renderList(): void {
    listHeading.textContent = `Households (${formatNumber(total)})`;
    chipBox.replaceChildren(
      ...filterChips(filters, districts, labels).map((chip) =>
        h('button', { class: 'chip', title: 'Remove this filter', onClick: () => setFilter(chip.key, undefined), attrs: { type: 'button' } }, `${chip.text} ×`),
      ),
    );
    listBox.replaceChildren(
      ...shown.map((household) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: household.id === selected ? 'household selected' : 'household',
              onClick: () => void showHousehold(household.id),
              attrs: { type: 'button' },
            },
            h('strong', {}, household.familyName),
            h('span', {}, `${household.size} ${household.size === 1 ? 'member' : 'members'} · ${tierName(household.statusTier)}`),
            h('span', {}, describeRowMember(household.member, labels)),
            h('span', { class: 'muted' }, districtName(household.districtId)),
          ),
        ),
      ),
    );
    if (shown.length === 0) listBox.append(h('li', {}, hint('No households match.')));
    more.hidden = shown.length >= total;
    more.textContent = `Show more (${formatNumber(total - shown.length)} left)`;
  }

  async function loadHouseholds(append: boolean): Promise<void> {
    const request = ++listRequest;
    try {
      const page = await fetchHouseholds(settlementId, filters, append ? shown.length : 0, PAGE);
      if (request !== listRequest) return;
      shown = append ? [...shown, ...page.items] : page.items;
      total = page.total;
      renderList();
      if (!append && listBox.parentElement) listBox.parentElement.scrollTop = 0;
    } catch (error) {
      if (request === listRequest) listBox.replaceChildren(h('li', {}, hint((error as Error).message, 'error')));
    }
  }

  /** A table of people who work somewhere, each with a way to their own household. */
  const workersTable = (workers: BuildingDetail['workers']) =>
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...['Name', 'Age', 'Occupation', 'Household'].map((heading) => h('th', {}, heading)))),
      h(
        'tbody',
        {},
        ...workers.map((person) =>
          h(
            'tr',
            {},
            h('td', {}, `${person.givenName} ${person.familyName}`),
            h('td', { class: 'number' }, String(person.age)),
            h('td', {}, workName(person, labels)),
            h('td', {}, link('Open', () => void showHousehold(person.householdId), 'Show this person\'s household')),
          ),
        ),
      ),
    );

  function renderHousehold(detail: HouseholdDetail, now?: HouseholdNow): void {
    const { household, members, dwelling, district, staff } = detail;
    const doing = new Map((now?.members ?? []).map((member) => [member.personId, member]));
    const rows = members.map((person) => {
      const text = describeMember(person, labels);
      const employer = person.workplaceId === undefined ? undefined : detail.workplaces[person.workplaceId]?.employer;
      // Work done in an employer's home leads to that household; other work leads to the building.
      const workplace =
        person.workplaceId === undefined
          ? ''
          : employer
            ? link(workplaceText(person, detail, labels), () => void showHousehold(employer.householdId), 'Show the household that employs them')
            : link(workplaceText(person, detail, labels), () => void showBuilding(person.workplaceId as string), 'Show who works there');
      return h(
        'tr',
        {},
        h('td', {}, text.name),
        h('td', { class: 'number' }, text.age),
        h('td', {}, text.sex),
        h('td', {}, text.role, h('small', {}, describeKin(person, members))),
        h('td', {}, text.work),
        h('td', {}, workplace),
        h('td', {}, link(doing.has(person.id) ? activityWord(doing.get(person.id)!.kind) : 'Open', () => void showPerson(person.id), 'Show this person\'s day')),
      );
    });
    detailBox.replaceChildren(
      h('h2', {}, `${household.familyName} household`),
      h('p', { class: 'subtitle' }, `${tierName(household.statusTier)} · ${members.length} ${members.length === 1 ? 'member' : 'members'} · ${household.id}`),
      h('h3', {}, 'Home'),
      h('p', {}, link(buildingTypeName(dwelling.type, labels), () => void showBuilding(dwelling.id), 'Show this building'), ` in ${districtLabel(district, labels)}`),
      h('h3', {}, 'Members'),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['Name', 'Age', 'Sex', 'Role and kin', 'Occupation', 'Workplace', now ? `Now (${asOf(now.time)})` : 'Now'].map((heading) => h('th', {}, heading)))),
        h('tbody', {}, ...rows),
      ),
      ...(staff.length > 0 ? [h('h3', {}, `People who work in this home (${staff.length})`), workersTable(staff)] : []),
    );
    detailBox.scrollTop = 0;
  }

  function renderBuilding(detail: BuildingDetail, now?: OccupantsNow): void {
    const { building, district, workers, households } = detail;
    const inside = now
      ? [
          h('h3', {}, `Inside now (${now.occupants.length}), ${asOf(now.time)}`),
          now.occupants.length === 0
            ? hint('Nobody is inside.')
            : h(
                'table',
                {},
                h('thead', {}, h('tr', {}, ...['Name', 'Age', 'Doing', 'Day'].map((heading) => h('th', {}, heading)))),
                h(
                  'tbody',
                  {},
                  ...now.occupants.map((occupant) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, `${occupant.person.givenName} ${occupant.person.familyName}`),
                      h('td', { class: 'number' }, String(occupant.person.age)),
                      h('td', {}, occupant.kind === 'visit' ? (labels.visits[occupant.visitId ?? ''] ?? 'Visiting') : activityWord(occupant.kind)),
                      h('td', {}, link('Open', () => void showPerson(occupant.personId), 'Show this person\'s day')),
                    ),
                  ),
                ),
              ),
        ]
      : [];
    detailBox.replaceChildren(
      h('h2', {}, buildingTypeName(building.type, labels)),
      h('p', { class: 'subtitle' }, `${buildingKindName(building.kind)} · ${districtLabel(district, labels)} · ${building.id}`),
      ...inside,
      h('h3', {}, `People working here (${workers.length})`),
      workers.length === 0 ? hint('Nobody works here.') : workersTable(workers),
      h('h3', {}, `Households living here (${households.length})`),
      households.length === 0
        ? hint('Nobody lives here.')
        : h(
            'ul',
            {},
            ...households.map((household) =>
              h('li', {}, link(`${household.familyName} household`, () => void showHousehold(household.id)), ` · ${household.size} ${household.size === 1 ? 'member' : 'members'} · ${tierName(household.statusTier)}`),
            ),
          ),
    );
    detailBox.scrollTop = 0;
  }

  async function showDetail<T>(load: () => Promise<T>, render: (detail: T) => void): Promise<void> {
    const request = ++detailRequest;
    try {
      const detail = await load();
      if (request === detailRequest) render(detail);
    } catch (error) {
      if (request === detailRequest) detailBox.replaceChildren(hint((error as Error).message, 'error'));
    }
  }

  async function showHousehold(id: string): Promise<void> {
    selected = id;
    renderList();
    townMap.follow(undefined);
    // What each member is doing now comes with the household; if it cannot be had, the household is shown without.
    const time = gameNow();
    await showDetail(
      async () => [await fetchHousehold(settlementId, id), await fetchHouseholdNow(settlementId, id, time).catch(() => undefined)] as const,
      ([detail, now]) => {
        townMap.highlight(detail.dwelling.id);
        renderHousehold(detail, now);
      },
    );
  }

  async function showBuilding(id: string): Promise<void> {
    townMap.follow(undefined);
    const time = gameNow();
    await showDetail(
      async () => [await fetchBuilding(settlementId, id), await fetchOccupants(settlementId, id, time).catch(() => undefined)] as const,
      ([detail, now]) => {
        townMap.highlight(detail.building.id);
        renderBuilding(detail, now);
      },
    );
  }

  /** A person: who they are, what they are doing now, and their day as a timeline. */
  function renderPerson(now: PersonNow, plan: PersonPlan): void {
    const { person, whereabouts, time } = now;
    const buildings = { ...plan.buildings, ...now.buildings };
    const home = plan.plan.activities.find((activity) => activity.kind === 'sleep' || activity.kind === 'home');
    const homeId = home && home.kind !== 'travel' ? home.buildingId : undefined;
    const follow = h('input', { attrs: { type: 'checkbox', id: 'follow-person' } });
    follow.addEventListener('change', () => {
      townMap.follow(follow.checked ? { personId: person.id, ...(whereabouts.kind !== 'travel' && { buildingId: whereabouts.buildingId }) } : undefined);
    });
    const where = whereabouts.kind === 'travel' ? undefined : whereabouts.buildingId;
    townMap.highlight(where);
    detailBox.replaceChildren(
      h('h2', {}, `${person.givenName} ${person.familyName}`),
      h('p', { class: 'subtitle' }, `${person.age} · ${person.sex === 'female' ? 'Female' : 'Male'}${person.occupationId ? ` · ${workName(person, labels)}` : ''} · ${person.id}`),
      h('p', {}, link('Their household', () => void showHousehold(person.householdId)), person.workplaceId ? ' · ' : '', person.workplaceId ? link('Their workplace', () => void showBuilding(person.workplaceId as string)) : ''),
      h('h3', {}, `Now, ${asOf(time)}`),
      h('p', {}, describeWhereabouts(whereabouts, buildings, labels, homeId), where ? ' · ' : '', where ? link('Show the building', () => void showBuilding(where)) : ''),
      h('p', {}, h('label', { attrs: { for: 'follow-person' } }, follow, ' Follow on the map')),
      h('h3', {}, 'Today\'s plan'),
      h(
        'table',
        { class: 'timeline' },
        h(
          'tbody',
          {},
          ...timeline(plan.plan.activities, buildings, labels, time, homeId).map((row) =>
            h('tr', { class: row.current ? `current ${row.kind}` : row.kind }, h('td', { class: 'number' }, row.time), h('td', {}, row.text)),
          ),
        ),
      ),
    );
    detailBox.scrollTop = 0;
  }

  async function showPerson(id: string): Promise<void> {
    townMap.follow(undefined);
    const time = gameNow();
    const day = Math.floor(time / 86_400) + 1;
    await showDetail(async () => [await fetchPersonNow(settlementId, id, time), await fetchPersonPlan(settlementId, id, day)] as const, ([now, plan]) => renderPerson(now, plan));
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filters = { ...filters };
      if (search.value.trim() === '') delete filters.q;
      else filters.q = search.value.trim();
      void loadHouseholds(false);
    }, SEARCH_DELAY);
  });
  more.addEventListener('click', () => void loadHouseholds(true));

  return {
    async open(id) {
      settlementId = id;
      filters = {};
      shown = [];
      total = 0;
      selected = undefined;
      allOccupations = false;
      search.value = '';
      root.hidden = false;
      title.textContent = 'Generating the city…';
      subtitle.textContent = id;
      summaryBox.replaceChildren();
      listBox.replaceChildren();
      listHeading.textContent = 'Households';
      chipBox.replaceChildren();
      more.hidden = true;
      detailBox.replaceChildren(hint('Choose a household, or click a lot on the map, to see who lives and works there.'));
      townMap.message('');
      try {
        const [packLabels, citySummary, districtPage] = await Promise.all([fetchPackLabels(), fetchCitySummary(id), fetchDistricts(id)]);
        if (settlementId !== id) return;
        labels = packLabels;
        summary = citySummary;
        districts = districtPage.items;
        title.textContent = summary.settlementName;
        subtitle.textContent = `${formatNumber(summary.population)} residents in ${formatNumber(summary.households)} households`;
        renderSummary();
        // The map loads beside the lists, not before them.
        townMap.message('Laying out the town…');
        void fetchLayout(id).then(
          (layout) => settlementId === id && townMap.show(layout, districts),
          (error: Error) => settlementId === id && townMap.message(error.message),
        );
        await loadHouseholds(false);
      } catch (error) {
        if (settlementId !== id) return;
        title.textContent = 'The city could not be opened';
        summaryBox.replaceChildren(hint((error as Error).message, 'error'));
      }
    },
    close() {
      settlementId = '';
      root.hidden = true;
    },
  };
}
