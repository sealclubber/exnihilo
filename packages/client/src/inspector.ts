/**
 * The city inspector: a generated city's summary, its districts, a searchable
 * list of households, views of one household, one building, one resident or
 * one outsider, and the outsiders in town that day.
 */
import type { Activity, AvatarPerception, AvatarState, BuildingDetail, BuildingTypes, CitySummary, District, HouseholdDetail, HouseholdListItem, HouseholdNow, Layout, OccupantsNow, OutsiderDetail, OutsidersToday, PackLabels, PersonNow, PersonPlan, Whereabouts } from '@worldsim/core';
import {
  fetchBuilding,
  fetchBuildingTypes,
  fetchCitySummary,
  fetchClock,
  fetchDistricts,
  fetchHousehold,
  fetchHouseholdNow,
  fetchHouseholds,
  fetchLayout,
  fetchAvatar,
  fetchOccupants,
  fetchOutsider,
  fetchOutsiders,
  fetchPerception,
  postAvatar,
  watchAvatar,
  type AvatarAction,
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
  buildingName,
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
import { createAroundYou } from './around-you.ts';
import { legendEntries, outsiderLegendEntries, renderLegend } from './legend.ts';
import { byRoute, describeOutsider, describeRouteEnd, isOutsider, kindName, outsiderGroups, relativeDay, routeEndName, seenLabel } from './outsider-format.ts';
import { createFoldAll, createPane } from './pane.ts';
import { activityWord, describeHours, describeWhereabouts, timeline } from './life-format.ts';
import { layoutFacts } from './town-format.ts';
import { createTownMap } from './town-map.ts';

const PAGE = 100;
const OCCUPATIONS_SHOWN = 12;
const SEARCH_DELAY = 250;
/** How often the viewer asks who the avatar perceives, in real milliseconds. */
const PERCEIVE_EVERY = 1000;

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
  const summaryBox = h('div', { class: 'summary' });
  const listHeading = h('h3');
  const search = h('input', { attrs: { type: 'search', placeholder: 'Search by family or personal name', 'aria-label': 'Search households' } });
  const chipBox = h('div', { class: 'chips' });
  const listBox = h('ul', { class: 'households' });
  const more = h('button', { class: 'more', attrs: { type: 'button' } }, 'Show more');
  const detailBox = h('div', { class: 'detail' });
  const mapBox = h('div', { class: 'town-map' });
  const listBody = h('div', { class: 'list' }, listHeading, search, chipBox, listBox, more);
  const legendBody = h('div', { class: 'legend' });
  // Every pane folds away to one line from its header, and the map takes the room.
  const summaryPane = createPane('summary', 'Summary', summaryBox, 'column');
  const listPane = createPane('households', 'Households', listBody, 'column');
  const detailPane = createPane('detail', 'Details', detailBox, 'column');
  const legendPane = createPane('legend', 'Legend', legendBody, 'over-map legend-pane');
  const inTownBody = h('div', { class: 'in-town' });
  const inTownPane = createPane('in-town', 'In town today', inTownBody, 'over-map in-town-pane');
  /** What the detail pane is showing, for its title and its one line when folded. */
  const detailShows = (kind: string, what: string) => {
    detailPane.setTitle(kind);
    detailPane.setSummary(what);
  };

  // The world clock: kept in step with the server's over a socket, and shown with its controls.
  const sync = new ClockSync(() => performance.now());
  const clockBar = createClockBar(sync, {
    change: postClock,
    changed: () => townMap.clockChanged(),
    shown: (face) => {
      clockPane.setSummary(face);
      // The face changes when the day does, among other times.
      loadInTown();
    },
  });
  const clockPane = createPane('clock', 'Clock', clockBar.element, 'inline');
  const heard = (state: Parameters<ClockSync['apply']>[0]) => {
    sync.apply(state);
    clockBar.refresh();
    townMap.clockChanged();
    perceive();
    loadInTown();
  };
  watchClock(heard);
  void fetchClock().then(heard, () => undefined);
  void fetchPackLabels().then((known) => clockBar.setCalendar(known.calendar), () => undefined);
  /** The game time now, in whole seconds, for asking the server about this moment. */
  const gameNow = () => Math.floor(sync.now() ?? 0);

  root.replaceChildren(
    h('header', {}, h('button', { class: 'back', onClick: onClose, attrs: { type: 'button' } }, '← Map'), h('div', {}, title, subtitle), clockPane.element, createFoldAll()),
    h('div', { class: 'columns' }, summaryPane.element, mapBox, listPane.element, detailPane.element),
  );

  let settlementId = '';
  let labels: PackLabels;
  /** The type of each building of the town on show, for naming the lot under the cursor. */
  let buildingTypes: BuildingTypes = {};
  let districts: District[] = [];
  let filters: HouseholdFilters = {};
  let shown: HouseholdListItem[] = [];
  let total = 0;
  let selected: string | undefined;
  let allOccupations = false;
  let summary: CitySummary;
  /** The layout on the map, once it has come. */
  let layout: Layout | undefined;
  /**
   * A generator named in the page's address, as ?generator=grid: the town is then shown as that generator lays it
   * out, for comparison. The residents walk the pack's layout, not that one, so the people are left off the map.
   */
  const comparing = new URLSearchParams(location.search).get('generator') ?? undefined;
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
    loadTrips: (from, to, region) => fetchTrips(settlementId, from, to, region),
    onPersonClick: (personId, outsider) => void showAnyone(personId, outsider),
    onSpawn: (point) => act('spawn', { settlementId, point }),
    onWalkToPoint: (point) => act('walk-to-point', { point }),
    onWalkToBuilding: (buildingId) => act('walk-to-building', { buildingId }),
    onUnfollowAvatar: () => aroundYou.unfollow(),
    roleColour: (role) => labels?.roleColours[role],
    personLabel: (person) => (labels ? seenLabel(person, labels) : person.name),
    lotLabel: (lot) => {
      const building = buildingTypes[lot.buildingId];
      return building === undefined || !labels ? lot.buildingId : buildingName(building, labels);
    },
    onHover: (personId) => showHovered(personId),
  });
  // For tests and for measuring: what the map last drew. Reading it changes nothing.
  Object.assign(window, { worldsim: { map: () => townMap.drawn() } });
  /** Shows, in the lists, who the cursor is on in the map. */
  const showHovered = (personId: string | undefined) => {
    for (const row of root.querySelectorAll('[data-person].hovered')) row.classList.remove('hovered');
    if (personId !== undefined) for (const row of root.querySelectorAll(`[data-person="${personId}"]`)) row.classList.add('hovered');
  };

  // ---- The avatar -----------------------------------------------------------------------
  // The server keeps the avatar's state and says who it perceives. The viewer is sent the state,
  // moves the avatar along its trip by the clock, and asks about once a second who is around.
  let avatar: AvatarState | undefined;
  let perception: AvatarPerception | undefined;
  let perceiving = false;
  const avatarHere = () => (avatar !== undefined && avatar.settlementId === settlementId ? avatar : undefined);
  /** The avatar as the map may draw it: not at all on a layout shown for comparison, which is not the one it stands on. */
  const avatarOnMap = () => (comparing === undefined ? avatarHere() : undefined);
  const aroundYou = createAroundYou({
    onStop: () => act('stop'),
    onLeave: () => act('leave'),
    onFollow: (on) => townMap.followAvatar(on),
    onPerson: (personId, outsider) => void showAnyone(personId, outsider),
    onBuilding: (buildingId) => void showBuilding(buildingId),
    onHover: (personId) => townMap.mark(personId),
  });
  const aroundPane = createPane('around', 'Around you', aroundYou.element, 'over-map around-pane');
  /** Asks the server for one of the avatar's actions, and shows its reason if it refuses. */
  function act(action: AvatarAction, body: object = {}): void {
    aroundYou.note('');
    postAvatar(action, body).then(
      (report) => heardAvatar(report.avatar ?? undefined),
      (error: Error) => aroundYou.note(error.message),
    );
  }
  const showAvatar = () => {
    if (!labels) return;
    const here = avatarHere();
    const onMap = avatarOnMap();
    townMap.setAvatar(onMap ? { state: onMap, radius: labels.avatar.perceptionRadius } : undefined);
    const seen = onMap && perception?.settlementId === settlementId ? perception : undefined;
    townMap.setPerceived(new Set(seen ? (seen.where === 'street' ? seen.nearby.map((entry) => entry.personId) : seen.occupants.map((occupant) => occupant.personId)) : []));
    aroundYou.render(avatar, here !== undefined, sync.now() ?? 0, seen, labels);
    aroundPane.setSummary(aroundYou.count());
  };
  /** Asks who the avatar perceives now. Called about once a real second, and whenever the avatar or the clock changes. */
  function perceive(): void {
    if (root.hidden || !avatarOnMap() || perceiving) return showAvatar();
    perceiving = true;
    fetchPerception()
      .then((seen) => (perception = seen), () => (perception = undefined))
      .finally(() => {
        perceiving = false;
        showAvatar();
      });
  }
  function heardAvatar(state: AvatarState | undefined): void {
    avatar = state;
    perception = undefined;
    showAvatar();
    perceive();
  }
  watchAvatar((report) => heardAvatar(report.avatar ?? undefined));
  void fetchAvatar().then((report) => heardAvatar(report.avatar ?? undefined), () => undefined);
  setInterval(perceive, PERCEIVE_EVERY);
  // The legend and the day's outsiders stand one above the other at the map's left; who is around, at its right.
  mapBox.append(h('div', { class: 'over-map-stack' }, legendPane.element, inTownPane.element), aroundPane.element);
  /** A moment in words, for saying when an answer was true. */
  const asOf = (time: number) => {
    const shown = clockFace(time, labels.calendar);
    return `${shown.dayName} ${shown.time}`;
  };
  const districtName = (id: string) => districts.find((district) => district.id === id)?.name ?? id;
  const tierName = (id: string) => labels.statusTiers.find((tier) => tier.id === id)?.name ?? id;

  /** A list row for one person, such as the member a household's row shows: hovering it marks that person on the map, if they can be seen. */
  const hoverable = (personId: string, ...children: Array<HTMLElement | string>) => {
    const row = h('li', { attrs: { 'data-person': personId } }, ...children);
    row.addEventListener('mouseenter', () => townMap.mark(personId));
    row.addEventListener('mouseleave', () => townMap.mark(undefined));
    return row;
  };

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
    // The town as laid out: who laid it out, and its wall and plaza where it has them.
    const laidOut = layout
      ? h(
          'section',
          { class: 'layout-facts' },
          h('h3', {}, 'Town'),
          h('dl', { class: 'totals' }, ...layoutFacts(layout).flatMap((fact) => [h('dt', {}, fact.label), h('dd', { attrs: { 'data-fact': fact.key } }, fact.value)])),
          comparing !== undefined ? h('p', { class: 'hint layout-note' }, `Shown as the ${layout.summary.generator} generator lays this town out, for comparison. People are not shown on it: they walk the pack's layout.`) : undefined,
        )
      : undefined;
    const scroll = summaryBox.scrollTop;
    summaryBox.replaceChildren(
      totals,
      ...(laidOut ? [laidOut] : []),
      ...sections,
      hint(`Generator version ${summary.generatorVersion}, pack ${summary.pack.name} ${summary.pack.version}, seed ${summary.seed}`),
    );
    summaryBox.scrollTop = scroll;
  }

  function renderList(): void {
    listHeading.textContent = `Households (${formatNumber(total)})`;
    listPane.setSummary(formatNumber(total));
    chipBox.replaceChildren(
      ...filterChips(filters, districts, labels).map((chip) =>
        h('button', { class: 'chip', title: 'Remove this filter', onClick: () => setFilter(chip.key, undefined), attrs: { type: 'button' } }, `${chip.text} ×`),
      ),
    );
    listBox.replaceChildren(
      ...shown.map((household) =>
        hoverable(
          household.member.id,
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
    detailShows('Household', household.familyName);
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
      h('p', {}, link(buildingName(dwelling, labels), () => void showBuilding(dwelling.id), 'Show this building'), ` in ${districtLabel(district, labels)}`),
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
    detailShows('Building', buildingName(building, labels));
    const inside = now
      ? [
          // Hours are worth showing for a place someone works at or that never closes, not for a plain dwelling.
          ...(workers.length > 0 || now.open ? [h('p', { class: now.open ? 'hours open' : 'hours closed' }, describeHours(now.open, now.hours))] : []),
          h('h3', {}, `Here now (${now.occupants.length}), ${asOf(now.time)}`),
          now.occupants.length === 0
            ? hint('Nobody is here.')
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
                      // A traveller awake at an inn is at their lodging, not at home.
                      h('td', {}, `${occupant.kind === 'visit' ? (labels.visits[occupant.visitId ?? ''] ?? 'Visiting') : activityWord(occupant.kind, isOutsider(occupant.person))}${occupant.outside ? ' (outside)' : ''}`),
                      h('td', {}, link('Open', () => void showAnyone(occupant.personId, isOutsider(occupant.person)), 'Show this person\'s day')),
                    ),
                  ),
                ),
              ),
          // An inn, or anywhere else travellers lodge, lists its guests of the day, in or out.
          ...(now.guests.length > 0
            ? [
                h('h3', {}, `Guests lodging here today (${now.guests.length})`),
                h(
                  'ul',
                  { class: 'guests' },
                  ...now.guests.map((guest) =>
                    hoverable(guest.id, link(`${guest.givenName} ${guest.familyName}`, () => void showOutsider(guest.id), 'Show this guest\'s day'), ` · ${guest.age} · ${describeOutsider(guest, labels)}`),
                  ),
                ),
              ]
            : []),
        ]
      : [];
    const workersSection = [
      h('h3', {}, `People working here (${workers.length})`),
      workers.length === 0 ? hint('Nobody works here.') : workersTable(workers),
    ];
    const householdsSection = [
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
    ];
    detailBox.replaceChildren(
      h('h2', {}, buildingName(building, labels)),
      h('p', { class: 'subtitle' }, `${buildingKindName(building.kind)} · ${districtLabel(district, labels)} · ${building.id}`),
      ...(avatarHere() ? [h('p', { class: 'avatar-actions' }, h('button', { attrs: { type: 'button' }, title: 'Walk your avatar into this building', onClick: () => act('walk-to-building', { buildingId: building.id }) }, 'Walk here'))] : []),
      ...inside,
      // A home that is also a workplace lists the household that lives there first, as plainly as those who work there.
      ...(building.kind === 'both' ? [...householdsSection, ...workersSection] : [...workersSection, ...householdsSection]),
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

  /** The building someone is at, if they are at one and not on a street or out of town. */
  const buildingOf = (where: Whereabouts) => (where.kind === 'travel' || where.kind === 'street' || where.kind === 'away' ? undefined : where.buildingId);

  /**
   * What someone is doing now, with the ways to follow them and to walk the avatar to them: the part of a panel a
   * resident and an outsider share. `lodger` is whether they are a traveller, whose rest is at a lodging.
   */
  function nowSection(personId: string, whereabouts: Whereabouts, time: number, buildings: Record<string, string>, homeId: string | undefined, lodger: boolean, walks: Array<HTMLElement | string> = []): HTMLElement[] {
    const where = buildingOf(whereabouts);
    const follow = h('input', { attrs: { type: 'checkbox', id: 'follow-person' } });
    follow.addEventListener('change', () => {
      townMap.follow(follow.checked ? { personId, ...(where !== undefined && { buildingId: where }) } : undefined);
    });
    townMap.highlight(where);
    const walkToThem = () => {
      if (whereabouts.kind === 'travel' || whereabouts.kind === 'street') act('walk-to-point', { point: whereabouts.point });
      else if (whereabouts.kind !== 'away') act('walk-to-building', { buildingId: whereabouts.buildingId });
    };
    return [
      h('h3', {}, `Now, ${asOf(time)}`),
      h('p', { class: 'whereabouts' }, describeWhereabouts(whereabouts, buildings, labels, homeId, lodger), where ? ' · ' : '', where ? link('Show the building', () => void showBuilding(where)) : ''),
      h('p', {}, h('label', { attrs: { for: 'follow-person' } }, follow, ' Follow on the map')),
      ...(avatarHere()
        ? [
            h(
              'p',
              { class: 'avatar-actions' },
              // Nobody can be walked to who is not in town.
              whereabouts.kind !== 'away' ? h('button', { attrs: { type: 'button' }, title: 'Walk your avatar to where this person is now', onClick: walkToThem }, 'Walk to them') : '',
              ...walks,
            ),
          ]
        : []),
    ];
  }

  /** A day's plan as a timeline, marking what is under way; a traveller's plan is empty on a day they are not in town. */
  function planSection(activities: Activity[], time: number, buildings: Record<string, string>, homeId: string | undefined, lodger: boolean): HTMLElement[] {
    return [
      h('h3', {}, 'Today\'s plan'),
      activities.length === 0
        ? hint('Not in town today.')
        : h(
            'table',
            { class: 'timeline' },
            h(
              'tbody',
              {},
              ...timeline(activities, buildings, labels, time, homeId, lodger).map((row) =>
                h('tr', { class: row.current ? `current ${row.kind}` : row.kind }, h('td', { class: 'number' }, row.time), h('td', {}, row.text)),
              ),
            ),
          ),
    ];
  }

  /** A resident: who they are, what they are doing now, and their day as a timeline. */
  function renderPerson(now: PersonNow, plan: PersonPlan): void {
    const { person, whereabouts, time } = now;
    // An outsider has a panel of their own; this one is for someone with a household.
    if (isOutsider(person)) return void showOutsider(person.id);
    detailShows('Person', `${person.givenName} ${person.familyName}`);
    const buildings = { ...plan.buildings, ...now.buildings };
    const home = plan.plan.activities.find((activity) => activity.kind === 'sleep' || activity.kind === 'home');
    const homeId = home && home.kind !== 'travel' && home.kind !== 'street' ? home.buildingId : undefined;
    const workplaceId = person.workplaceId;
    detailBox.replaceChildren(
      h('h2', {}, `${person.givenName} ${person.familyName}`),
      h('p', { class: 'subtitle' }, `${person.age} · ${person.sex === 'female' ? 'Female' : 'Male'}${person.occupationId ? ` · ${workName(person, labels)}` : ''} · ${person.id}`),
      h('p', {}, link('Their household', () => void showHousehold(person.householdId)), workplaceId ? ' · ' : '', workplaceId ? link('Their workplace', () => void showBuilding(workplaceId)) : ''),
      ...nowSection(person.id, whereabouts, time, buildings, homeId, false, [
        homeId !== undefined ? h('button', { attrs: { type: 'button' }, onClick: () => act('walk-to-building', { buildingId: homeId }) }, 'Walk to their home') : '',
        workplaceId !== undefined ? h('button', { attrs: { type: 'button' }, onClick: () => act('walk-to-building', { buildingId: workplaceId }) }, 'Walk to their workplace') : '',
      ]),
      ...planSection(plan.plan.activities, time, buildings, homeId, false),
    );
    detailBox.scrollTop = 0;
  }

  async function showPerson(id: string): Promise<void> {
    townMap.follow(undefined);
    const time = gameNow();
    const day = Math.floor(time / 86_400) + 1;
    await showDetail(async () => [await fetchPersonNow(settlementId, id, time), await fetchPersonPlan(settlementId, id, day)] as const, ([now, plan]) => renderPerson(now, plan));
  }

  /**
   * An outsider: their kind, their party, where they came from and go on to, when they arrived and when they
   * leave, where they lodge, what they are doing now, and their day as the timeline a resident has.
   */
  function renderOutsider(detail: OutsiderDetail): void {
    const { outsider, companions = [], whereabouts, plan, buildings, time } = detail;
    const name = `${outsider.givenName} ${outsider.familyName}`;
    detailShows(kindName(outsider.group === 'traveller' ? outsider.kindId : undefined, labels), name);
    const others = companions.filter((companion) => companion.id !== outsider.id);
    /** A moment that may be on another day: how far that day is from this one, its name and the time. */
    const when = (moment: number) => `${relativeDay(Math.floor(moment / 86_400), Math.floor(time / 86_400))}, ${asOf(moment)}`;
    const lodgingId = outsider.group === 'traveller' ? outsider.lodgingId : undefined;
    const lodgingType = lodgingId === undefined ? undefined : buildings[lodgingId];
    const visit =
      outsider.group === 'traveller'
        ? [
            h('h3', {}, others.length === 0 ? 'Party' : `Party (${companions.length})`),
            others.length === 0
              ? h('p', { class: 'party' }, 'Travelling alone.')
              : h('ul', { class: 'party' }, ...others.map((companion) => hoverable(companion.id, link(`${companion.givenName} ${companion.familyName}`, () => void showOutsider(companion.id), 'Show this companion\'s day'), ` · ${companion.age}`))),
            h('h3', {}, 'Visit'),
            h(
              'dl',
              { class: 'visit' },
              h('dt', {}, 'From'),
              h('dd', { attrs: { 'data-field': 'origin' } }, describeRouteEnd(outsider.origin)),
              h('dt', {}, 'Arrived'),
              h('dd', { attrs: { 'data-field': 'arrival' } }, `${when(outsider.arrival.time)}, ${byRoute(outsider.origin)}`),
              h('dt', {}, 'Leaves'),
              h('dd', { attrs: { 'data-field': 'departure' } }, `${when(outsider.departure.time)}, ${byRoute(outsider.destination)}`),
              h('dt', {}, 'Going on to'),
              h('dd', { attrs: { 'data-field': 'destination' } }, describeRouteEnd(outsider.destination)),
              h('dt', {}, 'Lodging'),
              h(
                'dd',
                { attrs: { 'data-field': 'lodging' } },
                lodgingId === undefined ? 'None: they do not stay the night' : link(lodgingType === undefined ? lodgingId : (labels.buildingTypes[lodgingType] ?? lodgingType), () => void showBuilding(lodgingId), 'Show where they lodge'),
              ),
            ),
          ]
        : [];
    detailBox.replaceChildren(
      h('h2', {}, name),
      h('p', { class: 'subtitle', attrs: { 'data-outsider': outsider.id } }, `${outsider.age} · ${outsider.sex === 'female' ? 'Female' : 'Male'} · ${describeOutsider(outsider, labels)} · ${outsider.id}`),
      ...visit,
      ...nowSection(outsider.id, whereabouts, time, buildings, undefined, outsider.group === 'traveller', [
        lodgingId !== undefined ? h('button', { attrs: { type: 'button' }, onClick: () => act('walk-to-building', { buildingId: lodgingId }) }, 'Walk to their lodging') : '',
      ]),
      ...planSection(plan.activities, time, buildings, undefined, outsider.group === 'traveller'),
    );
    detailBox.scrollTop = 0;
  }

  async function showOutsider(id: string): Promise<void> {
    townMap.follow(undefined);
    await showDetail(() => fetchOutsider(settlementId, id, gameNow()), renderOutsider);
  }

  /** Shows whoever was chosen where it is known which they are: a resident or an outsider. */
  const showAnyone = (id: string, outsider: boolean) => (outsider ? showOutsider(id) : showPerson(id));

  // ---- In town today ------------------------------------------------------------------
  // The server says who the day's outsiders are. The viewer asks again when the day or the town changes, lists
  // them by kind, and adds their colours to the legend.
  let outsidersToday: OutsidersToday | undefined;
  /** The town and day the list was last asked for, so that it is asked for once. */
  let inTownAsked = '';

  /** The legend: the residents' colours in use, then those of the outsiders in town today. */
  function showLegend(): void {
    const colours = [...legendEntries(summary, labels), ...(outsidersToday ? outsiderLegendEntries(outsidersToday, labels) : [])];
    renderLegend(legendBody, colours);
    legendPane.setSummary(`${colours.length} colours`);
  }

  function renderInTown(): void {
    if (!outsidersToday) return;
    const groups = outsiderGroups(outsidersToday, labels);
    inTownPane.setSummary(formatNumber(groups.reduce((sum, group) => sum + group.count, 0)));
    inTownBody.setAttribute('data-day', String(outsidersToday.day));
    inTownBody.replaceChildren(
      ...(groups.length === 0 ? [hint('Nobody from elsewhere is in town.')] : []),
      ...groups.map((group) =>
        h(
          'section',
          { attrs: group.kindId === undefined ? { 'data-group': 'vagrant' } : { 'data-group': 'traveller', 'data-kind': group.kindId } },
          h('h4', {}, `${group.name} (${formatNumber(group.count)})`),
          h(
            'ul',
            {},
            ...group.people.map((person) =>
              hoverable(
                person.id,
                link(`${person.givenName} ${person.familyName}`, () => void showOutsider(person.id), 'Show this person\'s day'),
                person.group === 'traveller' ? h('span', { class: 'who' }, ` from ${routeEndName(person.origin)}`) : '',
              ),
            ),
          ),
        ),
      ),
    );
  }

  /** Asks who is in town on the clock's day, if that has not been asked for this town and day already. */
  function loadInTown(): void {
    const now = sync.now();
    if (root.hidden || settlementId === '' || !labels || !summary || summary.settlementId !== settlementId || now === undefined) return;
    const id = settlementId;
    const day = Math.floor(now / 86_400) + 1;
    const asked = `${id} ${day}`;
    if (asked === inTownAsked) return;
    inTownAsked = asked;
    fetchOutsiders(id, day).then(
      (today) => {
        if (asked !== inTownAsked) return;
        outsidersToday = today;
        renderInTown();
        showLegend();
      },
      (error: Error) => {
        if (asked !== inTownAsked) return;
        outsidersToday = undefined;
        inTownPane.setSummary('unknown');
        inTownBody.removeAttribute('data-day');
        inTownBody.replaceChildren(hint(error.message, 'error'));
        showLegend();
      },
    );
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
      detailShows('Details', 'nothing chosen');
      buildingTypes = {};
      layout = undefined;
      townMap.markHomesWithWork(new Set());
      legendBody.replaceChildren();
      outsidersToday = undefined;
      inTownAsked = '';
      inTownBody.removeAttribute('data-day');
      inTownBody.replaceChildren();
      inTownPane.setSummary('');
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
        summaryPane.setSummary(`${summary.settlementName}, ${formatNumber(summary.population)} residents`);
        showLegend();
        loadInTown();
        void fetchBuildingTypes(id).then(
          (types) => {
            if (settlementId !== id) return;
            buildingTypes = types;
            // Homes that are workshops are marked on the map.
            townMap.markHomesWithWork(new Set(Object.entries(types).filter(([, building]) => building.kind === 'both').map(([buildingId]) => buildingId)));
          },
          () => undefined,
        );
        // The map loads beside the lists, not before them.
        townMap.message('Laying out the town…');
        void fetchLayout(id, comparing).then(
          (made) => {
            if (settlementId !== id) return;
            layout = made;
            renderSummary();
            townMap.show(made, districts, { living: comparing === undefined });
            aroundYou.unfollow();
            perception = undefined;
            showAvatar();
            perceive();
          },
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
