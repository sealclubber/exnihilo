/**
 * The city inspector: a generated city's summary, its districts, a searchable
 * list of households, and views of one household or one building.
 */
import type { BuildingDetail, CitySummary, District, HouseholdDetail, HouseholdListItem, PackLabels } from '@worldsim/core';
import { fetchBuilding, fetchCitySummary, fetchDistricts, fetchHousehold, fetchHouseholds, fetchPackLabels } from './api.ts';
import {
  type BarSection,
  type HouseholdFilters,
  buildingKindName,
  buildingTypeName,
  describeMember,
  districtLabel,
  filterChips,
  formatNumber,
  occupationName,
  summaryBars,
} from './city-format.ts';
import { h, link } from './dom.ts';

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

  root.replaceChildren(
    h('header', {}, h('button', { class: 'back', onClick: onClose, attrs: { type: 'button' } }, '← Map'), h('div', {}, title, subtitle)),
    h(
      'div',
      { class: 'columns' },
      summaryBox,
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
            h('span', {}, `${household.headName}${household.headOccupationId ? `, ${occupationName(household.headOccupationId, labels).toLowerCase()}` : ''}`),
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

  function renderHousehold(detail: HouseholdDetail): void {
    const { household, members, dwelling, district } = detail;
    const rows = members.map((person) => {
      const text = describeMember(person, labels);
      return h(
        'tr',
        {},
        h('td', {}, text.name),
        h('td', { class: 'number' }, text.age),
        h('td', {}, text.sex),
        h('td', {}, text.role),
        h('td', {}, text.work),
        h('td', {}, person.workplaceId ? link(workplaceName(person.workplaceId, detail), () => void showBuilding(person.workplaceId as string), 'Show who works there') : ''),
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
        h('thead', {}, h('tr', {}, ...['Name', 'Age', 'Sex', 'Role', 'Occupation', 'Workplace'].map((heading) => h('th', {}, heading)))),
        h('tbody', {}, ...rows),
      ),
    );
    detailBox.scrollTop = 0;
  }

  /** Workplaces are named by type; the building's number tells two of a type apart. */
  const workplaceNames = new Map<string, string>();
  function workplaceName(buildingId: string, detail: HouseholdDetail): string {
    if (buildingId === detail.dwelling.id) return `${buildingTypeName(detail.dwelling.type, labels)} (home)`;
    return workplaceNames.get(buildingId) ?? `Building ${Number(buildingId.split('-')[2])}`;
  }

  function renderBuilding(detail: BuildingDetail): void {
    const { building, district, workers, households } = detail;
    workplaceNames.set(building.id, buildingTypeName(building.type, labels));
    detailBox.replaceChildren(
      h('h2', {}, buildingTypeName(building.type, labels)),
      h('p', { class: 'subtitle' }, `${buildingKindName(building.kind)} · ${districtLabel(district, labels)} · ${building.id}`),
      h('h3', {}, `People working here (${workers.length})`),
      workers.length === 0
        ? hint('Nobody works here.')
        : h(
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
                  h('td', {}, occupationName(person.occupationId, labels)),
                  h('td', {}, link('Open', () => void showHousehold(person.householdId), 'Show this person\'s household')),
                ),
              ),
            ),
          ),
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
    // Fetch the workplaces' types first, so the members table can name them.
    await showDetail(async () => {
      const detail = await fetchHousehold(settlementId, id);
      const unknown = [...new Set(detail.members.map((person) => person.workplaceId))].filter(
        (workplace): workplace is string => workplace !== undefined && workplace !== detail.dwelling.id && !workplaceNames.has(workplace),
      );
      const buildings = await Promise.all(unknown.map((workplace) => fetchBuilding(settlementId, workplace)));
      for (const { building } of buildings) workplaceNames.set(building.id, buildingTypeName(building.type, labels));
      return detail;
    }, renderHousehold);
  }

  async function showBuilding(id: string): Promise<void> {
    await showDetail(() => fetchBuilding(settlementId, id), renderBuilding);
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
      workplaceNames.clear();
      search.value = '';
      root.hidden = false;
      title.textContent = 'Generating the city…';
      subtitle.textContent = id;
      summaryBox.replaceChildren();
      listBox.replaceChildren();
      listHeading.textContent = 'Households';
      chipBox.replaceChildren();
      more.hidden = true;
      detailBox.replaceChildren(hint('Choose a household to see its members, their work and their home.'));
      try {
        const [packLabels, citySummary, districtPage] = await Promise.all([fetchPackLabels(), fetchCitySummary(id), fetchDistricts(id)]);
        if (settlementId !== id) return;
        labels = packLabels;
        summary = citySummary;
        districts = districtPage.items;
        title.textContent = summary.settlementName;
        subtitle.textContent = `${formatNumber(summary.population)} residents in ${formatNumber(summary.households)} households`;
        renderSummary();
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
