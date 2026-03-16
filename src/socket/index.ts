import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { supabaseAdmin } from '../config/supabase';
import { query } from '../config/database';
import { sendNewMessagePush } from '../services/pushService';
import { isValidUUID } from '../utils/validation';

interface SenderInfo {
  id?: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

interface AuthSocket extends Socket {
  userId?: string;
  _senderInfo?: SenderInfo;
}

export function setupSocket(httpServer: HttpServer) {
  const corsOrigin = process.env.CORS_ORIGIN;
  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins: string[] = [
    ...(corsOrigin ? corsOrigin.split(',').map(s => s.trim()) : []),
    // Only allow localhost origins in development
    ...(!isProduction ? [
      'http://localhost:8081',
      'http://127.0.0.1:8081',
      'http://localhost:19006',
      'http://localhost:3000',
    ] : []),
  ];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Authentication middleware — validates Supabase JWT
  io.use(async (socket: AuthSocket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data.user) {
        return next(new Error('Invalid token'));
      }
      socket.userId = data.user.id;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // Track online users: userId -> Set of socketIds (supports multiple devices/tabs)
  const onlineUsers = new Map<string, Set<string>>();

  // Rate limiting for message sends: userId -> { count, resetAt }
  const messageRateLimits = new Map<string, { count: number; resetAt: number }>();

  // Clean stale rate limit entries every 10 minutes (prevents unbounded Map growth)
  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of messageRateLimits) {
      if (now - value.resetAt > 120000) messageRateLimits.delete(key);
    }
  }, 10 * 60 * 1000);
  rateLimitCleanup.unref();

  // Clean up interval on server close to prevent memory leaks
  httpServer.on('close', () => {
    clearInterval(rateLimitCleanup);
    messageRateLimits.clear();
    onlineUsers.clear();
  });

  io.on('connection', (socket: AuthSocket) => {
    const userId = socket.userId!;
    console.log(`User connected: ${userId}`);

    // Track online status (multi-device safe)
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    query('UPDATE users SET is_online = true WHERE id = $1', [userId])
      .catch((err) => console.error('Failed to mark user online:', err));

    // Join user's personal room
    socket.join(`user:${userId}`);

    // Send a message
    socket.on('send_message', async (data: {
      conversationId: string;
      content?: string;
      mediaUrl?: string;
    }) => {
      try {
        // Input validation
        if (!data.conversationId || !isValidUUID(data.conversationId)) {
          socket.emit('error', { message: 'Invalid conversation ID' });
          return;
        }
        if (data.content !== undefined && data.content !== null && typeof data.content !== 'string') {
          socket.emit('error', { message: 'Message content must be a string' });
          return;
        }
        if (!data.content?.trim() && !data.mediaUrl) {
          socket.emit('error', { message: 'Message cannot be empty' });
          return;
        }
        if (data.content && data.content.length > 5000) {
          socket.emit('error', { message: 'Message too long' });
          return;
        }
        if (data.mediaUrl && data.mediaUrl.length > 500) {
          socket.emit('error', { message: 'Media URL too long' });
          return;
        }

        // Rate limiting: max 30 messages per minute
        const now = Date.now();
        const limit = messageRateLimits.get(userId) || { count: 0, resetAt: now + 60000 };
        if (now >= limit.resetAt) {
          limit.count = 0;
          limit.resetAt = now + 60000;
        }
        if (limit.count >= 30) {
          socket.emit('error', { message: 'Too many messages. Please slow down.' });
          return;
        }
        limit.count++;
        messageRateLimits.set(userId, limit);

        // Verify participant + check blocked in parallel (saves one sequential query)
        const [participant, blocked] = await Promise.all([
          query(
            'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
            [data.conversationId, userId]
          ),
          query(
            `SELECT 1 FROM friendships
             WHERE status = 'blocked'
               AND (
                 (requester_id = $1 AND addressee_id IN (
                   SELECT user_id FROM conversation_participants WHERE conversation_id = $2 AND user_id != $1
                 ))
                 OR
                 (addressee_id = $1 AND requester_id IN (
                   SELECT user_id FROM conversation_participants WHERE conversation_id = $2 AND user_id != $1
                 ))
               )`,
            [userId, data.conversationId]
          ),
        ]);

        if (participant.rows.length === 0) {
          socket.emit('error', { message: 'Not a participant in this conversation' });
          return;
        }
        if (blocked.rows.length > 0) {
          socket.emit('error', { message: 'Cannot send message to this conversation' });
          return;
        }

        // Cache sender info on socket (only fetch once per connection)
        if (!(socket as AuthSocket)._senderInfo) {
          const senderResult = await query(
            'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
            [userId]
          );
          if (!senderResult.rows[0]) {
            socket.emit('error', { message: 'Sender account not found' });
            return;
          }
          (socket as AuthSocket)._senderInfo = senderResult.rows[0];
        }

        // Insert message + get participants in parallel
        const [result, participants] = await Promise.all([
          query(
            `INSERT INTO messages (conversation_id, sender_id, content, media_url)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [data.conversationId, userId, data.content || null, data.mediaUrl || null]
          ),
          query(
            'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
            [data.conversationId]
          ),
        ]);

        const message = result.rows[0];
        const senderInfo = (socket as AuthSocket)._senderInfo || {};
        const fullMessage = { ...message, ...senderInfo };

        for (const p of participants.rows) {
          io.to(`user:${p.user_id}`).emit('new_message', fullMessage);

          // Send push notification if recipient is offline
          if (p.user_id !== userId && !onlineUsers.has(p.user_id)) {
            const senderInfo = (socket as AuthSocket)._senderInfo;
            const senderName = senderInfo?.display_name || senderInfo?.username || 'Someone';
            sendNewMessagePush(
              p.user_id,
              senderName,
              data.content || 'Sent a photo',
              data.conversationId,
            ).catch((pushErr) => console.error('Push notification failed:', pushErr));
          }
        }
      } catch (err) {
        console.error('Send message error:', err);
      }
    });

    // Typing indicator
    socket.on('typing', (data: { conversationId: string }) => {
      try {
        if (!data?.conversationId || !isValidUUID(data.conversationId)) return;
        // Only emit if user has joined this conversation room
        if (!socket.rooms.has(`conversation:${data.conversationId}`)) return;
        socket.to(`conversation:${data.conversationId}`).emit('user_typing', {
          userId,
          conversationId: data.conversationId,
        });
      } catch (err) {
        console.error('Typing indicator error:', err);
      }
    });

    // Read receipt
    socket.on('mark_read', async (data: { conversationId: string }) => {
      try {
        if (!data?.conversationId || !isValidUUID(data.conversationId)) return;

        // Verify user is a participant before marking messages read
        const participant = await query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
          [data.conversationId, userId]
        );
        if (participant.rows.length === 0) return;

        await query(
          `UPDATE messages SET read_at = NOW()
           WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL`,
          [data.conversationId, userId]
        );

        // Notify other participants
        const participants = await query(
          'SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2',
          [data.conversationId, userId]
        );

        for (const p of participants.rows) {
          io.to(`user:${p.user_id}`).emit('messages_read', {
            conversationId: data.conversationId,
            readBy: userId,
          });
        }
      } catch (err) {
        console.error('Mark read error:', err);
      }
    });

    // Join conversation room (with authorization check)
    socket.on('join_conversation', async (conversationId: string) => {
      try {
        if (!conversationId || !isValidUUID(conversationId)) {
          socket.emit('error', { message: 'Invalid conversation ID' });
          return;
        }
        const participant = await query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, userId]
        );
        if (participant.rows.length === 0) {
          socket.emit('error', { message: 'Not a participant in this conversation' });
          return;
        }
        socket.join(`conversation:${conversationId}`);
      } catch (err) {
        console.error('Join conversation auth error:', err);
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId: string) => {
      if (!conversationId || !isValidUUID(conversationId)) return;
      socket.leave(`conversation:${conversationId}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${userId}`);
      // NOTE: Rate limit is NOT cleared on disconnect to prevent bypass-by-reconnect.
      // Stale entries are cleaned up by the periodic rateLimitCleanup interval.
      // Multi-device safe: only mark offline when last socket disconnects
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          query('UPDATE users SET is_online = false WHERE id = $1', [userId])
            .catch((err) => console.error('Failed to mark user offline:', err));
        }
      }
    });
  });

  return io;
}
