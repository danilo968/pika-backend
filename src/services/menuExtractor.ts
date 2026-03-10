import { query } from '../config/database';
import { URL } from 'url';

// SSRF protection: block private/internal hostnames
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'metadata.google.internal'];
const PRIVATE_IP_RANGES = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,         // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/,             // 192.168.0.0/16
  /^169\.254\.\d{1,3}\.\d{1,3}$/,             // 169.254.0.0/16 (link-local / cloud metadata)
];

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(h)) return true;
  if (PRIVATE_IP_RANGES.some(re => re.test(h))) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

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

  // Validate URL format and protocol
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(venueResult.rows[0].website);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return [];
    }
    // SSRF protection: block requests to internal/private networks
    if (isBlockedHost(parsedUrl.hostname)) {
      return [];
    }
  } catch {
    return []; // Invalid URL format
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
    const insertResult = await query(
      `INSERT INTO extracted_menus (venue_id, source_url, extracted_data, extraction_method, is_current)
       VALUES ($1, $2, $3, 'scrape', true)
       ON CONFLICT (venue_id, source_url) DO NOTHING
       RETURNING id`,
      [venueId, sourceUrl, JSON.stringify(extractedSections)]
    );

    // Only mark previous extractions as not current if a new one was inserted
    if (insertResult.rows.length > 0) {
      await query(
        `UPDATE extracted_menus SET is_current = false
         WHERE venue_id = $1 AND is_current = true AND id != $2`,
        [venueId, insertResult.rows[0].id]
      );
    }
  }

  return extractedSections;
}
