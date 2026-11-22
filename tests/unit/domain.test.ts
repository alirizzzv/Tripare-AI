import { mergeBestOffers } from '../../src/domain/merge';
import { cleanDisplayName, normalizeCity, normalizeName } from '../../src/domain/normalize';
import { pickBest } from '../../src/domain/pickBest';
import { parseSupplierResponse } from '../../src/domain/schemas';
import { deserializeOffer, serializeOffer } from '../../src/domain/serialize';
import type { Offer } from '../../src/domain/types';

const OFFER_KEYS = ['commissionPct', 'name', 'price', 'supplier'];

function offer(partial: Partial<Offer> & Pick<Offer, 'name' | 'price' | 'supplier'>): Offer {
  return {
    commissionPct: 10,
    ...partial,
  };
}

describe('normalizeName', () => {
  it('collapses punctuation and case so Taj-Mahal equals Taj Mahal', () => {
    expect(normalizeName('Taj-Mahal')).toBe(normalizeName('Taj Mahal'));
  });

  it('treats St. Regis as St Regis', () => {
    expect(normalizeName('St. Regis')).toBe('st regis');
  });

  it("strips apostrophes so O'Brien equals OBrien", () => {
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('O’Brien')).toBe('obrien');
  });

  it('strips every apostrophe-like char from Decision 2 (‘ ’ ʼ `)', () => {
    // Regression: ʼ (U+02BC) and backtick were previously turned into spaces ("o brien").
    for (const variant of ["O'Brien", 'O‘Brien', 'O’Brien', 'OʼBrien', 'O`Brien']) {
      expect(normalizeName(variant)).toBe('obrien');
    }
  });

  it('maps full-width HOLTIN to holtin via NFKC', () => {
    expect(normalizeName('ＨＯＬＴＩＮ')).toBe('holtin');
  });

  it('does not strip diacritics: Café ≠ Cafe', () => {
    expect(normalizeName('Café')).not.toBe(normalizeName('Cafe'));
  });

  it('keeps Hilton and Hilton Garden Inn separate', () => {
    expect(normalizeName('Hilton')).not.toBe(normalizeName('Hilton Garden Inn'));
  });
});

describe('cleanDisplayName', () => {
  it('trims and collapses whitespace but keeps supplier casing', () => {
    // Regression: the API used to return " HOLTIN " with the raw spaces.
    expect(cleanDisplayName(' HOLTIN ')).toBe('HOLTIN');
    expect(cleanDisplayName('The  Grand\tPalace')).toBe('The Grand Palace');
    expect(cleanDisplayName('St. Regis')).toBe('St. Regis');
  });
});

describe('normalizeCity', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeCity('  New   Delhi ')).toBe('new delhi');
  });
});

describe('pickBest', () => {
  it('cheaper Supplier B wins (Holtin)', () => {
    const a = offer({ name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 });
    const b = offer({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 });
    expect(pickBest(a, b)).toEqual(b);
  });

  it('cheaper Supplier A wins (Radison)', () => {
    const a = offer({ name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 });
    const b = offer({ name: 'Radison', price: 6500, supplier: 'Supplier B', commissionPct: 10 });
    expect(pickBest(a, b)).toEqual(a);
  });

  it('price tie prefers higher commission', () => {
    const a = offer({ name: 'Oberoi', price: 8000, supplier: 'Supplier A', commissionPct: 12 });
    const b = offer({ name: 'Oberoi', price: 8000, supplier: 'Supplier B', commissionPct: 18 });
    expect(pickBest(a, b)).toEqual(b);
  });

  it('price and commission tie prefers Supplier A', () => {
    const a = offer({ name: 'ITC Maurya', price: 7000, supplier: 'Supplier A', commissionPct: 15 });
    const b = offer({ name: 'ITC Maurya', price: 7000, supplier: 'Supplier B', commissionPct: 15 });
    expect(pickBest(a, b)).toEqual(a);
    expect(pickBest(b, a)).toEqual(a);
  });

  it('price and commission tie between two B offers keeps the first argument', () => {
    const first = offer({ name: 'X', price: 100, supplier: 'Supplier B', commissionPct: 10 });
    const second = offer({ name: 'X', price: 100, supplier: 'Supplier B', commissionPct: 10 });
    expect(pickBest(first, second)).toBe(first);
  });

  it('price tie prefers the first offer when it has higher commission', () => {
    const a = offer({ name: 'Oberoi', price: 8000, supplier: 'Supplier A', commissionPct: 18 });
    const b = offer({ name: 'Oberoi', price: 8000, supplier: 'Supplier B', commissionPct: 12 });
    expect(pickBest(a, b)).toEqual(a);
  });
});

