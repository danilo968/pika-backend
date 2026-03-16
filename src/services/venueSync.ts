import { query } from '../config/database';
import { upsertVenueById } from './typesenseService';

// ── Types ─────────────────────────────────────────────────────────
interface OverpassElement {
  id: number;
  type: 'node' | 'way';
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

interface ProcessedVenue {
  name: string;
  description: string | null;
  lat: number;
  lon: number;
  address: string | null;
  city: string;
  country: string;
  categorySlug: string;
  cuisine: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  openingHours: string | null;
  osmId: number;
}

// ── All 37 cities (Kosovo + Albania) ──────────────────────────────
const CITIES = [
  // Kosovo
  { name: 'Prishtina', country: 'Kosovo', lat: 42.6629, lon: 21.1655, radius: 12000 },
  { name: 'Prizren', country: 'Kosovo', lat: 42.2139, lon: 20.7397, radius: 8000 },
  { name: 'Peja', country: 'Kosovo', lat: 42.6593, lon: 20.2883, radius: 8000 },
  { name: 'Gjakova', country: 'Kosovo', lat: 42.3803, lon: 20.4308, radius: 7000 },
  { name: 'Mitrovica', country: 'Kosovo', lat: 42.8914, lon: 20.8660, radius: 7000 },
  { name: 'Ferizaj', country: 'Kosovo', lat: 42.3702, lon: 21.1553, radius: 7000 },
  { name: 'Gjilan', country: 'Kosovo', lat: 42.4636, lon: 21.4694, radius: 7000 },
  { name: 'Vushtrri', country: 'Kosovo', lat: 42.8231, lon: 20.9675, radius: 5000 },
  { name: 'Podujeva', country: 'Kosovo', lat: 42.9108, lon: 21.1900, radius: 5000 },
  { name: 'Suhareka', country: 'Kosovo', lat: 42.3592, lon: 20.8256, radius: 5000 },
  { name: 'Rahovec', country: 'Kosovo', lat: 42.3986, lon: 20.6547, radius: 5000 },
  { name: 'Drenas', country: 'Kosovo', lat: 42.6264, lon: 20.8894, radius: 5000 },
  { name: 'Lipjan', country: 'Kosovo', lat: 42.5225, lon: 21.1239, radius: 5000 },
  { name: 'Malisheva', country: 'Kosovo', lat: 42.4833, lon: 20.7417, radius: 5000 },
  { name: 'Kamenica', country: 'Kosovo', lat: 42.5833, lon: 21.5806, radius: 5000 },
  { name: 'Decan', country: 'Kosovo', lat: 42.5394, lon: 20.2883, radius: 5000 },
  { name: 'Istog', country: 'Kosovo', lat: 42.7833, lon: 20.4833, radius: 5000 },
  { name: 'Skenderaj', country: 'Kosovo', lat: 42.7467, lon: 20.7897, radius: 5000 },
  { name: 'Kacanik', country: 'Kosovo', lat: 42.2328, lon: 21.2592, radius: 5000 },
  { name: 'Fushe Kosova', country: 'Kosovo', lat: 42.6342, lon: 21.0961, radius: 5000 },
  { name: 'Obiliq', country: 'Kosovo', lat: 42.6864, lon: 21.0736, radius: 5000 },
  // Albania
  { name: 'Tirana', country: 'Albania', lat: 41.3275, lon: 19.8187, radius: 12000 },
  { name: 'Durres', country: 'Albania', lat: 41.3246, lon: 19.4565, radius: 10000 },
  { name: 'Shkoder', country: 'Albania', lat: 42.0693, lon: 19.5126, radius: 8000 },
  { name: 'Vlore', country: 'Albania', lat: 40.4667, lon: 19.4897, radius: 8000 },
  { name: 'Elbasan', country: 'Albania', lat: 41.1125, lon: 20.0831, radius: 7000 },
  { name: 'Korce', country: 'Albania', lat: 40.6186, lon: 20.7808, radius: 7000 },
  { name: 'Berat', country: 'Albania', lat: 40.7058, lon: 19.9522, radius: 7000 },
  { name: 'Sarande', country: 'Albania', lat: 39.8661, lon: 20.0050, radius: 7000 },
  { name: 'Fier', country: 'Albania', lat: 40.7239, lon: 19.5561, radius: 7000 },
  { name: 'Lushnje', country: 'Albania', lat: 40.9419, lon: 19.7050, radius: 5000 },
  { name: 'Pogradec', country: 'Albania', lat: 40.9025, lon: 20.6525, radius: 5000 },
  { name: 'Kavaje', country: 'Albania', lat: 41.1856, lon: 19.5569, radius: 5000 },
  { name: 'Gjirokaster', country: 'Albania', lat: 40.0758, lon: 20.1389, radius: 6000 },
  { name: 'Lezhe', country: 'Albania', lat: 41.7836, lon: 19.6436, radius: 5000 },
  { name: 'Kukes', country: 'Albania', lat: 42.0767, lon: 20.4228, radius: 5000 },
  { name: 'Permet', country: 'Albania', lat: 40.2336, lon: 20.3514, radius: 5000 },
  { name: 'Ksamil', country: 'Albania', lat: 39.7831, lon: 20.0003, radius: 4000 },
  { name: 'Himara', country: 'Albania', lat: 40.1025, lon: 19.7511, radius: 5000 },
];

// ── City name normalization (OSM has inconsistent names) ──────────
const CITY_NAME_MAP: Record<string, string> = {
  // Kosovo
  'prishtina': 'Prishtina', 'prishtinë': 'Prishtina', 'prishtine': 'Prishtina',
  'prishtin': 'Prishtina', 'prishtinë: kosovë': 'Prishtina',
  'prizren': 'Prizren', 'peja': 'Peja', 'pejë': 'Peja', 'peje': 'Peja',
  'gjakova': 'Gjakova', 'gjakovë': 'Gjakova', 'gjakove': 'Gjakova',
  'mitrovica': 'Mitrovica', 'mitrovicë': 'Mitrovica', 'mitrovic': 'Mitrovica',
  'kosovska mitrovica': 'Mitrovica',
  'severna kosovska mitrovica / mitrovicë veriore': 'Mitrovica',
  'ferizaj': 'Ferizaj', 'gjilan': 'Gjilan',
  'vushtrri': 'Vushtrri', 'vushtrri / vučitrn': 'Vushtrri', 'vushtrria': 'Vushtrri',
  'podujeva': 'Podujeva', 'podujevë': 'Podujeva', 'podujevo': 'Podujeva', 'podujeve': 'Podujeva',
  'suhareka': 'Suhareka', 'suharekë': 'Suhareka', 'suhareke': 'Suhareka',
  'rahovec': 'Rahovec', 'drenas': 'Drenas', 'lipjan': 'Lipjan',
  'malisheva': 'Malisheva', 'kamenica': 'Kamenica', 'kamenicë': 'Kamenica',
  'decan': 'Decan', 'deçan': 'Decan', 'decan, peje': 'Decan',
  'istog': 'Istog', 'skenderaj': 'Skenderaj', 'skënderaj': 'Skenderaj',
  'kacanik': 'Kacanik', 'kaçanik': 'Kacanik',
  'fushe kosova': 'Fushe Kosova', 'fushë kosovë': 'Fushe Kosova', 'fushe kosove': 'Fushe Kosova',
  'obiliq': 'Obiliq',
  'çagllavicë': 'Prishtina', 'graçanicë': 'Prishtina', 'janjevë': 'Lipjan',
  'marigona': 'Prishtina', 'laplje selo': 'Prishtina',
  // Albania
  'tirana': 'Tirana', 'tiranë': 'Tirana', 'tirane': 'Tirana',
  'durres': 'Durres', 'durrës': 'Durres',
  'shkoder': 'Shkoder', 'shkodër': 'Shkoder',
  'vlore': 'Vlore', 'vlorë': 'Vlore',
  'elbasan': 'Elbasan', 'korce': 'Korce', 'korçë': 'Korce',
  'berat': 'Berat', 'sarande': 'Sarande', 'sarandë': 'Sarande',
  'fier': 'Fier', 'lushnje': 'Lushnje', 'lushnjë': 'Lushnje',
  'pogradec': 'Pogradec', 'kavaje': 'Kavaje', 'kavaja': 'Kavaje',
  'gjirokaster': 'Gjirokaster', 'gjirokastër': 'Gjirokaster',
  'lezhe': 'Lezhe', 'lezhë': 'Lezhe',
  'kukes': 'Kukes', 'kukës': 'Kukes',
  'permet': 'Permet', 'përmet': 'Permet',
  'ksamil': 'Ksamil', 'himara': 'Himara', 'himarë': 'Himara',
  'kamëz': 'Tirana', 'kamez': 'Tirana', 'kashar': 'Tirana', 'vaqarr': 'Tirana',
  'paskuqan': 'Tirana', 'yzberisht': 'Tirana',
  'shiroke': 'Shkoder', 'golem': 'Durres', 'xhafzotaj': 'Durres',
  'shëngjin': 'Lezhe',
};

function normalizeCity(rawCity: string | undefined, fallbackCity: string): string {
  if (!rawCity) return fallbackCity;
  const key = rawCity.toLowerCase().trim();
  return CITY_NAME_MAP[key] || fallbackCity;
}

// ── OSM amenity -> Pika category mapping ──────────────────────────
const AMENITY_TO_CATEGORY: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  bar: 'bar',
  pub: 'pub',
  fast_food: 'fast_food',
  nightclub: 'nightclub',
  ice_cream: 'ice_cream',
  bakery: 'bakery',
  biergarten: 'brewery',
  beer_garden: 'brewery',
  food_court: 'restaurant',
  confectionery: 'dessert',
  coworking_space: 'coworking_space',
};

