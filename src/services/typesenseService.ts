import Typesense from 'typesense';
import { query } from '../config/database';

// ─── Typesense Client ───
const client = new Typesense.Client({
  nodes: [{
    host: process.env.TYPESENSE_HOST || 'localhost',
    port: parseInt(process.env.TYPESENSE_PORT || '8108'),
    protocol: process.env.TYPESENSE_PROTOCOL || 'http',
  }],
  apiKey: process.env.TYPESENSE_API_KEY || 'pika_typesense_dev_key',
  connectionTimeoutSeconds: 5,
});

const COLLECTION_NAME = 'venues';

// ─── Collection Schema ───
const venueSchema = {
  name: COLLECTION_NAME,
  fields: [
    { name: 'name', type: 'string' as const },
    { name: 'description', type: 'string' as const, optional: true },
    { name: 'city', type: 'string' as const, facet: true, optional: true },
    { name: 'cuisine', type: 'string' as const, facet: true, optional: true },
    { name: 'category_name', type: 'string' as const, facet: true, optional: true },
    { name: 'category_slug', type: 'string' as const, facet: true, optional: true },
    { name: 'price_level', type: 'int32' as const, facet: true, optional: true },
    { name: 'ku_rating_avg', type: 'float' as const, optional: true },
    { name: 'ku_rating_count', type: 'int32' as const, optional: true },
    { name: 'is_verified', type: 'bool' as const, optional: true },
    { name: 'is_featured', type: 'bool' as const, optional: true },
    { name: 'cover_image_url', type: 'string' as const, optional: true },
    { name: 'address', type: 'string' as const, optional: true },
    { name: 'location', type: 'geopoint' as const, optional: true },
  ],
  default_sorting_field: 'ku_rating_count',
};

// ─── Ensure Collection Exists ───
export async function ensureCollection(): Promise<void> {
  try {
    await client.collections(COLLECTION_NAME).retrieve();
    console.log('✅ Typesense: venues collection ready');
  } catch (err: any) {
    if (err?.httpStatus === 404) {
      await client.collections().create(venueSchema);
      console.log('✅ Typesense: venues collection created');
    } else {
      throw err;
    }
  }
}

// ─── Document Shape ───
interface VenueDocument {
  id: string;
  name: string;
  description?: string;
  city?: string;
  cuisine?: string;
  category_name?: string;
  category_slug?: string;
  price_level?: number;
  ku_rating_avg?: number;
  ku_rating_count?: number;
  is_verified?: boolean;
  is_featured?: boolean;
  cover_image_url?: string;
  address?: string;
  location?: [number, number]; // [lat, lng]
}

// ─── Upsert Single Venue ───
export async function upsertVenue(venue: VenueDocument): Promise<void> {
  try {
    await client.collections(COLLECTION_NAME).documents().upsert(venue);
  } catch (err) {
    console.error(`Typesense upsert failed for venue ${venue.id}:`, err);
  }
}

// ─── Delete Single Venue ───
export async function deleteVenue(venueId: string): Promise<void> {
  try {
    await client.collections(COLLECTION_NAME).documents(venueId).delete();
  } catch (err) {
    console.error(`Typesense delete failed for venue ${venueId}:`, err);
  }
}

// ─── Build document from a DB row ───
function rowToDocument(row: any): VenueDocument {
  const doc: VenueDocument = {
    id: row.id,
    name: row.name || '',
    description: row.description || undefined,
    city: row.city || undefined,
    cuisine: row.cuisine || undefined,
    category_name: row.category_name || undefined,
    category_slug: row.category_slug || undefined,
    price_level: row.price_level ? parseInt(row.price_level) : undefined,
    ku_rating_avg: row.ku_rating_avg ? parseFloat(row.ku_rating_avg) : 0,
    ku_rating_count: row.ku_rating_count ? parseInt(row.ku_rating_count) : 0,
    is_verified: row.is_verified || false,
    is_featured: row.is_featured || false,
    cover_image_url: row.cover_image_url || undefined,
    address: row.address || undefined,
  };

  // Typesense geopoint: [lat, lng]
  if (row.latitude && row.longitude) {
    doc.location = [parseFloat(row.latitude), parseFloat(row.longitude)];
  }

  return doc;
}

