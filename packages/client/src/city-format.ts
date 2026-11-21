/**
 * Turns a generated city's records into the text and numbers the inspector
 * shows. Pure, so it can be tested without a browser.
 */
import type { Building, CitySummary, District, HouseholdDetail, HouseholdListItem, PackLabels, Person } from '@worldsim/core';

export interface Bar {
  /** The ID to filter by when the bar is clicked, if it can be. */
  id?: string;
  label: string;
  value: number;
  /** Shown after the value, such as a percentage. */
  note?: string;
  /** Bar length from 0 to 1. */
  length: number;
}

export interface BarSection {
  key: 'workforce' | 'category' | 'occupation' | 'status' | 'district';
  title: string;
  bars: Bar[];
}

const percent = (part: number, whole: number) => `${whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1)}%`;
const relativeTo = (value: number, largest: number) => (largest === 0 ? 0 : value / largest);

export const formatNumber = (value: number) => value.toLocaleString('en-US');

export function occupationName(id: string | undefined, labels: PackLabels): string {
  return id === undefined ? '' : (labels.occupations[id]?.name ?? id);
}

/** A worker's occupation as shown: its name, in the pack's apprentice label for an apprentice. */
export function workName(worker: Pick<Person, 'occupationId' | 'apprentice'>, labels: PackLabels): string {
  const name = occupationName(worker.occupationId, labels);
  if (!worker.apprentice || labels.apprenticeLabel === undefined) return name;
  // The occupation sits mid-phrase in a label such as "Apprentice {occupation}".
  const startsLabel = labels.apprenticeLabel.startsWith('{occupation}');
  return labels.apprenticeLabel.replace('{occupation}', startsLabel ? name : name.charAt(0).toLowerCase() + name.slice(1));
}

