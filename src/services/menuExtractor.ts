import { query } from '../config/database';

interface ExtractedMenuItem {
  name: string;
  description?: string;
  price?: number;
  currency?: string;
}

interface ExtractedSection {
  name: string;
  items: ExtractedMenuItem[];
}

// Common menu page paths to try
const MENU_PATHS = ['/menu', '/carta', '/speisekarte', '/our-menu', '/food-menu', '/menyu'];

// Price pattern: matches €12.50, $15, 12.50€, 15€, etc.
const PRICE_REGEX = /(?:[$€£])\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:[$€£])/;

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KuBot/1.0; +https://kuapp.com)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    return await response.text();
  } catch {
    return null;
  }
}

function extractMenuFromHTML(html: string): ExtractedSection[] {
  // Simple extraction: look for price patterns near text
  // This is a basic heuristic; production would use cheerio for DOM parsing
  const sections: ExtractedSection[] = [];
  const currentSection: ExtractedSection = { name: 'Menu', items: [] };

  // Split by common delimiters and look for price patterns
  const lines = html
    .replace(/<[^>]*>/g, '\n')     // Strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2 && l.length < 200);

  for (const line of lines) {
    const priceMatch = line.match(PRICE_REGEX);
    if (priceMatch) {
      const priceStr = (priceMatch[1] || priceMatch[2]).replace(',', '.');
      const price = parseFloat(priceStr);
      const name = line.replace(PRICE_REGEX, '').replace(/[.\-–—]/g, '').trim();

      if (name.length > 2 && price > 0 && price < 1000) {
        currentSection.items.push({
          name,
          price,
          currency: 'EUR',
        });
      }
    }
  }

  if (currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

export async function extractMenuForVenue(venueId: string): Promise<ExtractedSection[]> {
  // Get venue website
  const venueResult = await query('SELECT website FROM venues WHERE id = $1', [venueId]);
  if (venueResult.rows.length === 0 || !venueResult.rows[0].website) {
    return [];
  }

  const baseUrl = venueResult.rows[0].website.replace(/\/$/, '');
  let extractedSections: ExtractedSection[] = [];
  let sourceUrl = '';

  // Try menu-specific paths first
  for (const path of MENU_PATHS) {
    const url = `${baseUrl}${path}`;
    const html = await fetchPage(url);
    if (html) {
      const sections = extractMenuFromHTML(html);
      if (sections.length > 0 && sections[0].items.length > 0) {
        extractedSections = sections;
        sourceUrl = url;
        break;
      }
    }
  }

  // If no menu pages worked, try the homepage
  if (extractedSections.length === 0) {
    const html = await fetchPage(baseUrl);
    if (html) {
      extractedSections = extractMenuFromHTML(html);
      sourceUrl = baseUrl;
    }
  }

  // Store extraction result
  if (extractedSections.length > 0) {
    await query(
      `INSERT INTO extracted_menus (venue_id, source_url, extracted_data, extraction_method, is_current)
       VALUES ($1, $2, $3, 'scrape', true)
       ON CONFLICT DO NOTHING`,
      [venueId, sourceUrl, JSON.stringify(extractedSections)]
    );

    // Mark previous extractions as not current
    await query(
      `UPDATE extracted_menus SET is_current = false
       WHERE venue_id = $1 AND is_current = true
       AND id != (SELECT id FROM extracted_menus WHERE venue_id = $1 ORDER BY extracted_at DESC LIMIT 1)`,
      [venueId]
    );
  }

  return extractedSections;
}
