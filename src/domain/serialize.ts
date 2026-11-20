import type { Offer } from './types';

/** Stable JSON member for Redis ZADD and merge sort ties (byte order, not localeCompare). */
export function serializeOffer(offer: Offer): string {
  return JSON.stringify({
    name: offer.name,
    price: offer.price,
    supplier: offer.supplier,
    commissionPct: offer.commissionPct,
  });
}

export function deserializeOffer(member: string): Offer {
  return JSON.parse(member) as Offer;
}
