import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';

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
router.get('/route', authenticate, async (req: Request, res: Response) => {
  try {
    const { origin_lat, origin_lng, dest_lat, dest_lng, mode } = req.query;

    if (!origin_lat || !origin_lng || !dest_lat || !dest_lng) {
      return res.status(400).json({ error: 'Missing coordinates' });
    }

    const token = process.env.MAPBOX_ACCESS_TOKEN;
    if (!token) {
      return res.status(503).json({ error: 'Navigation service not configured' });
    }

    const profile = modeToProfile(mode as string || 'driving');
    const coords = `${origin_lng},${origin_lat};${dest_lng},${dest_lat}`;
    const url = `${MAPBOX_BASE}/${profile}/${coords}?geometries=geojson&steps=true&overview=full&language=en&access_token=${token}`;

    const response = await fetch(url);
    const data: any = await response.json();

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found' });
    }

    const route = data.routes[0];
    const legs = route.legs[0];

    res.json({
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry.coordinates.map((c: number[]) => [c[1], c[0]]), // [lng,lat] -> [lat,lng]
      steps: legs.steps.map((step: any) => ({
        instruction: step.maneuver.instruction || '',
        distance: step.distance,
        duration: step.duration,
        maneuver: step.maneuver.type + (step.maneuver.modifier ? `-${step.maneuver.modifier}` : ''),
        coordinate: [step.maneuver.location[0], step.maneuver.location[1]],
      })),
      summary: legs.summary || '',
    });
  } catch (err) {
    console.error('Navigation route error:', err);
    res.status(500).json({ error: 'Failed to calculate route' });
  }
});

export default router;
