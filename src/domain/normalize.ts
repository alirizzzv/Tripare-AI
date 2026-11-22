/**
 * Hotel identity for dedupe. Diacritics are NOT stripped ("Café" ≠ "Cafe").
 *
 * Steps (locked Decision 2): NFKC → lower → drop apostrophe-like chars (' ‘ ’ ʼ `) →
 * every run of non-letter/digit chars → one space → trim.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Display name shown to the client. Keeps the supplier's casing and punctuation, but removes
 * the whitespace noise suppliers send (" HOLTIN " → "HOLTIN", "The  Grand Palace" → "The Grand Palace").
 * WHY: identity (normalizeName) and presentation are different concerns; we never show a
 * lowercased key to users, but we also never return leading/trailing spaces.
 */
export function cleanDisplayName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** City key: NFKC, trim, lowercase, collapse internal whitespace. */
export function normalizeCity(city: string): string {
  return city.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}
