import cron from 'node-cron';
import { syncAllVenues } from './venueSync';

let isSyncing = false;

/**
 * Initialize the venue sync cron job.
 * Runs on the 5th of every month at 03:00 AM UTC.
 * Only syncs unclaimed venues — claimed venues are preserved.
 */
export function initScheduler(): void {
  // Cron: minute hour dayOfMonth month dayOfWeek
  // "0 3 5 * *" = 3:00 AM UTC on the 5th of every month
  const task = cron.schedule('0 3 5 * *', async () => {
    if (isSyncing) {
      console.log('[Scheduler] Venue sync already in progress, skipping...');
      return;
    }

    isSyncing = true;
    console.log(`[Scheduler] Monthly venue sync started at ${new Date().toISOString()}`);

    try {
      const result = await syncAllVenues();
      console.log(`[Scheduler] Monthly venue sync completed:`, result);
    } catch (err) {
      console.error('[Scheduler] Monthly venue sync failed:', err);
    } finally {
      isSyncing = false;
    }
  }, {
    timezone: 'Europe/Tirane', // Albania/Kosovo timezone (CET/CEST)
  });

  task.start();
  console.log('  Monthly venue sync scheduled for the 5th of each month at 03:00 (Europe/Tirane)');
}
