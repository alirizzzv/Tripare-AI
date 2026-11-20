export type SupplierId = 'supplierA' | 'supplierB';

export type SupplierLabel = 'Supplier A' | 'Supplier B';

export type SupplierRecord = {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
};

export type Offer = {
  name: string;
  price: number;
  supplier: SupplierLabel;
  commissionPct: number;
};
