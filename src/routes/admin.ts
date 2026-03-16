import { Router, Request, Response } from 'express';
import { syncAllVenues } from '../services/venueSync';

const router = Router();

// ── Admin secret key middleware ────────────────────────────────────
// Protects admin routes with a simple bearer token
function adminAuth(req: Request, res: Response, next: Function): void {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({ error: 'Admin endpoints not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${adminSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// ── Track sync state to prevent concurrent runs ───────────────────
let isSyncing = false;
let lastSyncResult: any = null;
let lastSyncTime: string | null = null;

// ── POST /api/admin/venue-sync ────────────────────────────────────
// Triggers a full venue sync across all 37 cities
router.post('/venue-sync', adminAuth, async (_req: Request, res: Response) => {
  if (isSyncing) {
    res.status(409).json({
      error: 'Sync already in progress',
      lastSync: lastSyncTime,
    });
    return;
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    console.log('[Admin] Manual venue sync triggered');
    const result = await syncAllVenues();
    lastSyncResult = result;
    lastSyncTime = new Date().toISOString();

    res.json({
      success: true,
      duration: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      result,
    });
  } catch (err: any) {
    console.error('[Admin] Venue sync failed:', err);
    res.status(500).json({ error: 'Sync failed', message: err.message });
  } finally {
    isSyncing = false;
  }
});

// ── GET /api/admin/venue-sync/status ──────────────────────────────
// Check sync status
router.get('/venue-sync/status', adminAuth, (_req: Request, res: Response) => {
  res.json({
    isSyncing,
    lastSyncResult,
    lastSyncTime,
  });
});

export default router;
