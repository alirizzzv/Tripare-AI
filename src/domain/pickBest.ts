import type { Offer } from './types';

/**
 * Lower selling price wins. Equal price → higher commissionPct.
 * Equal price and commission → Supplier A.
 *
 * Assumption (Decision 10): commissionPct is our earning on the selling price.
 */
export function pickBest(a: Offer, b: Offer): Offer {
  if (a.price !== b.price) {
    return a.price < b.price ? a : b;
  }
  if (a.commissionPct !== b.commissionPct) {
    return a.commissionPct > b.commissionPct ? a : b;
  }
  if (a.supplier === 'Supplier A') {
    return a;
  }
  if (b.supplier === 'Supplier A') {
    return b;
  }
  return a;
}
