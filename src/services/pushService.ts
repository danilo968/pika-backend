import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { query } from '../config/database';

const expo = new Expo();

// ─── Push Payload ───
export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
  channelId?: string;
}

// ─── Get Active Push Tokens for a User ───
async function getUserTokens(userId: string): Promise<string[]> {
  const result = await query(
    'SELECT token FROM push_tokens WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  return result.rows.map((r: any) => r.token);
}

// ─── Send Push Notification to a User ───
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  const tokens = await getUserTokens(userId);
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens
    .filter((token) => Expo.isExpoPushToken(token))
    .map((token) => ({
      to: token,
      sound: 'default' as const,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      channelId: payload.channelId || 'default',
    }));

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);

      // Handle invalid tokens — deactivate stale ones
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'error') {
          if (ticket.details?.error === 'DeviceNotRegistered') {
            await query(
              'UPDATE push_tokens SET is_active = false WHERE token = $1',
              [(messages[i] as any).to]
            );
          }
          console.error('Push notification error:', ticket.message);
        }
      }
    } catch (err) {
      console.error('Failed to send push notifications:', err);
    }
  }
}

// ═════════════════════════════════════════════
// Convenience functions for specific notification types
// ═════════════════════════════════════════════

export async function sendNewMessagePush(
  recipientId: string,
  senderName: string,
  messagePreview: string,
  conversationId: string,
): Promise<void> {
  const body = messagePreview.length > 100
    ? messagePreview.substring(0, 97) + '...'
    : messagePreview;

  await sendPushToUser(recipientId, {
    title: senderName,
    body,
    data: { type: 'new_message', conversationId },
    channelId: 'messages',
  });
}

export async function sendFriendRequestPush(
  recipientId: string,
  requesterName: string,
  requesterId: string,
): Promise<void> {
  await sendPushToUser(recipientId, {
    title: 'New Friend Request',
    body: `${requesterName} wants to connect with you`,
    data: { type: 'friend_request', userId: requesterId },
  });
}

export async function sendRatingReceivedPush(
  businessOwnerId: string,
  venueName: string,
  rating: number,
  venueId: string,
): Promise<void> {
  await sendPushToUser(businessOwnerId, {
    title: `New Rating on ${venueName}`,
    body: `Someone rated your venue ${rating}/5`,
    data: { type: 'rating_received', venueId },
  });
}
