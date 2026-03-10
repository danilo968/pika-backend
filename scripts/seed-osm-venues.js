#!/usr/bin/env node

/**
 * OSM Venue Seeder for Pika
 *
 * Fetches real-world venues from OpenStreetMap (Overpass API) for cities
 * across Kosovo and Albania, then generates a SQL migration file to insert
 * them into the Pika production database.
 *
 * Usage: node scripts/seed-osm-venues.js
 * Output: migrations/023_seed_osm_venues.sql
 */

const fs = require('fs');
const path = require('path');

// ── Cities to seed ──────────────────────────────────────────────
const CITIES = [
  // Kosovo
  { name: 'Prishtina', country: 'Kosovo', lat: 42.6629, lng: 21.1655, radius: 12000 },
  { name: 'Prizren', country: 'Kosovo', lat: 42.2139, lng: 20.7397, radius: 8000 },
  { name: 'Peja', country: 'Kosovo', lat: 42.6593, lng: 20.2883, radius: 8000 },
  { name: 'Gjakova', country: 'Kosovo', lat: 42.3803, lng: 20.4308, radius: 7000 },
  { name: 'Mitrovica', country: 'Kosovo', lat: 42.8914, lng: 20.8660, radius: 7000 },
  { name: 'Ferizaj', country: 'Kosovo', lat: 42.3702, lng: 21.1553, radius: 7000 },
  { name: 'Gjilan', country: 'Kosovo', lat: 42.4636, lng: 21.4694, radius: 7000 },
  { name: 'Vushtrri', country: 'Kosovo', lat: 42.8231, lng: 20.9675, radius: 5000 },
  { name: 'Podujeva', country: 'Kosovo', lat: 42.9108, lng: 21.1900, radius: 5000 },
  { name: 'Suhareka', country: 'Kosovo', lat: 42.3592, lng: 20.8256, radius: 5000 },
  { name: 'Rahovec', country: 'Kosovo', lat: 42.3986, lng: 20.6547, radius: 5000 },
  { name: 'Drenas', country: 'Kosovo', lat: 42.6264, lng: 20.8894, radius: 5000 },
  { name: 'Lipjan', country: 'Kosovo', lat: 42.5225, lng: 21.1239, radius: 5000 },
  { name: 'Malisheva', country: 'Kosovo', lat: 42.4833, lng: 20.7417, radius: 5000 },
  { name: 'Kamenica', country: 'Kosovo', lat: 42.5833, lng: 21.5806, radius: 5000 },
  { name: 'Decan', country: 'Kosovo', lat: 42.5394, lng: 20.2883, radius: 5000 },
  { name: 'Istog', country: 'Kosovo', lat: 42.7833, lng: 20.4833, radius: 5000 },
  { name: 'Skenderaj', country: 'Kosovo', lat: 42.7467, lng: 20.7897, radius: 5000 },
  { name: 'Kacanik', country: 'Kosovo', lat: 42.2328, lng: 21.2592, radius: 5000 },
  { name: 'Fushe Kosova', country: 'Kosovo', lat: 42.6342, lng: 21.0961, radius: 5000 },
  { name: 'Obiliq', country: 'Kosovo', lat: 42.6864, lng: 21.0736, radius: 5000 },
  // Albania
  { name: 'Tirana', country: 'Albania', lat: 41.3275, lng: 19.8187, radius: 12000 },
  { name: 'Durres', country: 'Albania', lat: 41.3246, lng: 19.4565, radius: 10000 },
  { name: 'Shkoder', country: 'Albania', lat: 42.0693, lng: 19.5126, radius: 8000 },
  { name: 'Vlore', country: 'Albania', lat: 40.4667, lng: 19.4897, radius: 8000 },
  { name: 'Elbasan', country: 'Albania', lat: 41.1125, lng: 20.0831, radius: 7000 },
  { name: 'Korce', country: 'Albania', lat: 40.6186, lng: 20.7808, radius: 7000 },
  { name: 'Berat', country: 'Albania', lat: 40.7058, lng: 19.9522, radius: 7000 },
  { name: 'Sarande', country: 'Albania', lat: 39.8661, lng: 20.0050, radius: 7000 },
  { name: 'Fier', country: 'Albania', lat: 40.7239, lng: 19.5561, radius: 7000 },
  { name: 'Lushnje', country: 'Albania', lat: 40.9419, lng: 19.7050, radius: 5000 },
  { name: 'Pogradec', country: 'Albania', lat: 40.9025, lng: 20.6525, radius: 5000 },
  { name: 'Kavaje', country: 'Albania', lat: 41.1856, lng: 19.5569, radius: 5000 },
  { name: 'Gjirokaster', country: 'Albania', lat: 40.0758, lng: 20.1389, radius: 6000 },
  { name: 'Lezhe', country: 'Albania', lat: 41.7836, lng: 19.6436, radius: 5000 },
  { name: 'Kukes', country: 'Albania', lat: 42.0767, lng: 20.4228, radius: 5000 },
  { name: 'Permet', country: 'Albania', lat: 40.2336, lng: 20.3514, radius: 5000 },
  { name: 'Ksamil', country: 'Albania', lat: 39.7831, lng: 20.0003, radius: 4000 },
  { name: 'Himara', country: 'Albania', lat: 40.1025, lng: 19.7511, radius: 5000 },
];

