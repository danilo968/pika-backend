import { Router, Request, Response } from 'express';
import { optionalAuthenticate } from '../middleware/auth';

interface MapboxManeuver {
  type: string;
  modifier?: string;
  location: number[];
  instruction?: string;
}

interface MapboxStep {
  maneuver: MapboxManeuver;
  name?: string;
  distance: number;
  duration: number;
}

interface MapboxLeg {
  steps?: MapboxStep[];
  summary?: string;
}

interface MapboxRoute {
  distance: number;
  duration: number;
  geometry?: { coordinates?: number[][] };
  legs?: MapboxLeg[];
}

interface MapboxResponse {
  code?: string;
  routes?: MapboxRoute[];
}

const router = Router();

const MAPBOX_BASE = 'https://api.mapbox.com/directions/v5/mapbox';

function modeToProfile(mode: string): string {
  switch (mode) {
    case 'walking': return 'walking';
    case 'cycling': return 'cycling';
    case 'driving': return 'driving';
    default: return 'driving';
  }
}

// GET /api/navigation/route — proxy Mapbox Directions API
router.get('/route', optionalAuthenticate, async (req: Request, res: Response) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, mode } = req.query;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    // Validate coordinates are valid numbers in range
    const oLat = parseFloat(origin_lat as string);
    const oLng = parseFloat(origin_lng as string);
    const dLat = parseFloat(dest_lat as string);
    const dLng = parseFloat(dest_lng as string);
    if ([oLat, oLng, dLat, dLng].some(v => !isFinite(v)) ||
        Math.abs(oLat) > 90 || Math.abs(dLat) > 90 ||
        Math.abs(oLng) > 180 || Math.abs(dLng) > 180) {
      return res.status(400).json({ error: 'Invalid coordinates' });
    }

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
      return res.status(503).json({ error: 'Navigation service not configured' });
    }

    const validModes = ['walking', 'cycling', 'driving'];
    const modeStr = (mode as string || 'driving').toLowerCase();
    if (!validModes.includes(modeStr)) {
      return res.status(400).json({ error: 'Invalid mode. Must be walking, cycling, or driving.' });
    }
    const profile = modeToProfile(modeStr);
    const coords = `${oLng},${oLat};${dLng},${dLat}`;
    const url = `${MAPBOX_BASE}/${profile}/${coords}?geometries=geojson&steps=true&overview=full&language=en&access_token=${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response: globalThis.Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (fetchErr: unknown) {
      clearTimeout(timeout);
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        return res.status(504).json({ error: 'Navigation service timed out. Please try again.' });
      }
      throw fetchErr;
    }
    clearTimeout(timeout);
    if (!response.ok) {
      return res.status(502).json({ error: 'Navigation service error' });
    }
    const data = await response.json() as MapboxResponse;

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found' });
    }

    const route = data.routes[0];
    if (!route.legs || route.legs.length === 0) {
      return res.status(404).json({ error: 'No route legs found' });
    }
    const legs = route.legs[0];

    res.json({
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry?.coordinates?.map((c: number[]) => [c[1], c[0]]) || [], // [lng,lat] -> [lat,lng]
      steps: (legs.steps || []).map((step: MapboxStep) => ({
        instruction: step.maneuver.instruction || '',
        distance: step.distance,
        duration: step.duration,
        maneuver: step.maneuver.type + (step.maneuver.modifier ? `-${step.maneuver.modifier}` : ''),
        coordinate: [step.maneuver.location[0], step.maneuver.location[1]],
      })),
      summary: legs.summary || '',
    });
  } catch (err: unknown) {
    // Log only the error message (not full error object) to avoid leaking Mapbox token in URLs
    console.error('Navigation route error:', err instanceof Error ? err.message : 'Unknown error');
    res.status(500).json({ error: 'Failed to calculate route' });
  }
});

export default router;