describe('mergeBestOffers', () => {
  it('collapses case/whitespace/punctuation duplicates and keeps winner display name', () => {
    const a = [offer({ name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 })];
    const b = [offer({ name: ' HOLTIN ', price: 5340, supplier: 'Supplier B', commissionPct: 20 })];
    const merged = mergeBestOffers(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: ' HOLTIN ',
      price: 5340,
      supplier: 'Supplier B',
      commissionPct: 20,
    });
  });

  it('keeps Hilton and Hilton Garden Inn as two hotels', () => {
    const a = [
      offer({ name: 'Hilton', price: 4000, supplier: 'Supplier A' }),
      offer({ name: 'Hilton Garden Inn', price: 4100, supplier: 'Supplier A' }),
    ];
    const merged = mergeBestOffers(a, []);
    expect(merged.map((o) => o.name).sort()).toEqual(['Hilton', 'Hilton Garden Inn']);
  });

  it('keeps single-supplier hotels', () => {
    const a = [offer({ name: 'Lodhi', price: 9000, supplier: 'Supplier A' })];
    const b = [offer({ name: 'Andaz Delhi', price: 7200, supplier: 'Supplier B' })];
    const names = mergeBestOffers(a, b).map((o) => o.name).sort();
    expect(names).toEqual(['Andaz Delhi', 'Lodhi']);
  });

  it('returns empty when both inputs are empty', () => {
    expect(mergeBestOffers([], [])).toEqual([]);
  });

  it('returns the non-empty side when the other is empty', () => {
    const only = [offer({ name: 'Solo', price: 100, supplier: 'Supplier A' })];
    expect(mergeBestOffers(only, [])).toEqual(only);
    expect(mergeBestOffers([], only)).toEqual(only);
  });

  it('does not mutate input arrays', () => {
    const a = [offer({ name: 'A', price: 2, supplier: 'Supplier A' })];
    const b = [offer({ name: 'B', price: 1, supplier: 'Supplier B' })];
    const aCopy = [...a];
    const bCopy = [...b];
    mergeBestOffers(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });

  it('sorts by price ascending then serializeOffer member order', () => {
    const hiltonGarden = offer({
      name: 'Hilton Garden Inn',
      price: 100,
      supplier: 'Supplier A',
    });
    const hilton = offer({ name: 'Hilton', price: 100, supplier: 'Supplier A' });
    const cheaper = offer({ name: 'Cheap', price: 50, supplier: 'Supplier B' });
    const merged = mergeBestOffers([hilton, hiltonGarden, cheaper], []);
    expect(merged.map((o) => o.name)).toEqual(['Cheap', 'Hilton Garden Inn', 'Hilton']);
    expect(serializeOffer(hiltonGarden) < serializeOffer(hilton)).toBe(true);
  });

  it('drops offers whose names normalize to empty', () => {
    const merged = mergeBestOffers(
      [offer({ name: '***', price: 1, supplier: 'Supplier A' })],
      [offer({ name: 'Real', price: 2, supplier: 'Supplier B' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('Real');
  });

  it('every merged item has exactly four keys', () => {
    const merged = mergeBestOffers(
      [offer({ name: 'X', price: 1, supplier: 'Supplier A', commissionPct: 1 })],
      [offer({ name: 'Y', price: 2, supplier: 'Supplier B', commissionPct: 2 })],
    );
    for (const item of merged) {
      expect(Object.keys(item).sort()).toEqual(OFFER_KEYS);
    }
  });
});

describe('parseSupplierResponse', () => {
  const good = {
    hotelId: 'a1',
    name: 'Holtin',
    price: 6000,
    city: 'delhi',
    commissionPct: 10,
  };

  it('keeps valid records and counts skipped invalid ones', () => {
    const result = parseSupplierResponse([
      good,
      { hotelId: '', name: 'Bad', price: 1, city: 'delhi', commissionPct: 1 },
      { hotelId: 'x', name: 'BadPrice', price: -1, city: 'delhi', commissionPct: 1 },
      { hotelId: 'y', name: '---', price: 10, city: 'delhi', commissionPct: 1 },
      { hotelId: 'z', name: 'Ok', price: 10, city: 'delhi', commissionPct: 101 },
    ]);
    expect(result.valid).toEqual([good]);
    expect(result.invalidCount).toBe(4);
  });

  it('throws when the payload is not an array', () => {
    expect(() => parseSupplierResponse({ hotels: [] })).toThrow(/not an array/);
  });
});

describe('serializeOffer', () => {
  it('emits JSON with name, price, supplier, commissionPct key order', () => {
    const o = offer({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 });
    expect(serializeOffer(o)).toBe(
      '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20}',
    );
    expect(deserializeOffer(serializeOffer(o))).toEqual(o);
  });
});
