import { query } from '../config/database';
import { upsertVenueById } from './typesenseService';

interface OverpassVenue {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

const CATEGORY_MAP: Record<string, string> = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  bar: 'bar',
  pub: 'pub',
  fast_food: 'fast_food',
  nightclub: 'nightclub',
  ice_cream: 'ice_cream',
  bakery: 'bakery',
  coworking_space: 'coworking_space',
};

async function fetchOverpassVenues(lat: number, lon: number, radius: number): Promise<OverpassVenue[]> {
  const overpassQuery = `
    [out:json][timeout:30];
    (
      node["amenity"="restaurant"](around:${radius},${lat},${lon});
      node["amenity"="cafe"](around:${radius},${lat},${lon});
      node["amenity"="bar"](around:${radius},${lat},${lon});
      node["amenity"="pub"](around:${radius},${lat},${lon});
      node["amenity"="fast_food"](around:${radius},${lat},${lon});
      node["amenity"="nightclub"](around:${radius},${lat},${lon});
      node["amenity"="ice_cream"](around:${radius},${lat},${lon});
      node["shop"="bakery"](around:${radius},${lat},${lon});
      node["amenity"="coworking_space"](around:${radius},${lat},${lon});
    );
    out body;
  `;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(overpassQuery)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const data: any = await res.json();
  return data.elements || [];
}

function getVenueType(tags: Record<string, string>): string {
  return tags.amenity || tags.shop || 'restaurant';
}

export async function syncVenues(lat: number, lon: number, radius: number = 5000, city?: string) {
  console.log(`Syncing venues at (${lat}, ${lon}) radius=${radius}m...`);

  const overpassVenues = await fetchOverpassVenues(lat, lon, radius);
  console.log(`Fetched ${overpassVenues.length} venues from Overpass`);

  if (overpassVenues.length === 0) return { inserted: 0, skipped: 0, total: 0 };

  // Pre-fetch all existing overpass_node_ids in ONE query (eliminates N queries)
  const overpassIds = overpassVenues.map(ov => ov.id);
  const existingResult = await query(
    'SELECT overpass_node_id FROM venues WHERE overpass_node_id = ANY($1::bigint[])',
    [overpassIds]
  );
  const existingNodeIds = new Set(existingResult.rows.map(r => Number(r.overpass_node_id)));

  // Pre-fetch all category slugs in ONE query (eliminates N queries)
  const catResult = await query('SELECT id, slug FROM venue_categories');
  const categoryMap = new Map<string, string>();
  for (const row of catResult.rows) {
    categoryMap.set(row.slug, row.id);
  }

  let inserted = 0;
  let skipped = 0;

  for (const ov of overpassVenues) {
    const name = ov.tags?.name;
    if (!name) {
      skipped++;
      continue;
    }

    if (existingNodeIds.has(ov.id)) {
      skipped++;
      continue;
    }

    const venueType = getVenueType(ov.tags);
    const categorySlug = CATEGORY_MAP[venueType] || 'restaurant';
    const categoryId = categoryMap.get(categorySlug) || null;

    const insertResult = await query(
      `INSERT INTO venues (name, location, address, city, country, phone, email, website,
        category_id, cuisine, opening_hours, overpass_node_id)
       VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (overpass_node_id) DO NOTHING
       RETURNING id`,
      [
        name,
        ov.lon, ov.lat,
        ov.tags['addr:street'] ? `${ov.tags['addr:street']} ${ov.tags['addr:housenumber'] || ''}`.trim() : null,
        city || ov.tags['addr:city'] || null,
        ov.tags['addr:country'] || null,
        ov.tags.phone || ov.tags['contact:phone'] || null,
        ov.tags.email || ov.tags['contact:email'] || null,
        ov.tags.website || ov.tags['contact:website'] || null,
        categoryId,
        ov.tags.cuisine || null,
        ov.tags.opening_hours ? JSON.stringify({ raw: ov.tags.opening_hours }) : null,
        ov.id,
      ]
    );

    // Index new venue in Typesense
    if (insertResult.rows.length > 0) {
      upsertVenueById(insertResult.rows[0].id).catch((err) => {
        console.error('Typesense index after venue sync failed:', err);
      });
    }

    inserted++;
  }

  console.log(`Sync complete: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped, total: overpassVenues.length };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const cityArg = args.find(a => a.startsWith('--city='))?.split('=')[1];
  const radiusArg = args.find(a => a.startsWith('--radius='))?.split('=')[1];

  // Default coordinates for common cities
  const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
    'Tirana': { lat: 41.3275, lon: 19.8187 },
    'Prishtina': { lat: 42.6629, lon: 21.1655 },
    'Shkoder': { lat: 42.0693, lon: 19.5126 },
    'Durres': { lat: 41.3246, lon: 19.4565 },
    'Vlore': { lat: 40.4667, lon: 19.4833 },
  };

  const city = cityArg || 'Tirana';
  const coords = CITY_COORDS[city] || CITY_COORDS['Tirana'];
  const radius = radiusArg ? (parseInt(radiusArg) || 5000) : 5000;

  syncVenues(coords.lat, coords.lon, radius, city)
    .then((result) => {
      console.log('Done:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}