const AMENITY_TYPES = Object.keys(AMENITY_TO_CATEGORY);

// ── Cuisine-based category refinement ─────────────────────────────
function refineCategoryByCuisine(baseSlug: string, cuisineTag: string | null, name: string): string {
  const c = (cuisineTag || name || '').toLowerCase();

  if (/\bpizza\b/.test(c)) return 'pizza';
  if (/\bsushi\b|\bjapanese\b/.test(c)) return 'sushi';
  if (/\bsteak\b|\bgrill\b/.test(c) && baseSlug === 'restaurant') return 'steakhouse';
  if (/\bseafood\b|\bfish\b/.test(c)) return 'seafood';
  if (/\bvegan\b|\bvegetarian\b/.test(c)) return 'vegan';
  if (/\bice.?cream\b|\bdessert\b|\bpastry\b|\bcake\b/.test(c)) return 'dessert';
  if (/\bstreet.?food\b/.test(c)) return 'street_food';
  if (/\bwine\b/.test(c) && baseSlug === 'bar') return 'wine_bar';
  if (/\bcocktail\b/.test(c) && baseSlug === 'bar') return 'cocktail_bar';
  if (/\bbrewery\b|\bbeer\b|\bcraft\b/.test(c) && baseSlug === 'bar') return 'brewery';
  if (/\bhookah\b|\bshisha\b|\bnargile\b/.test(c)) return 'hookah';
  if (/\bbuffet\b/.test(c)) return 'buffet';
  if (/\bfine.?dining\b/.test(c)) return 'fine_dining';
  if (/\bbrunch\b|\bbreakfast\b/.test(c) && baseSlug === 'cafe') return 'brunch_spot';

  return baseSlug;
}