// ── City name normalization ──────────────────────────────────────
// OSM has inconsistent city names (Prishtinë, Prishtina, prishtine, etc.)
// Normalize to a single canonical English spelling
const CITY_NAME_MAP = {
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
  'skedneraj': 'Skenderaj', 'kacanik': 'Kacanik', 'kaçanik': 'Kacanik',
  'fushe kosova': 'Fushe Kosova', 'fushë kosovë': 'Fushe Kosova', 'fushe kosove': 'Fushe Kosova',
  'obiliq': 'Obiliq', 'novoberdo': 'Novoberdo',
  'çagllavicë': 'Prishtina', 'çagllavicë (prishtinë)': 'Prishtina',
  'graçanicë': 'Prishtina', 'janjevë': 'Lipjan',
  'marigona': 'Prishtina', 'laplje selo': 'Prishtina',
  // Albania
  'tirana': 'Tirana', 'tiranë': 'Tirana', 'tirane': 'Tirana',
  'durres': 'Durres', 'durrës': 'Durres',
  'shkoder': 'Shkoder', 'shkodër': 'Shkoder',
  'vlore': 'Vlore', 'vlorë': 'Vlore',
  'elbasan': 'Elbasan', 'korce': 'Korce', 'korçë': 'Korce',
  'berat': 'Berat', 'sarande': 'Sarande', 'sarandë': 'Sarande',
  'fier': 'Fier', 'lushnje': 'Lushnje', 'lushnj': 'Lushnje', 'lushnjë': 'Lushnje',
  'pogradec': 'Pogradec', 'kavaje': 'Kavaje', 'kavaja': 'Kavaje',
  'gjirokaster': 'Gjirokaster', 'gjirokastër': 'Gjirokaster',
  'lezhe': 'Lezhe', 'lezhë': 'Lezhe',
  'kukes': 'Kukes', 'kukës': 'Kukes',
  'permet': 'Permet', 'përmet': 'Permet',
  'ksamil': 'Ksamil', 'himara': 'Himara', 'himarë': 'Himara', 'himare': 'Himara',
  'kamëz': 'Tirana', 'kamez': 'Tirana', 'kashar': 'Tirana', 'vaqarr': 'Tirana',
  'paskuqan': 'Tirana', 'yzberisht': 'Tirana', 'petrele': 'Tirana',
  'zall-herr': 'Tirana', 'baldushk, tiranë': 'Tirana', 'daias , tirane': 'Tirana',
  'daias': 'Tirana', 'shiroke': 'Shkoder', 'shirokë': 'Shkoder',
  'shtoj i ri': 'Shkoder', 'zogej': 'Shkoder',
  'golem': 'Durres', 'xhafzotaj': 'Durres',
  'shëngjin': 'Lezhe', 'balldren': 'Lezhe',
  'synej': 'Fier',
};

