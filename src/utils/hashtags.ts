import { query } from '../config/database';

/**
 * Extract hashtags from text (caption).
 * Rules:
 * - Must start with #
 * - 2-30 chars, alphanumeric + underscores only
 * - Max 10 hashtags per caption
 * - Stored lowercase without the #
 */
export function extractHashtags(text: string): string[] {
  if (!text) return [];

  const matches = text.match(/#([a-zA-Z0-9_]{2,30})/g);
  if (!matches) return [];

  const tags = [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
  return tags.slice(0, 10); // max 10 per caption
}

/**
 * Upsert hashtags and link them to a story.
 */
export async function linkHashtagsToStory(storyId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;

  for (const tag of tags) {
    // Upsert hashtag
    const result = await query(
      `INSERT INTO hashtags (tag, story_count, last_used_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (tag) DO UPDATE SET story_count = hashtags.story_count + 1, last_used_at = NOW()
       RETURNING id`,
      [tag]
    );

    // Link to story
    if (result.rows[0]) {
      await query(
        `INSERT INTO story_hashtags (story_id, hashtag_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [storyId, result.rows[0].id]
      );
    }
  }
}

/**
 * Upsert hashtags and link them to a post.
 */
export async function linkHashtagsToPost(postId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;

  for (const tag of tags) {
    const result = await query(
      `INSERT INTO hashtags (tag, post_count, last_used_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (tag) DO UPDATE SET post_count = hashtags.post_count + 1, last_used_at = NOW()
       RETURNING id`,
      [tag]
    );

    if (result.rows[0]) {
      await query(
        `INSERT INTO post_hashtags (post_id, hashtag_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [postId, result.rows[0].id]
      );
    }
  }
}

/**
 * Decrement hashtag counts when a story is deleted.
 */
export async function unlinkHashtagsFromStory(storyId: string): Promise<void> {
  await query(
    `UPDATE hashtags SET story_count = GREATEST(0, story_count - 1)
     WHERE id IN (SELECT hashtag_id FROM story_hashtags WHERE story_id = $1)`,
    [storyId]
  );
  await query(`DELETE FROM story_hashtags WHERE story_id = $1`, [storyId]);
}
