/**
 * Hotel identity for dedupe. Diacritics are NOT stripped ("Café" ≠ "Cafe").
 *
 * Steps (locked Decision 2): NFKC → lower → drop apostrophes → non-letter/digit runs → one space → trim.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** City key: NFKC, trim, lowercase, collapse internal whitespace. */
export function normalizeCity(city: string): string {
  return city.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}