function normalizeCity(rawCity, fallbackCity) {
  if (!rawCity) return fallbackCity;
  const key = rawCity.toLowerCase().trim();
  return CITY_NAME_MAP[key] || fallbackCity;
}

// ── OSM amenity → Pika category slug mapping ────────────────────
const AMENITY_TO_CATEGORY = {
  restaurant: 'restaurant',
  cafe: 'cafe',
  bar: 'bar',
  pub: 'pub',
  fast_food: 'fast_food',
  ice_cream: 'ice_cream',
  nightclub: 'nightclub',
  bakery: 'bakery',
  biergarten: 'brewery',
  beer_garden: 'brewery',
  food_court: 'restaurant',
  confectionery: 'dessert',
};

// ── Cuisine → specialty category overrides ──────────────────────
// If a venue's cuisine tag matches, override category
function refineCategoryByCuisine(baseSlug, cuisineTag) {
  if (!cuisineTag) return baseSlug;
  const c = cuisineTag.toLowerCase();

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

// ── Overpass API query builder ───────────────────────────────────
const AMENITY_TYPES = Object.keys(AMENITY_TO_CATEGORY).join('|');

function buildOverpassQuery(lat, lng, radius) {
  return `[out:json][timeout:60];
(
  node["amenity"~"^(${AMENITY_TYPES})$"](around:${radius},${lat},${lng});
  way["amenity"~"^(${AMENITY_TYPES})$"](around:${radius},${lat},${lng});
);
out center body;`;
}

// ── Overpass API fetcher with retries ────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOverpass(query, cityName) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`  Fetching from ${endpoint}...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`  ${endpoint} returned ${response.status}, trying next...`);
        continue;
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.elements)) {
        console.warn(`  ${endpoint} returned invalid data`);
        continue;
      }

      console.log(`  Got ${data.elements.length} raw elements from OSM for ${cityName}`);
      return data.elements;
    } catch (err) {
      console.warn(`  ${endpoint} failed: ${err.message}`);
      continue;
    }
  }
  console.error(`  ALL Overpass endpoints failed for ${cityName}`);
  return [];
}

// ── SQL escaping ─────────────────────────────────────────────────
function sqlEscape(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''").replace(/\\/g, '\\\\').trim() + "'";
}

function sqlEscapeOrNull(str) {
  if (!str || !str.trim()) return 'NULL';
  return sqlEscape(str.trim());
}

// ── Parse OSM opening hours into JSONB ───────────────────────────
function parseOpeningHours(raw) {
  if (!raw) return 'NULL';
  // Store as JSONB with the raw string — the frontend already handles { raw: "..." }
  return sqlEscape(JSON.stringify({ raw: raw }));
}

// ── Process a single OSM element into venue data ─────────────────
function processElement(el, city) {
  const tags = el.tags || {};
  if (!tags.name) return null; // Skip unnamed venues

  const amenity = tags.amenity || 'restaurant';
  const baseCategory = AMENITY_TO_CATEGORY[amenity];
  if (!baseCategory) return null;

  const lat = el.lat || el.center?.lat;
  const lng = el.lon || el.center?.lon;
  if (!lat || !lng) return null;

  const cuisine = tags.cuisine?.replace(/;/g, ', ') || null;
  const categorySlug = refineCategoryByCuisine(baseCategory, cuisine || tags.name);

  // Build address from OSM tags
  const street = tags['addr:street'];
  const houseNumber = tags['addr:housenumber'];
  let address = null;
  if (street) {
    address = houseNumber ? `${street} ${houseNumber}` : street;
  }

  // Phone: normalize
  const phone = tags.phone || tags['contact:phone'] || null;
  const email = tags.email || tags['contact:email'] || null;
  const website = tags.website || tags['contact:website'] || null;

  // Description from OSM
  const description = tags.description || tags['description:en'] || null;

  // Overpass node/way ID for deduplication
  const osmId = el.id;
  const osmType = el.type; // 'node' or 'way'

  return {
    name: tags.name.trim(),
    description,
    lat,
    lng,
    address,
    city: normalizeCity(tags['addr:city'], city.name),
    country: city.country,
    categorySlug,
    cuisine,
    phone,
    email,
    website,
    openingHours: tags.opening_hours,
    osmId,
    osmType,
  };
}

