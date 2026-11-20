import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, PackError, allOccupations, parsePack } from '../src/index.ts';
import { loadPack, readPackFiles } from '../../server/src/pack-loader.ts';
import { lomiaWorld, medievalPack, rawMedievalPack } from './pack.ts';

describe('the medieval pack', () => {
  const pack = medievalPack();

  it('loads and names itself', () => {
    expect(pack.pack.name).toBe('medieval');
    expect(pack.pack.version).toBe('0.3.0');
  });

  it('has the seven categories with the base shares', () => {
    expect(Object.fromEntries(pack.categories.map((category) => [category.id, category.share]))).toEqual({
      food: 15,
      utilities: 10,
      services: 20,
      construction: 10,
      military: 5,
      luxury: 5,
      trade: 35,
    });
  });

  it('has the starting modifiers', () => {
    expect(pack.modifiers).toEqual({
      sizeGroups: {
        village: { food: 4, trade: 0.4, services: 0.6, luxury: 0.2 },
        fort: { military: 6, trade: 0.3, luxury: 0.2 },
      },
      conditions: {
        citadel: { military: 2 },
        walls: { military: 1.3, construction: 1.2 },
        temple: { services: 1.2 },
        port: { trade: 1.3 },
        capital: { services: 1.5, luxury: 2, military: 1.5 },
        provinceSeat: { services: 1.2 },
      },
    });
  });

  it('is roughly the intended size', () => {
    expect(allOccupations(pack).length).toBeGreaterThanOrEqual(80);
    expect(allOccupations(pack).length).toBeLessThanOrEqual(125);
    expect(pack.workplaces.length).toBeGreaterThanOrEqual(30);
    expect(pack.workplaces.length).toBeLessThanOrEqual(55);
  });

  it('has occupations in every category', () => {
    for (const category of CATEGORY_IDS) {
      expect(pack.occupations.filter((occupation) => occupation.category === category).length, category).toBeGreaterThan(2);
    }
  });

  it('handles every specialty tag found in Lomia, with occupations or by ignoring it', () => {
    const tags = new Set(lomiaWorld().settlements.flatMap((brief) => brief.specialtyTags));
    expect(tags.size).toBe(49);
    for (const tag of tags) {
      const treatment = pack.specialties.tags[tag];
      expect(treatment, tag).toBeDefined();
      const carried = pack.occupations.some((occupation) => occupation.specialties?.includes(tag));
      expect(Boolean(treatment?.ignore) || carried, tag).toBe(true);
    }
  });

  it('ignores only the tags its comment lists for review', () => {
    const ignored = Object.entries(pack.specialties.tags)
      .filter(([, treatment]) => treatment.ignore)
      .map(([tag]) => tag);
    expect(ignored).toEqual(['slaves']);
  });

  it('includes the dwarf test species, with a runesmith nobody else has', () => {
    expect(Object.keys(pack.species)).toEqual(['human', 'dwarf']);
    const dwarf = pack.species.dwarf!;
    expect(dwarf.occupations?.map((occupation) => occupation.id)).toEqual(['runesmith']);
    expect(dwarf.multipliers.occupations).toMatchObject({ mason: expect.any(Number), miner: expect.any(Number) });
    expect(dwarf.multipliers.occupations!.mason).toBeGreaterThan(1);
    expect(pack.occupations.some((occupation) => occupation.id === 'runesmith')).toBe(false);
  });

  it('gives the pack the dials for apprentices and eligibility, as placeholders', () => {
    expect(pack.pack.apprenticeUntil).toBeGreaterThan(0);
    expect(pack.pack.apprenticeLabel).toBe('Apprentice {occupation}');
    const of = (id: string) => allOccupations(pack).find((occupation) => occupation.id === id)!;
    // Unskilled jobs have no apprenticeship.
    for (const id of ['servant', 'farmhand', 'porter', 'builders-labourer', 'carter']) expect(of(id).apprenticeUntil, id).toBe(0);
    expect(of('tanner').apprenticeUntil).toBeUndefined();
    // Posts of authority, learned professions and the military have a minimum age.
    for (const id of ['castellan', 'high-priest', 'provincial-official', 'physician', 'priest', 'clerk']) {
      expect(of(id).minAge, id).toBeGreaterThan(0);
    }
    for (const occupation of allOccupations(pack).filter((entry) => entry.category === 'military')) {
      expect(occupation.minAge, occupation.id).toBeGreaterThan(0);
    }
    expect(of('tanner').minAge).toBeUndefined();
  });

  it('sets a sex limit on no occupation', () => {
    expect(allOccupations(pack).filter((occupation) => occupation.sexes !== undefined)).toEqual([]);
  });

  it('has servants work in the homes of households that employ them, with no great house', () => {
    const servant = pack.occupations.find((occupation) => occupation.id === 'servant')!;
    expect(servant.workplace).toBeUndefined();
    expect(Object.keys(servant.employer!.tiers)).toEqual(['comfortable', 'wealthy', 'noble']);
    expect(pack.workplaces.some((type) => type.id === 'great-house')).toBe(false);
    expect(allOccupations(pack).filter((occupation) => occupation.employer).map((occupation) => occupation.id)).toEqual(['servant']);
  });

  it('holds every layout number, and places every district kind', () => {
    const { layout } = pack;
    expect(Object.keys(layout.streetWidths)).toEqual(['arterial', 'street', 'lane', 'bridge']);
    expect(layout.block).toEqual({ length: 80, depth: 44 });
    expect(layout.defaultLot).toEqual({ frontage: 8, depth: 20 });
    expect(layout.riverWidth).toBeGreaterThan(0);
    expect(layout.density.min).toBeLessThan(layout.density.max);
    const types = new Set([...pack.workplaces, ...pack.dwellings, ...pack.landmarks].map((type) => type.id));
    for (const type of Object.keys(layout.lots)) expect(types.has(type), type).toBe(true);
    // A dwelling that holds several households has a larger lot than one that holds a single household.
    const area = (type: string) => layout.lots[type]!.frontage * layout.lots[type]!.depth;
    for (const shared of pack.dwellings.filter((type) => type.households > 1)) {
      for (const single of pack.dwellings.filter((type) => type.households === 1 && type.status === shared.status)) {
        expect(area(shared.id), `${shared.id} against ${single.id}`).toBeGreaterThan(area(single.id));
      }
    }
    expect(Object.fromEntries(pack.districts.kinds.map((kind) => [kind.id, kind.placement]))).toEqual({
      centre: 'centre',
      craft: 'middle',
      common: 'middle',
      upper: 'middle',
      lower: 'edge',
      outskirts: 'edge',
      harbour: 'waterside',
      shanty: 'edge',
    });
    expect(layout.atExits).toEqual(['gatehouse']);
  });

  it('maps every Lomia culture to human by default', () => {
    expect(pack.cultures.default).toBe('human');
    for (const culture of lomiaWorld().cultures.filter((entry) => !entry.isPlaceholder)) {
      expect(pack.cultures.cultures[culture.name], culture.name).toBe('human');
    }
  });
});

