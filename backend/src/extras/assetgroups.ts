// Fixed-asset groups with the usual Indian depreciation settings.
//  - itRateBp: written-down-value rate in the Income Tax Rules (Appendix I, block of assets), in basis points.
//  - lifeYears: useful life in Part C of Schedule II to the Companies Act 2013 (straight line).
// These are starting points. The user can change the rate or life on each asset. The Income Tax half-rate rule for assets used under 180 days is not applied.
export interface AssetGroup { name: string; itRateBp: number; lifeYears: number; examples: string }

export const ASSET_GROUPS: AssetGroup[] = [
  { name: 'Plant and machinery', itRateBp: 1500, lifeYears: 15, examples: 'Air conditioner, refrigerator, water cooler, generator, machines, CCTV, fans' },
  { name: 'Computers and software', itRateBp: 4000, lifeYears: 3, examples: 'Computer, laptop, printer, scanner, server, accounting software' },
  { name: 'Furniture and fittings', itRateBp: 1000, lifeYears: 10, examples: 'Tables, chairs, cupboards, shelves, electrical fittings' },
  { name: 'Office equipment', itRateBp: 1500, lifeYears: 5, examples: 'Phones, projector, biometric machine, small office appliances' },
  { name: 'Motor cars', itRateBp: 1500, lifeYears: 8, examples: 'Cars and jeeps used for business' },
  { name: 'Motor vehicles on hire', itRateBp: 3000, lifeYears: 6, examples: 'Buses, lorries and taxis run on hire' },
  { name: 'Two wheelers', itRateBp: 1500, lifeYears: 10, examples: 'Motor cycles, scooters' },
  { name: 'Buildings (residential)', itRateBp: 500, lifeYears: 60, examples: 'Residential buildings' },
  { name: 'Buildings (other)', itRateBp: 1000, lifeYears: 30, examples: 'Offices, shops, factory buildings' },
  { name: 'Temporary structures', itRateBp: 4000, lifeYears: 3, examples: 'Wooden structures, sheds' },
  { name: 'Intangible assets', itRateBp: 2500, lifeYears: 10, examples: 'Patents, trademarks, licences, know-how, goodwill' },
  { name: 'Energy saving and pollution control equipment', itRateBp: 4000, lifeYears: 15, examples: 'Solar panels, effluent treatment' },
  { name: 'Books (professional)', itRateBp: 4000, lifeYears: 3, examples: 'Annual publications and books for a profession' },
];
