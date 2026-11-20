/**
 * Generated cities, made on request and kept in memory for a while. Nothing
 * here is written to the world store: a city is recomputed from its brief,
 * the pack and the seed whenever it is needed again.
 */
import {
  type Building,
  type BuildingDetail,
  type CategoryId,
  type City,
  type District,
  type DistrictRef,
  type Household,
  type HouseholdDetail,
  type HouseholdListItem,
  type Page,
  type Person,
  type SettingPack,
  type SettlementBrief,
  allOccupations,
  generateCity,
} from '@worldsim/core';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;
const CITIES_KEPT = 6;

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface CityFilters {
  district?: string;
  occupation?: string;
  category?: string;
  household?: string;
  workplace?: string;
  status?: string;
  kind?: string;
  type?: string;
  /** Text to find in a name, in any letter case. */
  q?: string;
}

/** A generated city with the lookups the API needs. */
export class CityView {
  readonly city: City;
  private readonly people: Map<string, Person>;
  private readonly households: Map<string, Household>;
  private readonly buildings: Map<string, Building>;
  private readonly districts: Map<string, District>;
  private readonly categoryOf: Map<string, CategoryId>;

  constructor(city: City, pack: SettingPack) {
    this.city = city;
    this.people = new Map(city.people.map((person) => [person.id, person]));
    this.households = new Map(city.households.map((household) => [household.id, household]));
    this.buildings = new Map(city.buildings.map((building) => [building.id, building]));
    this.districts = new Map(city.districts.map((district) => [district.id, district]));
    this.categoryOf = new Map(allOccupations(pack).map((occupation) => [occupation.id, occupation.category]));
  }

  private districtOfHousehold(household: Household): string {
    return (this.buildings.get(household.dwellingId) as Building).districtId;
  }

  private membersOf(household: Household): Person[] {
    return household.memberIds.map((id) => this.people.get(id) as Person);
  }

  private worksAs(person: Person, filters: CityFilters): boolean {
    if (filters.occupation !== undefined && person.occupationId !== filters.occupation) return false;
    if (filters.category !== undefined) {
      if (person.occupationId === undefined || this.categoryOf.get(person.occupationId) !== filters.category) return false;
    }
    return true;
  }

  private listItem(household: Household): HouseholdListItem {
    const head = this.people.get(household.headId) as Person;
    return {
      ...household,
      size: household.memberIds.length,
      headName: `${head.givenName} ${head.familyName}`,
      ...(head.occupationId !== undefined && { headOccupationId: head.occupationId }),
      districtId: this.districtOfHousehold(household),
    };
  }

  private districtRef(id: string): DistrictRef {
    const { name, kind } = this.districts.get(id) as District;
    return { id, name, kind };
  }

  listPeople(filters: CityFilters, page: PageRequest): Page<Person> {
    const text = filters.q?.toLowerCase();
    return paged(
      this.city.people.filter((person) => {
        if (filters.household !== undefined && person.householdId !== filters.household) return false;
        if (filters.workplace !== undefined && person.workplaceId !== filters.workplace) return false;
        if (!this.worksAs(person, filters)) return false;
        if (filters.district !== undefined) {
          if (this.districtOfHousehold(this.households.get(person.householdId) as Household) !== filters.district) return false;
        }
        return text === undefined || `${person.givenName} ${person.familyName}`.toLowerCase().includes(text);
      }),
      page,
    );
  }

  listHouseholds(filters: CityFilters, page: PageRequest): Page<HouseholdListItem> {
    const text = filters.q?.toLowerCase();
    const byWork = filters.occupation !== undefined || filters.category !== undefined;
    const matches = this.city.households.filter((household) => {
      if (filters.status !== undefined && household.statusTier !== filters.status) return false;
      if (filters.district !== undefined && this.districtOfHousehold(household) !== filters.district) return false;
      const members = byWork || text !== undefined ? this.membersOf(household) : [];
      if (byWork && !members.some((person) => person.occupationId !== undefined && this.worksAs(person, filters))) return false;
      if (text === undefined) return true;
      return (
        household.familyName.toLowerCase().includes(text) ||
        members.some((person) => `${person.givenName} ${person.familyName}`.toLowerCase().includes(text))
      );
    });
    const { items, ...rest } = paged(matches, page);
    return { ...rest, items: items.map((household) => this.listItem(household)) };
  }

  listBuildings(filters: CityFilters, page: PageRequest): Page<Building> {
    const byWork = filters.occupation !== undefined || filters.category !== undefined;
    return paged(
      this.city.buildings.filter((building) => {
        if (filters.district !== undefined && building.districtId !== filters.district) return false;
        if (filters.kind !== undefined && building.kind !== filters.kind) return false;
        if (filters.type !== undefined && building.type !== filters.type) return false;
        return !byWork || building.workerIds.some((id) => this.worksAs(this.people.get(id) as Person, filters));
      }),
      page,
    );
  }

  listDistricts(page: PageRequest): Page<District> {
    return paged(this.city.districts, page);
  }

  household(id: string): HouseholdDetail | undefined {
    const household = this.households.get(id);
    if (!household) return undefined;
    const dwelling = this.buildings.get(household.dwellingId) as Building;
    return { household, members: this.membersOf(household), dwelling, district: this.districtRef(dwelling.districtId) };
  }

  building(id: string): BuildingDetail | undefined {
    const building = this.buildings.get(id);
    if (!building) return undefined;
    return {
      building,
      district: this.districtRef(building.districtId),
      workers: building.workerIds.map((worker) => this.people.get(worker) as Person),
      households: building.householdIds.map((household) => this.listItem(this.households.get(household) as Household)),
    };
  }
}

function paged<T>(matches: T[], page: PageRequest): Page<T> {
  return {
    total: matches.length,
    offset: page.offset,
    limit: page.limit,
    items: matches.slice(page.offset, page.offset + page.limit),
  };
}

/** Generates cities on request and keeps the most recently used few. */
export class CityCache {
  private readonly pack: SettingPack;
  private readonly kept = new Map<string, CityView>();

  constructor(pack: SettingPack) {
    this.pack = pack;
  }

  get(brief: SettlementBrief): CityView {
    let view = this.kept.get(brief.id);
    if (view) {
      this.kept.delete(brief.id);
    } else {
      view = new CityView(generateCity(brief, this.pack), this.pack);
      if (this.kept.size >= CITIES_KEPT) this.kept.delete(this.kept.keys().next().value as string);
    }
    // Re-inserting moves the city to the back of the queue for removal.
    this.kept.set(brief.id, view);
    return view;
  }

  get size(): number {
    return this.kept.size;
  }
}