function listOf(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** A person's family ties in words, such as "Partner of Ada; parent of Bo and Cy". */
export function describeKin(person: Person, household: Person[]): string {
  const given = (id: string) => household.find((member) => member.id === id)?.givenName ?? id;
  const ties: string[] = [];
  if (person.partnerId !== undefined) ties.push(`partner of ${given(person.partnerId)}`);
  if (person.parentIds.length > 0) ties.push(`child of ${listOf(person.parentIds.map(given))}`);
  if (person.childIds.length > 0) ties.push(`parent of ${listOf(person.childIds.map(given))}`);
  const text = ties.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The member a household row shows, as "Name, occupation", with the role when it is not the head. */
export function describeRowMember(member: HouseholdListItem['member'], labels: PackLabels): string {
  const who = member.role === 'head' ? member.name : `${member.name} (${ROLES[member.role].toLowerCase()})`;
  return member.occupationId === undefined ? who : `${who}, ${workName(member, labels).toLowerCase()}`;
}

/** What a member's workplace is called: its building type, or the home of the household that employs them. */
export function workplaceText(person: Person, detail: Pick<HouseholdDetail, 'workplaces' | 'dwelling'>, labels: PackLabels): string {
  if (person.workplaceId === undefined) return '';
  const workplace = detail.workplaces[person.workplaceId];
  if (workplace?.employer) return `Home of the ${workplace.employer.familyName} household`;
  const name = buildingTypeName(workplace?.type ?? person.workplaceId, labels);
  return person.workplaceId === detail.dwelling.id ? `${name} (home)` : name;
}

export function buildingTypeName(type: string, labels: PackLabels): string {
  return labels.buildingTypes[type] ?? type;
}

/**
 * The name of a building: its type's, or for one in which a household lives and people work, both, by the pack's
 * pattern: "Forge and home".
 */
export function buildingName(building: Pick<Building, 'type' | 'kind'>, labels: PackLabels): string {
  const name = buildingTypeName(building.type, labels);
  return building.kind === 'both' && labels.homeAndWorkLabel !== undefined ? labels.homeAndWorkLabel.replace('{workplace}', name) : name;
}

export function districtLabel(district: Pick<District, 'name' | 'kind'>, labels: PackLabels): string {
  return `${district.name} (${labels.districtKinds[district.kind] ?? district.kind})`;
}

const BUILDING_KINDS: Record<Building['kind'], string> = {
  workplace: 'Workplace',
  dwelling: 'Dwelling',
  both: 'Workplace and home',
  landmark: 'Landmark',
};

export function buildingKindName(kind: Building['kind']): string {
  return BUILDING_KINDS[kind];
}

/** The summary as sections of counts with bars. */
export function summaryBars(summary: CitySummary, districts: District[], labels: PackLabels): BarSection[] {
  const { workforce, population } = summary;
  const states: Array<[string, number]> = [
    ['Working', workforce.working],
    ['Keeping house', workforce.keepingHouse],
    ['Not working', workforce.notWorking],
  ];
  const occupations = Object.entries(summary.occupations).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const largestOccupation = occupations[0]?.[1] ?? 0;
  const largestTier = Math.max(0, ...Object.values(summary.statusTiers).map((tier) => tier.households));
  const largestDistrict = Math.max(0, ...Object.values(summary.districtTotals).map((district) => district.residents));

  return [
    {
      key: 'workforce',
      title: 'Residents by workforce state',
      bars: states.map(([label, value]) => ({
        label,
        value,
        note: percent(value, population),
        length: relativeTo(value, population),
      })),
    },
    {
      key: 'category',
      title: 'Workers by category',
      bars: labels.categories.map((category) => ({
        id: category.id,
        label: category.name,
        value: summary.categories[category.id],
        note: `${(summary.shares[category.id] * 100).toFixed(1)}%`,
        length: summary.shares[category.id],
      })),
    },
    {
      key: 'occupation',
      title: 'Workers by occupation',
      bars: occupations.map(([id, value]) => ({
        id,
        label: occupationName(id, labels),
        value,
        length: relativeTo(value, largestOccupation),
      })),
    },
    {
      key: 'status',
      title: 'Households by status',
      bars: labels.statusTiers.map((tier) => {
        const totals = summary.statusTiers[tier.id] ?? { households: 0, residents: 0 };
        return {
          id: tier.id,
          label: tier.name,
          value: totals.households,
          note: `${formatNumber(totals.residents)} residents`,
          length: relativeTo(totals.households, largestTier),
        };
      }),
    },
    {
      key: 'district',
      title: 'Residents by district',
      bars: districts.map((district) => {
        const totals = summary.districtTotals[district.id] ?? { residents: 0, households: 0, buildings: 0, workers: 0 };
        return {
          id: district.id,
          label: districtLabel(district, labels),
          value: totals.residents,
          note: `${formatNumber(totals.buildings)} buildings`,
          length: relativeTo(totals.residents, largestDistrict),
        };
      }),
    },
  ];
}

const ROLES: Record<Person['role'], string> = {
  head: 'Head',
  partner: 'Partner',
  child: 'Child',
  elder: 'Elder',
  lodger: 'Lodger',
};

export interface MemberText {
  name: string;
  age: string;
  sex: string;
  role: string;
  /** The occupation as shown, or the workforce state of someone who has none. */
  work: string;
}

export function describeMember(person: Person, labels: PackLabels): MemberText {
  return {
    name: `${person.givenName} ${person.familyName}`,
    age: String(person.age),
    sex: person.sex === 'female' ? 'Female' : 'Male',
    role: ROLES[person.role],
    work:
      person.occupationId !== undefined
        ? workName(person, labels)
        : person.workforceState === 'keeping-house'
          ? 'Keeping house'
          : 'Not working',
  };
}

export interface HouseholdFilters {
  district?: string;
  occupation?: string;
  category?: string;
  status?: string;
  q?: string;
}

/** The query string for a list request: filters that are set, then the page. */
export function listQuery(filters: HouseholdFilters, offset: number, limit: number): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(name, value);
  }
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  return params.toString();
}

/** What each active filter is called, for showing and clearing. */
export function filterChips(filters: HouseholdFilters, districts: District[], labels: PackLabels): Array<{ key: keyof HouseholdFilters; text: string }> {
  const chips: Array<{ key: keyof HouseholdFilters; text: string }> = [];
  if (filters.district !== undefined) {
    const district = districts.find((entry) => entry.id === filters.district);
    chips.push({ key: 'district', text: `District: ${district?.name ?? filters.district}` });
  }
  if (filters.category !== undefined) {
    const category = labels.categories.find((entry) => entry.id === filters.category);
    chips.push({ key: 'category', text: `Category: ${category?.name ?? filters.category}` });
  }
  if (filters.occupation !== undefined) {
    chips.push({ key: 'occupation', text: `Occupation: ${occupationName(filters.occupation, labels)}` });
  }
  if (filters.status !== undefined) {
    const tier = labels.statusTiers.find((entry) => entry.id === filters.status);
    chips.push({ key: 'status', text: `Status: ${tier?.name ?? filters.status}` });
  }
  return chips;
}
