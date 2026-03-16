/**
 * Pika Learning AI — Preference Engine
 *
 * SQL-based preference computation that transforms raw interaction data
 * into a weighted user preference profile. Zero external dependencies.
 *
 * Algorithm:
 * 1. Aggregate companion/vibe/occasion/budget from multiple signal sources
 *    - ku_ratings (strongest signal, 3x weight)
 *    - assistant_sessions (2x weight)
 *    - interaction_events (1x weight)
 *    - category_selections (1x weight)
 * 2. Apply time-decay: 0-30 days = 1.0x, 30-90 days = 0.5x, 90+ = 0.2x
 * 3. Compute taste weights from sub-rating engagement
 * 4. Detect usage patterns (peak hour, peak day)
 */

import { query } from '../config/database';

// Time-decay SQL fragment (reused across queries)
const TIME_DECAY = `
  CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1.0
       WHEN created_at > NOW() - INTERVAL '90 days' THEN 0.5
       ELSE 0.2 END
`;

/**
 * Recompute user_preferences for a single user.
 * Called after significant actions (rating, every N interactions)
 * or via periodic batch job.
 */
export async function recomputePreferences(userId: string): Promise<void> {
  // Run all 9 independent read queries in parallel (saves ~8x latency)
  const [
    companionResult, vibeResult, occasionResult, budgetResult,
    categoryResult, tasteResult, patternResult, dayResult, totalInteractions,
  ] = await Promise.all([
    // 1. Companion preferences: from ratings (3x) + assistant sessions (2x)
    query(`
      WITH weighted AS (
        SELECT unnest(companion_tags) as val, 3.0 * ${TIME_DECAY} as weight
        FROM ku_ratings WHERE user_id = $1
        UNION ALL
        SELECT answers->>'companion' as val, 2.0 * ${TIME_DECAY} as weight
        FROM assistant_sessions WHERE user_id = $1 AND answers->>'companion' IS NOT NULL
      )
      SELECT val, SUM(weight) as total_weight
      FROM weighted WHERE val IS NOT NULL AND val != ''
      GROUP BY val ORDER BY total_weight DESC LIMIT 5
    `, [userId]),
    // 2. Vibe preferences
    query(`
      WITH weighted AS (
        SELECT answers->>'vibe' as val, 2.0 * ${TIME_DECAY} as weight
        FROM assistant_sessions WHERE user_id = $1 AND answers->>'vibe' IS NOT NULL
      )
      SELECT val, SUM(weight) as total_weight
      FROM weighted WHERE val IS NOT NULL AND val != ''
      GROUP BY val ORDER BY total_weight DESC LIMIT 5
    `, [userId]),
    // 3. Occasion preferences
    query(`
      WITH weighted AS (
        SELECT unnest(occasion_tags) as val, 3.0 * ${TIME_DECAY} as weight
        FROM ku_ratings WHERE user_id = $1
        UNION ALL
        SELECT answers->>'occasion' as val, 2.0 * ${TIME_DECAY} as weight
        FROM assistant_sessions WHERE user_id = $1 AND answers->>'occasion' IS NOT NULL
      )
      SELECT val, SUM(weight) as total_weight
      FROM weighted WHERE val IS NOT NULL AND val != ''
      GROUP BY val ORDER BY total_weight DESC LIMIT 5
    `, [userId]),
    // 4. Budget preference
    query(`
      WITH all_budgets AS (
        SELECT CASE
          WHEN answers->>'budget' ~ '^[0-9]+$' THEN (answers->>'budget')::int
          ELSE NULL
        END as budget
        FROM assistant_sessions WHERE user_id = $1 AND answers->>'budget' IS NOT NULL
        UNION ALL
        SELECT v.price_level as budget FROM venues v
        JOIN ku_ratings kr ON kr.venue_id = v.id WHERE kr.user_id = $1 AND v.price_level IS NOT NULL
      )
      SELECT budget, COUNT(*) as cnt FROM all_budgets
      WHERE budget IS NOT NULL
      GROUP BY budget ORDER BY cnt DESC LIMIT 1
    `, [userId]),
    // 5. Category preferences
    query(`
      WITH weighted AS (
        SELECT category_slug as val, 1.0 *
          CASE WHEN selected_at > NOW() - INTERVAL '30 days' THEN 1.0
               WHEN selected_at > NOW() - INTERVAL '90 days' THEN 0.5
               ELSE 0.2 END as weight
        FROM category_selections WHERE user_id = $1
        UNION ALL
        SELECT vc.slug as val, 2.0 as weight
        FROM interaction_events ie
        JOIN venues v ON v.id = ie.venue_id
        JOIN venue_categories vc ON vc.id = v.category_id
        WHERE ie.user_id = $1 AND ie.event_type IN ('venue_view', 'venue_click_from_assistant')
          AND ie.created_at > NOW() - INTERVAL '90 days'
      )
      SELECT val, SUM(weight) as total_weight
      FROM weighted WHERE val IS NOT NULL
      GROUP BY val ORDER BY total_weight DESC LIMIT 5
    `, [userId]),
    // 6. Taste weights
    query(`
      SELECT
        AVG(CASE WHEN food_rating IS NOT NULL THEN 1.0 ELSE 0 END) as food_engagement,
        AVG(CASE WHEN service_rating IS NOT NULL THEN 1.0 ELSE 0 END) as service_engagement,
        AVG(CASE WHEN ambiance_rating IS NOT NULL THEN 1.0 ELSE 0 END) as ambiance_engagement,
        AVG(CASE WHEN value_rating IS NOT NULL THEN 1.0 ELSE 0 END) as value_engagement,
        COUNT(*) as total_ratings
      FROM ku_ratings WHERE user_id = $1
    `, [userId]),
    // 7. Peak usage hour
    query(`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*) as cnt
      FROM interaction_events WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY hour ORDER BY cnt DESC LIMIT 1
    `, [userId]),
    // 8. Peak usage day of week
    query(`
      SELECT EXTRACT(DOW FROM created_at)::int as dow, COUNT(*) as cnt
      FROM interaction_events WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY dow ORDER BY cnt DESC LIMIT 1
    `, [userId]),
    // 9. Total interactions count
    query(
      'SELECT COUNT(*)::int as cnt FROM interaction_events WHERE user_id = $1',
      [userId]
    ),
  ]);

  // Normalize weights to 0-1 range relative to max
  const normalizeWeights = (rows: { val: string; total_weight: string }[]) => {
    if (rows.length === 0) return [];
    const parsed = rows.map(r => ({ val: r.val, w: parseFloat(r.total_weight) }))
      .filter(r => Number.isFinite(r.w));
    if (parsed.length === 0) return [];
    const maxWeight = Math.max(...parsed.map(r => r.w));
    if (maxWeight === 0) return [];
    return parsed.map(r => ({
      value: r.val,
      weight: Math.round((r.w / maxWeight) * 100) / 100,
    }));
  };

  const taste = tasteResult.rows[0] || {};

  // Upsert into user_preferences
  await query(`
    INSERT INTO user_preferences (
      user_id, preferred_companions, preferred_vibes, preferred_occasions,
      preferred_budget, preferred_categories,
      taste_food_weight, taste_service_weight, taste_ambiance_weight, taste_value_weight,
      peak_hour, peak_day_of_week, total_interactions, total_ratings,
      computed_at, version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), 1)
    ON CONFLICT (user_id) DO UPDATE SET
      preferred_companions = EXCLUDED.preferred_companions,
      preferred_vibes = EXCLUDED.preferred_vibes,
      preferred_occasions = EXCLUDED.preferred_occasions,
      preferred_budget = EXCLUDED.preferred_budget,
      preferred_categories = EXCLUDED.preferred_categories,
      taste_food_weight = EXCLUDED.taste_food_weight,
      taste_service_weight = EXCLUDED.taste_service_weight,
      taste_ambiance_weight = EXCLUDED.taste_ambiance_weight,
      taste_value_weight = EXCLUDED.taste_value_weight,
      peak_hour = EXCLUDED.peak_hour,
      peak_day_of_week = EXCLUDED.peak_day_of_week,
      total_interactions = EXCLUDED.total_interactions,
      total_ratings = EXCLUDED.total_ratings,
      computed_at = NOW(),
      version = user_preferences.version + 1
  `, [
    userId,
    JSON.stringify(normalizeWeights(companionResult.rows)),
    JSON.stringify(normalizeWeights(vibeResult.rows)),
    JSON.stringify(normalizeWeights(occasionResult.rows)),
    budgetResult.rows[0]?.budget || null,
    JSON.stringify(normalizeWeights(categoryResult.rows)),
    parseFloat(taste.food_engagement) || 0,
    parseFloat(taste.service_engagement) || 0,
    parseFloat(taste.ambiance_engagement) || 0,
    parseFloat(taste.value_engagement) || 0,
    patternResult.rows[0]?.hour ?? null,
    dayResult.rows[0]?.dow ?? null,
    totalInteractions.rows[0]?.cnt || 0,
    Number(taste.total_ratings) || 0,
  ]);
}

/** Refresh materialized view for venue stats */
export async function refreshVenueStats(): Promise<void> {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY venue_preference_stats');
}

/** Batch recompute all active users (for cron / scheduled job) */
export async function recomputeAllPreferences(): Promise<void> {
  const users = await query(`
    SELECT DISTINCT user_id FROM interaction_events
    WHERE created_at > NOW() - INTERVAL '7 days'
    UNION
    SELECT DISTINCT user_id FROM ku_ratings
    WHERE created_at > NOW() - INTERVAL '7 days'
  `);

  // Process users in parallel batches of 5 (bounded concurrency)
  const BATCH_SIZE = 5;
  for (let i = 0; i < users.rows.length; i += BATCH_SIZE) {
    const batch = users.rows.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(row =>
        recomputePreferences(row.user_id).catch(err => {
          console.error(`Preference recompute failed for user ${row.user_id}:`, err);
        })
      )
    );
  }

  await refreshVenueStats();
}
