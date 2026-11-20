import { Router, type Request, type Response } from 'express';
import { applyChaos } from './chaos';
import { hotelsBySupplier, type SupplierKey } from './mockData';

function filterByCity(supplier: SupplierKey, city: string | undefined) {
  const hotels = hotelsBySupplier[supplier];
  if (city === undefined) {
    return hotels;
  }
  const needle = city.trim().toLowerCase();
  if (needle === '') {
    return hotels;
  }
  return hotels.filter((h) => h.city.toLowerCase() === needle);
}

export function createMockSupplierRouter(supplier: SupplierKey): Router {
  const router = Router();

  router.get('/hotels', async (req: Request, res: Response) => {
    const outcome = await applyChaos(supplier);
    if (outcome === 'down') {
      res.status(503).json({
        error: {
          code: 'SUPPLIER_DOWN',
          message: `${supplier} is down (chaos)`,
        },
      });
      return;
    }

    const cityRaw = req.query.city;
    const city = typeof cityRaw === 'string' ? cityRaw : undefined;
    res.status(200).json(filterByCity(supplier, city));
  });

  return router;
}