// ── Overpass API endpoints (failover) ─────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// ── Fetch venues from Overpass (nodes + ways) ─────────────────────
async function fetchOverpassVenues(
  lat: number, lon: number, radius: number, cityName: string
): Promise<OverpassElement[]> {
  const amenityRegex = AMENITY_TYPES.join('|');
  const overpassQuery = `[out:json][timeout:60];
(
  node["amenity"~"^(${amenityRegex})$"](around:${radius},${lat},${lon});
  way["amenity"~"^(${amenityRegex})$"](around:${radius},${lat},${lon});
  node["shop"="bakery"](around:${radius},${lat},${lon});
  way["shop"="bakery"](around:${radius},${lat},${lon});
  node["shop"="coffee"](around:${radius},${lat},${lon});
  way["shop"="coffee"](around:${radius},${lat},${lon});
  node["shop"="pastry"](around:${radius},${lat},${lon});
  way["shop"="pastry"](around:${radius},${lat},${lon});
  node["shop"="confectionery"](around:${radius},${lat},${lon});
  way["shop"="confectionery"](around:${radius},${lat},${lon});
  node["tourism"="hotel"](around:${radius},${lat},${lon});
  way["tourism"="hotel"](around:${radius},${lat},${lon});
  node["tourism"="guest_house"](around:${radius},${lat},${lon});
  way["tourism"="guest_house"](around:${radius},${lat},${lon});
);
out center body;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      const res = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(overpassQuery)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`  ${endpoint} returned ${res.status} for ${cityName}, trying next...`);
        continue;
      }

      const data = await res.json() as { elements?: OverpassElement[] };
      const elements = data.elements || [];
      console.log(`  Fetched ${elements.length} elements from OSM for ${cityName}`);
      return elements;
    } catch (err: any) {
      console.warn(`  ${endpoint} failed for ${cityName}: ${err.message}`);
      continue;
    }
  }

  console.error(`  ALL Overpass endpoints failed for ${cityName}`);
  return [];
}

// ── Process element into venue data ───────────────────────────────
function processElement(el: OverpassElement, cityName: string, country: string): ProcessedVenue | null {
  const tags = el.tags || {};
  const name = tags.name?.trim();
  if (!name) return null;

  const lat = el.lat || el.center?.lat;
  const lon = el.lon || el.center?.lon;
  if (!lat || !lon) return null;

  // Determine category from amenity/shop/tourism/leisure
  const amenity = tags.amenity || tags.shop || tags.tourism || tags.leisure || 'restaurant';

  // Map to Pika category
  let baseCategory: string;
  if (tags.tourism === 'hotel') baseCategory = 'hotel';
  else if (tags.tourism === 'guest_house') baseCategory = 'hotel';
  else if (tags.shop === 'coffee') baseCategory = 'cafe';
  else if (tags.shop === 'pastry' || tags.shop === 'confectionery') baseCategory = 'dessert';
  else baseCategory = AMENITY_TO_CATEGORY[amenity] || 'restaurant';

  const cuisine = tags.cuisine?.replace(/;/g, ', ') || null;
  const categorySlug = refineCategoryByCuisine(baseCategory, cuisine, name);

  // Build address
  const street = tags['addr:street'];
  const houseNumber = tags['addr:housenumber'];
  let address: string | null = null;
  if (street) {
    address = houseNumber ? `${street} ${houseNumber}` : street;
  }

  return {
    name,
    description: tags.description || tags['description:en'] || null,
    lat,
    lon,
    address,
    city: normalizeCity(tags['addr:city'], cityName),
    country,
    categorySlug,
    cuisine,
    phone: tags.phone || tags['contact:phone'] || null,
    email: tags.email || tags['contact:email'] || null,
    website: tags.website || tags['contact:website'] || null,
    openingHours: tags.opening_hours || null,
    osmId: el.id,
  };
}

// ── Deduplicate by name+proximity (<100m) ─────────────────────────
function deduplicateVenues(venues: ProcessedVenue[]): ProcessedVenue[] {
  const seen = new Map<string, { lat: number; lon: number }>();
  return venues.filter(v => {
    const key = v.name.toLowerCase().trim();
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      const dLat = Math.abs(v.lat - existing.lat);
      const dLon = Math.abs(v.lon - existing.lon);
      if (dLat < 0.001 && dLon < 0.001) return false;
    }
    seen.set(key, { lat: v.lat, lon: v.lon });
    return true;
  });
}

// ── Sleep helper for rate limiting ────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════════
// MAIN SYNC: Insert new + Update unclaimed venues
// ══════════════════════════════════════════════════════════════════
export async function syncAllVenues(): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
  cities: number;
}> {
  console.log(`\n====================================`);
  console.log(`  Pika Venue Sync - ${new Date().toISOString()}`);
  console.log(`  ${CITIES.length} cities across Kosovo & Albania`);
  console.log(`====================================\n`);

  // Pre-fetch all category slugs
  const catResult = await query('SELECT id, slug FROM venue_categories');
  const categoryMap = new Map<string, string>();
  for (const row of catResult.rows) {
    categoryMap.set(row.slug, row.id);
  }

  // Pre-fetch all claimed venue IDs (venues with an active business profile)
  const claimedResult = await query(
    `SELECT DISTINCT venue_id FROM business_profiles WHERE venue_id IS NOT NULL AND status != 'rejected'`
  );
  const claimedVenueIds = new Set(claimedResult.rows.map(r => r.venue_id));

  // Pre-fetch all existing overpass_node_ids with their venue IDs
  const existingResult = await query(
    'SELECT id, overpass_node_id FROM venues WHERE overpass_node_id IS NOT NULL'
  );
  const existingByOsmId = new Map<number, string>();
  for (const row of existingResult.rows) {
    existingByOsmId.set(Number(row.overpass_node_id), row.id);
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalVenues = 0;
  const globalDedup = new Set<number>(); // OSM ID dedup across cities

  for (let i = 0; i < CITIES.length; i++) {
    const city = CITIES[i];
    console.log(`[${i + 1}/${CITIES.length}] ${city.name}, ${city.country} (radius: ${city.radius}m)`);

    const elements = await fetchOverpassVenues(city.lat, city.lon, city.radius, city.name);

    let cityVenues: ProcessedVenue[] = [];
    for (const el of elements) {
      if (globalDedup.has(el.id)) continue;
      globalDedup.add(el.id);

      const venue = processElement(el, city.name, city.country);
      if (venue) cityVenues.push(venue);
    }

    // Deduplicate within city
    cityVenues = deduplicateVenues(cityVenues);
    totalVenues += cityVenues.length;

    for (const v of cityVenues) {
      const categoryId = categoryMap.get(v.categorySlug) || categoryMap.get('restaurant') || null;
      const existingVenueId = existingByOsmId.get(v.osmId);

      if (existingVenueId) {
        // Venue already exists — update it ONLY if unclaimed
        if (claimedVenueIds.has(existingVenueId)) {
          totalSkipped++;
          continue;
        }

        // Update unclaimed venue with fresh OSM data
        await query(
          `UPDATE venues SET
            name = $1,
            address = COALESCE($2, address),
            city = $3,
            country = $4,
            phone = COALESCE($5, phone),
            email = COALESCE($6, email),
            website = COALESCE($7, website),
            category_id = COALESCE($8, category_id),
            cuisine = COALESCE($9, cuisine),
            opening_hours = COALESCE($10, opening_hours),
            updated_at = NOW()
          WHERE id = $11`,
          [
            v.name,
            v.address,
            v.city,
            v.country,
            v.phone,
            v.email,
            v.website,
            categoryId,
            v.cuisine,
            v.openingHours ? JSON.stringify({ raw: v.openingHours }) : null,
            existingVenueId,
          ]
        );

        // Re-index in Typesense
        upsertVenueById(existingVenueId).catch((err) => {
          console.error('Typesense re-index failed:', err.message);
        });

        totalUpdated++;
      } else {
        // New venue — insert it
        const insertResult = await query(
          `INSERT INTO venues (name, description, location, address, city, country, phone, email, website,
            category_id, cuisine, opening_hours, overpass_node_id)
           VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (overpass_node_id) DO NOTHING
           RETURNING id`,
          [
            v.name,
            v.description,
            v.lon, v.lat,
            v.address,
            v.city,
            v.country,
            v.phone,
            v.email,
            v.website,
            categoryId,
            v.cuisine,
            v.openingHours ? JSON.stringify({ raw: v.openingHours }) : null,
            v.osmId,
          ]
        );

        if (insertResult.rows.length > 0) {
          upsertVenueById(insertResult.rows[0].id).catch((err) => {
            console.error('Typesense index failed:', err.message);
          });
          totalInserted++;
        } else {
          totalSkipped++;
        }
      }
    }

    console.log(`  Processed: ${cityVenues.length} venues`);

    // Rate limit: 3s between cities
    if (i < CITIES.length - 1) {
      await sleep(3000);
    }
  }

  const summary = {
    inserted: totalInserted,
    updated: totalUpdated,
    skipped: totalSkipped,
    total: totalVenues,
    cities: CITIES.length,
  };

  console.log(`\n====================================`);
  console.log(`  Sync Complete`);
  console.log(`  Inserted: ${summary.inserted}`);
  console.log(`  Updated (unclaimed): ${summary.updated}`);
  console.log(`  Skipped (claimed/dup): ${summary.skipped}`);
  console.log(`  Total processed: ${summary.total}`);
  console.log(`====================================\n`);

  return summary;
}

// ── Single-city sync (for manual use) ─────────────────────────────
export async function syncVenues(lat: number, lon: number, radius: number = 5000, city?: string) {
  console.log(`Syncing venues at (${lat}, ${lon}) radius=${radius}m...`);

  const elements = await fetchOverpassVenues(lat, lon, radius, city || 'Unknown');
  console.log(`Fetched ${elements.length} elements from Overpass`);

  if (elements.length === 0) return { inserted: 0, skipped: 0, total: 0 };

  // Pre-fetch existing
  const overpassIds = elements.map(el => el.id);
  const existingResult = await query(
    'SELECT overpass_node_id FROM venues WHERE overpass_node_id = ANY($1::bigint[])',
    [overpassIds]
  );
  const existingNodeIds = new Set(existingResult.rows.map(r => Number(r.overpass_node_id)));

  const catResult = await query('SELECT id, slug FROM venue_categories');
  const categoryMap = new Map<string, string>();
  for (const row of catResult.rows) {
    categoryMap.set(row.slug, row.id);
  }

  let inserted = 0;
  let skipped = 0;

  for (const el of elements) {
    const venue = processElement(el, city || 'Unknown', 'Unknown');
    if (!venue) { skipped++; continue; }

    if (existingNodeIds.has(venue.osmId)) { skipped++; continue; }

    const categoryId = categoryMap.get(venue.categorySlug) || categoryMap.get('restaurant') || null;

    const insertResult = await query(
      `INSERT INTO venues (name, location, address, city, country, phone, email, website,
        category_id, cuisine, opening_hours, overpass_node_id)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (overpass_node_id) DO NOTHING
       RETURNING id`,
      [
        venue.name,
        venue.lon, venue.lat,
        venue.address,
        venue.city,
        venue.country,
        venue.phone,
        venue.email,
        venue.website,
        categoryId,
        venue.cuisine,
        venue.openingHours ? JSON.stringify({ raw: venue.openingHours }) : null,
        venue.osmId,
      ]
    );

    if (insertResult.rows.length > 0) {
      upsertVenueById(insertResult.rows[0].id).catch((err) => {
        console.error('Typesense index after venue sync failed:', err);
      });
    }
    inserted++;
  }

  console.log(`Sync complete: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped, total: elements.length };
}

// ── CLI entry point ───────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    // Full sync of all 37 cities
    syncAllVenues()
      .then((result) => {
        console.log('Done:', result);
        process.exit(0);
      })
      .catch((err) => {
        console.error('Sync failed:', err);
        process.exit(1);
      });
  } else {
    const cityArg = args.find(a => a.startsWith('--city='))?.split('=')[1];
    const radiusArg = args.find(a => a.startsWith('--radius='))?.split('=')[1];

    const cityConfig = CITIES.find(c => c.name === cityArg) || CITIES[0];
    const radius = radiusArg ? (parseInt(radiusArg) || 5000) : cityConfig.radius;

    syncVenues(cityConfig.lat, cityConfig.lon, radius, cityConfig.name)
      .then((result) => {
        console.log('Done:', result);
        process.exit(0);
      })
      .catch((err) => {
        console.error('Sync failed:', err);
        process.exit(1);
      });
  }
}