describe('pack validation', () => {
  const problemsOf = (edit: (raw: any) => void): string[] => {
    const raw = rawMedievalPack();
    edit(raw);
    try {
      parsePack(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(PackError);
      return (error as PackError).problems;
    }
    throw new Error('the pack was accepted');
  };

  it('accepts the unedited files', () => {
    expect(() => parsePack(rawMedievalPack())).not.toThrow();
  });

  it('rejects a share table that cannot be scaled to 100%', () => {
    const problems = problemsOf((raw) => raw.categories.forEach((category: any) => (category.share = 0)));
    expect(problems.join('\n')).toMatch(/categories: the shares cannot be scaled to 100%/);
  });

  it('rejects a negative share, naming the file and the entry', () => {
    const problems = problemsOf((raw) => (raw.categories[2].share = -5));
    expect(problems[0]).toMatch(/^categories at 2\.share/);
  });

  it('rejects an occupation naming a missing workplace type', () => {
    const problems = problemsOf((raw) => (raw.occupations.find((entry: any) => entry.id === 'baker').workplace = 'bakehouse'));
    expect(problems).toEqual(['occupations: "baker" names the workplace type "bakehouse", which does not exist']);
  });

  const cases: Array<[string, (raw: any) => void, RegExp]> = [
    ['a missing category', (raw) => raw.categories.splice(0, 1), /categories: "food" must be listed exactly once/],
    ['a category listed twice', (raw) => raw.categories.push({ ...raw.categories[0] }), /"food" must be listed exactly once, but is listed 2 times/],
    ['an unknown category on an occupation', (raw) => (raw.occupations[0].category = 'farming'), /^occupations at 0\.category/],
    ['an unknown status tier', (raw) => (raw.occupations[0].status = 'rich'), /"baker" names the status tier "rich"/],
    ['a duplicated occupation', (raw) => raw.occupations.push({ ...raw.occupations[0] }), /occupations: "baker" is defined more than once/],
    ['a building type defined twice', (raw) => raw.dwellings.push({ ...raw.dwellings[0], id: 'bakery' }), /building type "bakery" is defined more than once/],
    ['a workplace in an unknown district kind', (raw) => (raw.workplaces[0].district = 'suburb'), /workplaces: "bakery" names the district kind "suburb"/],
    ['a workplace with no capacity', (raw) => (raw.workplaces[0].capacity = 0), /^workplaces at 0\.capacity/],
    ['a tier with no dwelling', (raw) => (raw.dwellings = raw.dwellings.filter((type: any) => type.status !== 'noble')), /no dwelling type exists for the status tier "noble"/],
    ['a post for an occupation that does not exist', (raw) => (raw.landmarks[0].posts[0].occupation = 'warlord'), /"citadel" has a post for the occupation "warlord"/],
    ['a post occupation given a weight', (raw) => (raw.occupations.find((entry: any) => entry.id === 'castellan').weight = 2), /"castellan" works at the landmark "citadel".*weight must be 0/],
    ['a landmark with an unknown condition', (raw) => (raw.landmarks[0].when = 'harbour'), /^landmarks at 0\.when/],
    ['an occupation with a tag that is not listed', (raw) => (raw.occupations.find((entry: any) => entry.id === 'tanner').specialties = ['hides']), /"tanner" carries the specialty tag "hides"/],
    ['a used tag that no occupation carries', (raw) => (raw.specialties.tags.slaves = {}), /the tag "slaves" is not ignored, but no occupation/],
    ['too few rank weights', (raw) => (raw.specialties.maxTags = 5), /rankWeights has 3 entries but maxTags is 5/],
    ['a category left with no general occupation', (raw) => (raw.occupations = raw.occupations.filter((entry: any) => entry.category !== 'luxury')), /the category "luxury" has no occupation/],
    ['an occupation with both a workplace and an employer', (raw) => (raw.occupations.find((entry: any) => entry.id === 'servant').workplace = 'laundry'), /occupations: "servant" has both a workplace and an employer; it needs exactly one/],
    ['an occupation with neither a workplace nor an employer', (raw) => delete raw.occupations.find((entry: any) => entry.id === 'baker').workplace, /occupations: "baker" has neither a workplace nor an employer; it needs exactly one/],
    ['an employer in an unknown status tier', (raw) => (raw.occupations.find((entry: any) => entry.id === 'servant').employer = { tiers: { royal: 1 } }), /"servant" employer names the status tier "royal"/],
    ['an employer block with no tiers', (raw) => (raw.occupations.find((entry: any) => entry.id === 'servant').employer = { tiers: {} }), /"servant" has an employer block that lists no status tier/],
    ['a fixed post that works in an employer\'s home', (raw) => Object.assign(raw.occupations.find((entry: any) => entry.id === 'castellan'), { workplace: undefined, employer: { tiers: { noble: 1 } } }), /"castellan" is a landmark's fixed post/],
    ['a minimum age above the maximum', (raw) => Object.assign(raw.occupations[0], { minAge: 40, maxAge: 30 }), /"baker" has a minAge of 40 above its maxAge of 30/],
    ['a sex the format does not know', (raw) => (raw.occupations[0].sexes = ['other']), /^occupations at 0\.sexes/],
    ['an apprentice label without a place for the occupation', (raw) => (raw.pack.apprenticeLabel = 'Apprentice'), /apprenticeLabel "Apprentice" must contain \{occupation\}/],
    ['apprentices with no label to show them by', (raw) => delete raw.pack.apprenticeLabel, /apprenticeLabel is needed/],
    ['elders who could be younger than a parent may be', (raw) => (raw.species.human.ages.elderGap = { min: 10, max: 30 }), /"human" has an elderGap\.min of 10 below its parentMinAge of 18/],
    ['a lot size of zero', (raw) => (raw.layout.defaultLot = { frontage: 0, depth: 20 }), /^layout at defaultLot\.frontage/],
    ['a negative lot depth for a building type', (raw) => (raw.layout.lots.tenement = { frontage: 16, depth: -22 }), /^layout at lots\.tenement\.depth/],
    ['a street width of zero', (raw) => (raw.layout.streetWidths.lane = 0), /^layout at streetWidths\.lane/],
    ['a negative street width', (raw) => (raw.layout.streetWidths.arterial = -10), /^layout at streetWidths\.arterial/],
    ['a river with no width', (raw) => (raw.layout.riverWidth = 0), /^layout at riverWidth/],
    ['a block with no depth', (raw) => (raw.layout.block.depth = 0), /^layout at block\.depth/],
    ['density limits the wrong way round', (raw) => (raw.layout.density = { min: 500, max: 100 }), /^layout at density/],
    ['a lot size for something that is not a building type', (raw) => (raw.layout.lots.lighthouse = { frontage: 10, depth: 10 }), /layout: lots has a size for "lighthouse", which is not a building type/],
    ['a lot too deep for a block', (raw) => (raw.layout.lots.citadel = { frontage: 80, depth: 60 }), /the lot of "citadel" is 80 by 60, which does not fit in a block of 80 by 44/],
    ['a default lot too long for a block', (raw) => (raw.layout.defaultLot = { frontage: 90, depth: 20 }), /the default lot is 90 by 20, which does not fit in a block/],
    ['an exit building type that does not exist', (raw) => (raw.layout.atExits = ['tollbooth']), /layout: atExits lists "tollbooth", which is not a building type/],
    ['a district kind with no placement', (raw) => delete raw.districts.kinds[1].placement, /^districts at kinds\.1\.placement/],
    ['a district placement the layout does not know', (raw) => (raw.districts.kinds[1].placement = 'suburb'), /^districts at kinds\.1\.placement/],
    ['a missing layout file', (raw) => delete raw.layout, /^layout: /],
    ['a culture mapped to a missing species', (raw) => (raw.cultures.cultures.Norse = 'elf'), /cultures: "Norse" names the species "elf"/],
    ['a default species that is missing', (raw) => (raw.cultures.default = 'elf'), /the default names the species "elf"/],
    ['a multiplier for an unknown occupation', (raw) => (raw.species.dwarf.multipliers.occupations.wizard = 2), /"dwarf" has a multiplier for the occupation "wizard"/],
    ['a probability above one', (raw) => (raw.species.human.workforce.share = 1.4), /^species at human\.workforce\.share/],
    ['an inverted age range', (raw) => (raw.species.human.workforce.workingAges = { min: 60, max: 13 }), /^species at human\.workforce\.workingAges/],
    ['a district name pattern with an unknown word', (raw) => raw.districts.kinds[0].names.push('{colour} Gate'), /name pattern "\{colour\} Gate"/],
    ['a first district kind with a condition', (raw) => Object.assign(raw.districts.kinds[0], { when: 'port', weight: undefined }), /the first kind must have a weight and no condition/],
    ['a file that holds the wrong kind of thing', (raw) => (raw.workplaces = 'bakery'), /^workplaces: /],
    ['a missing file', (raw) => delete raw.districts, /^districts: /],
    ['a setting the format does not define', (raw) => (raw.pack.households.luck = 0.5), /^pack at households/],
  ];
  it.each(cases)('rejects %s', (_, edit, expected) => {
    expect(problemsOf(edit).join('\n')).toMatch(expected);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = problemsOf((raw) => {
      raw.occupations[0].workplace = 'nowhere';
      raw.occupations[1].status = 'rich';
      raw.cultures.default = 'elf';
    });
    expect(problems).toHaveLength(3);
  });

  it('accepts a version written as a number', () => {
    const raw = rawMedievalPack();
    raw.pack.version = 2;
    expect(parsePack(raw).pack.version).toBe('2');
  });
});

describe('loading a pack from disk', () => {
  it('fails with a message naming the folder when a file is missing', () => {
    expect(() => loadPack('/nonexistent/pack')).toThrow(PackError);
    expect(() => readPackFiles('/nonexistent/pack')).toThrow(/\/nonexistent\/pack\/pack\.yaml cannot be read/);
  });
});
