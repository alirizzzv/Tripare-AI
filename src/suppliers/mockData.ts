export type MockHotel = {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
};

/**
 * Seed catalogues. Jaipur (and any unlisted city) has no rows on purpose.
 *
 * Delhi overlap / tie cases (PROMPT 1):
 * - Holtin: A 6000/10%, B 5340/20% → B wins on price
 * - Radison: A 5900/13%, B higher price → A wins on price
 * - Oberoi: equal price, B higher commission → B wins
 * - ITC Maurya: equal price + equal commission → A wins
 * - name variants: Holtin vs " HOLTIN "; The Grand Palace vs "the grand palace"
 * - A-only: Lodhi, Shangri-La Eros
 * - B-only: Andaz Delhi, The Imperial
 */
export const supplierAHotels: MockHotel[] = [
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'The Grand Palace', price: 4500, city: 'delhi', commissionPct: 11 },
  { hotelId: 'a4', name: 'Oberoi', price: 8000, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a5', name: 'ITC Maurya', price: 7000, city: 'delhi', commissionPct: 15 },
  { hotelId: 'a6', name: 'Lodhi', price: 9000, city: 'delhi', commissionPct: 8 },
  { hotelId: 'a7', name: 'Shangri-La Eros', price: 8500, city: 'delhi', commissionPct: 11 },
  { hotelId: 'a8', name: 'Leela Palace', price: 10000, city: 'delhi', commissionPct: 9 },
  { hotelId: 'a9', name: 'Holtin', price: 5200, city: 'mumbai', commissionPct: 10 },
  { hotelId: 'a10', name: 'Radison', price: 4800, city: 'mumbai', commissionPct: 13 },
  { hotelId: 'a11', name: 'The Grand Palace', price: 3900, city: 'mumbai', commissionPct: 11 },
  { hotelId: 'a12', name: 'Oberoi', price: 7600, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'a13', name: 'ITC Maratha', price: 6400, city: 'mumbai', commissionPct: 15 },
  { hotelId: 'a14', name: 'Taj Mahal Palace', price: 12000, city: 'mumbai', commissionPct: 8 },
  { hotelId: 'a15', name: 'Trident Nariman Point', price: 7200, city: 'mumbai', commissionPct: 11 },
  { hotelId: 'a16', name: 'St Regis', price: 11000, city: 'mumbai', commissionPct: 9 },
];

export const supplierBHotels: MockHotel[] = [
  { hotelId: 'b1', name: ' HOLTIN ', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'Radison', price: 6500, city: 'delhi', commissionPct: 10 },
  { hotelId: 'b3', name: 'the grand palace', price: 4700, city: 'delhi', commissionPct: 9 },
  { hotelId: 'b4', name: 'Oberoi', price: 8000, city: 'delhi', commissionPct: 18 },
  { hotelId: 'b5', name: 'ITC Maurya', price: 7000, city: 'delhi', commissionPct: 15 },
  { hotelId: 'b6', name: 'Andaz Delhi', price: 7200, city: 'delhi', commissionPct: 14 },
  { hotelId: 'b7', name: 'The Imperial', price: 11000, city: 'delhi', commissionPct: 7 },
  { hotelId: 'b8', name: 'Leela Palace', price: 9800, city: 'delhi', commissionPct: 10 },
  { hotelId: 'b9', name: ' HOLTIN ', price: 4990, city: 'mumbai', commissionPct: 20 },
  { hotelId: 'b10', name: 'Radison', price: 5300, city: 'mumbai', commissionPct: 10 },
  { hotelId: 'b11', name: 'the grand palace', price: 4100, city: 'mumbai', commissionPct: 9 },
  { hotelId: 'b12', name: 'Oberoi', price: 7600, city: 'mumbai', commissionPct: 18 },
  { hotelId: 'b13', name: 'ITC Maratha', price: 6400, city: 'mumbai', commissionPct: 15 },
  { hotelId: 'b14', name: 'The St. Regis Mumbai', price: 10500, city: 'mumbai', commissionPct: 14 },
  { hotelId: 'b15', name: 'Four Seasons', price: 13000, city: 'mumbai', commissionPct: 7 },
  { hotelId: 'b16', name: 'St Regis', price: 10800, city: 'mumbai', commissionPct: 10 },
];

export const hotelsBySupplier = {
  supplierA: supplierAHotels,
  supplierB: supplierBHotels,
} as const;

export type SupplierKey = keyof typeof hotelsBySupplier;