// ─── Bulk Index All Venues ───
export async function bulkIndexVenues(): Promise<number> {
  const result = await query(`
    SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
      v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
      v.ku_rating_avg, v.ku_rating_count,
      ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
      vc.slug as category_slug, vc.name as category_name
    FROM venues v
    LEFT JOIN venue_categories vc ON v.category_id = vc.id
    WHERE v.is_active = true
  `);

  if (result.rows.length === 0) {
    console.log('No venues to index');
    return 0;
  }

  const documents = result.rows.map(rowToDocument);

  try {
    const importResult = await client
      .collections(COLLECTION_NAME)
      .documents()
      .import(documents, { action: 'upsert' });

    const successCount = importResult.filter((r: any) => r.success).length;
    const failCount = importResult.filter((r: any) => !r.success).length;

    if (failCount > 0) {
      console.warn(`Typesense bulk index: ${successCount} ok, ${failCount} failed`);
      importResult
        .filter((r: any) => !r.success)
        .slice(0, 5)
        .forEach((r: any) => console.warn('  Failed:', r.error));
    }

    return successCount;
  } catch (err) {
    console.error('Typesense bulk import error:', err);
    throw err;
  }
}

// ─── Upsert Venue By ID (fetch from DB + send to Typesense) ───
export async function upsertVenueById(venueId: string): Promise<void> {
  const result = await query(`
    SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
      v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
      v.ku_rating_avg, v.ku_rating_count,
      ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
      vc.slug as category_slug, vc.name as category_name
    FROM venues v
    LEFT JOIN venue_categories vc ON v.category_id = vc.id
    WHERE v.id = $1 AND v.is_active = true
  `, [venueId]);

  if (result.rows.length > 0) {
    await upsertVenue(rowToDocument(result.rows[0]));
  }
}

// ─── Search Venues ───
interface SearchParams {
  q: string;
  city?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  page?: number;
  perPage?: number;
}

export async function searchVenues(params: SearchParams) {
  const { q, city, lat, lng, radiusKm, page = 1, perPage = 20 } = params;

  // Build filter_by dynamically
  const filters: string[] = [];
  if (city) {
    filters.push(`city:=${city}`);
  }
  if (lat !== undefined && lng !== undefined && radiusKm) {
    filters.push(`location:(${lat}, ${lng}, ${radiusKm} km)`);
  }

  const searchParams: Record<string, any> = {
    q,
    query_by: 'name,cuisine,city,category_name',
    sort_by: '_text_match:desc,ku_rating_count:desc',
    per_page: perPage,
    page,
    num_typos: 2,
    prefix: true,
  };

  if (filters.length > 0) {
    searchParams.filter_by = filters.join(' && ');
  }

  const result = await client
    .collections(COLLECTION_NAME)
    .documents()
    .search(searchParams);

  // Map Typesense hits back to the venue response shape the mobile app expects
  return (result.hits || []).map((hit: any) => {
    const doc = hit.document;
    return {
      id: doc.id,
      name: doc.name,
      description: doc.description || null,
      address: doc.address || null,
      city: doc.city || null,
      cuisine: doc.cuisine || null,
      price_level: doc.price_level || null,
      cover_image_url: doc.cover_image_url || null,
      is_verified: doc.is_verified || false,
      is_featured: doc.is_featured || false,
      ku_rating_avg: doc.ku_rating_avg || null,
      ku_rating_count: doc.ku_rating_count || 0,
      category_slug: doc.category_slug || null,
      category_name: doc.category_name || null,
      latitude: doc.location ? doc.location[0] : null,
      longitude: doc.location ? doc.location[1] : null,
      // Typesense relevance score
      relevance: hit.text_match || 0,
    };
  });
}

// ─── CLI Entry Point ───
if (require.main === module) {
  require('dotenv').config();

  ensureCollection()
    .then(() => bulkIndexVenues())
    .then((count) => {
      console.log(`✅ Indexed ${count} venues into Typesense`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Typesense index failed:', err);
      process.exit(1);
    });
}
