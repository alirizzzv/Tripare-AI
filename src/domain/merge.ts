import { normalizeName } from './normalize';
import { pickBest } from './pickBest';
import { serializeOffer } from './serialize';
import type { Offer } from './types';

/**
 * Dedupe by normalizeName; keep the winning offer's original display name.
 * Sort: price ascending, then lexicographic serializeOffer (matches Redis ZSET member order).
 */
export function mergeBestOffers(fromA: readonly Offer[], fromB: readonly Offer[]): Offer[] {
  const bestByName = new Map<string, Offer>();

  for (const offer of fromA) {
    consider(bestByName, offer);
  }
  for (const offer of fromB) {
    consider(bestByName, offer);
  }

  return [...bestByName.values()].sort((left, right) => {
    if (left.price !== right.price) {
      return left.price - right.price;
    }
    // WHY: after name-dedupe, serializeOffer members are unique; skip a === 0 arm (Redis also uses member uniqueness).
    const leftMember = serializeOffer(left);
    const rightMember = serializeOffer(right);
    return leftMember < rightMember ? -1 : 1;
  });
}

function consider(bestByName: Map<string, Offer>, offer: Offer): void {
  const key = normalizeName(offer.name);
  if (key === '') {
    return;
  }
  const existing = bestByName.get(key);
  if (!existing) {
    bestByName.set(key, offer);
    return;
  }
  bestByName.set(key, pickBest(existing, offer));
}