// ── Deduplicate venues by name+proximity ─────────────────────────
function deduplicateVenues(venues) {
  const seen = new Map(); // key: lowercased name -> { lat, lng }

  return venues.filter(v => {
    const key = v.name.toLowerCase().trim();
    if (seen.has(key)) {
      // Check if within ~100m (roughly 0.001 degrees)
      const existing = seen.get(key);
      const dLat = Math.abs(v.lat - existing.lat);
      const dLng = Math.abs(v.lng - existing.lng);
      if (dLat < 0.001 && dLng < 0.001) {
        return false; // Duplicate
      }
    }
    seen.set(key, { lat: v.lat, lng: v.lng });
    return true;
  });
}

// ── Generate SQL migration ───────────────────────────────────────
function generateSQL(allVenues) {
  const lines = [];
  lines.push('-- Migration: 023_seed_osm_venues.sql');
  lines.push('-- Generated by scripts/seed-osm-venues.js');
  lines.push(`-- Date: ${new Date().toISOString()}`);
  lines.push(`-- Total venues: ${allVenues.length}`);
  lines.push('-- Source: OpenStreetMap via Overpass API');
  lines.push('');
  lines.push('-- This migration inserts real-world venues from OpenStreetMap.');
  lines.push('-- Uses overpass_node_id for deduplication to avoid re-inserting existing OSM venues.');
  lines.push('-- Existing manually-added venues (from 019) are preserved via ON CONFLICT DO NOTHING.');
  lines.push('');
  lines.push('-- NOTE: The migration runner wraps this in a transaction automatically.');
  lines.push('');

  // Group venues by city for readability
  const byCity = {};
  for (const v of allVenues) {
    const key = `${v.city}, ${v.country}`;
    if (!byCity[key]) byCity[key] = [];
    byCity[key].push(v);
  }

  for (const [cityKey, venues] of Object.entries(byCity)) {
    lines.push(`-- ═══════════════════════════════════════════════════`);
    lines.push(`-- ${cityKey} (${venues.length} venues)`);
    lines.push(`-- ═══════════════════════════════════════════════════`);
    lines.push('');

    // Batch insert using VALUES + JOIN pattern (same as migration 019)
    // Split into batches of 50 to avoid overly long queries
    const batchSize = 50;
    for (let i = 0; i < venues.length; i += batchSize) {
      const batch = venues.slice(i, i + batchSize);

      lines.push('INSERT INTO venues (');
      lines.push('  name, description, location, address, city, country,');
      lines.push('  category_id, cuisine, phone, email, website,');
      lines.push('  opening_hours, overpass_node_id,');
      lines.push('  is_active, is_verified, is_featured,');
      lines.push('  ku_rating_avg, ku_rating_count, google_rating, google_rating_count');
      lines.push(')');
      lines.push('SELECT');
      lines.push('  v.name, v.description,');
      lines.push('  ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,');
      lines.push('  v.address, v.city, v.country,');
      lines.push('  vc.id, v.cuisine, v.phone, v.email, v.website,');
      lines.push('  v.opening_hours::jsonb, v.osm_id,');
      lines.push('  true, false, false,');
      lines.push('  0, 0, NULL, NULL');
      lines.push('FROM (VALUES');

      const valueRows = batch.map((v, idx) => {
        const row = [
          sqlEscape(v.name),
          sqlEscapeOrNull(v.description),
          v.lng.toFixed(6),
          v.lat.toFixed(6),
          sqlEscapeOrNull(v.address),
          sqlEscape(v.city),
          sqlEscape(v.country),
          sqlEscape(v.categorySlug),
          sqlEscapeOrNull(v.cuisine),
          sqlEscapeOrNull(v.phone),
          sqlEscapeOrNull(v.email),
          sqlEscapeOrNull(v.website),
          parseOpeningHours(v.openingHours),
          v.osmId,
        ].join(', ');

        const comma = idx < batch.length - 1 ? ',' : '';
        return `  (${row})${comma}`;
      });

      lines.push(...valueRows);
      lines.push(') AS v(name, description, lng, lat, address, city, country, cat_slug, cuisine, phone, email, website, opening_hours, osm_id)');
      lines.push('JOIN venue_categories vc ON vc.slug = v.cat_slug');
      lines.push('ON CONFLICT DO NOTHING;');
      lines.push('');
    }
  }

  // Summary comment
  lines.push('-- ═══════════════════════════════════════════════════');
  lines.push('-- SEED SUMMARY');
  lines.push('-- ═══════════════════════════════════════════════════');
  for (const [cityKey, venues] of Object.entries(byCity)) {
    lines.push(`-- ${cityKey}: ${venues.length} venues`);
  }
  lines.push(`-- TOTAL: ${allVenues.length} venues`);

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Pika OSM Venue Seeder');
  console.log('========================');
  console.log(`Fetching venues for ${CITIES.length} cities across Kosovo & Albania\n`);

  let allVenues = [];
  const globalDedup = new Set(); // OSM ID dedup across cities

  for (let i = 0; i < CITIES.length; i++) {
    const city = CITIES[i];
    console.log(`\n[${i + 1}/${CITIES.length}] ${city.name}, ${city.country} (radius: ${city.radius}m)`);

    const query = buildOverpassQuery(city.lat, city.lng, city.radius);
    const elements = await fetchOverpass(query, city.name);

    let cityVenues = [];
    for (const el of elements) {
      // Skip if we've already seen this OSM ID from another city's overlap
      if (globalDedup.has(el.id)) continue;
      globalDedup.add(el.id);

      const venue = processElement(el, city);
      if (venue) cityVenues.push(venue);
    }

    // Deduplicate within city by name+proximity
    cityVenues = deduplicateVenues(cityVenues);
    console.log(`  Processed: ${cityVenues.length} named venues`);

    allVenues.push(...cityVenues);

    // Rate limit: wait 3s between cities to be nice to Overpass API
    if (i < CITIES.length - 1) {
      console.log('  Waiting 3s before next city...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Final global dedup by name+proximity across all cities
  allVenues = deduplicateVenues(allVenues);

  console.log(`\n✅ Total unique venues: ${allVenues.length}`);

  // Category breakdown
  const catCounts = {};
  for (const v of allVenues) {
    catCounts[v.categorySlug] = (catCounts[v.categorySlug] || 0) + 1;
  }
  console.log('\nCategory breakdown:');
  for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // City breakdown
  const cityCounts = {};
  for (const v of allVenues) {
    const key = `${v.city}, ${v.country}`;
    cityCounts[key] = (cityCounts[key] || 0) + 1;
  }
  console.log('\nCity breakdown:');
  for (const [city, count] of Object.entries(cityCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${city}: ${count}`);
  }

  // Generate SQL
  const sql = generateSQL(allVenues);
  const outputPath = path.join(__dirname, '..', 'migrations', '023_seed_osm_venues.sql');
  fs.writeFileSync(outputPath, sql, 'utf8');
  console.log(`\n📄 Migration written to: ${outputPath}`);
  console.log(`   File size: ${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
