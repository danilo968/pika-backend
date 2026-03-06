import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { query } from '../config/database';
import { sendNewMessagePush } from '../services/pushService';

interface AuthSocket extends Socket {
  userId?: string;
}

export function setupSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Authentication middleware
  io.use((socket: AuthSocket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      socket.userId = decoded.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // Track online users: userId -> socketId
  const onlineUsers = new Map<string, string>();

  io.on('connection', (socket: AuthSocket) => {
    const userId = socket.userId!;
    console.log(`User connected: ${userId}`);

    // Track online status
    onlineUsers.set(userId, socket.id);
    query('UPDATE users SET is_online = true WHERE id = $1', [userId]);

    // Join user's personal room
    socket.join(`user:${userId}`);

    // Send a message
    socket.on('send_message', async (data: {
      conversationId: string;
      content?: string;
      mediaUrl?: string;
    }) => {
      try {
        // Verify participant
        const participant = await query(
          'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
          [data.conversationId, userId]
        );

        if (participant.rows.length === 0) return;

        // Save message to DB
        const result = await query(
          `INSERT INTO messages (conversation_id, sender_id, content, media_url)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [data.conversationId, userId, data.content || null, data.mediaUrl || null]
        );

        const message = result.rows[0];

        // Get sender info
        const sender = await query(
          'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
          [userId]
        );

        const fullMessage = { ...message, ...sender.rows[0] };

        // Get all participants and send to them
        const participants = await query(
          'SELECT user_id FROM conversation_participants WHERE conversation_id = $1',
          [data.conversationId]
        );

        for (const p of participants.rows) {
          io.to(`user:${p.user_id}`).emit('new_message', fullMessage);

          // Send push notification if recipient is offline
          if (p.user_id !== userId && !onlineUsers.has(p.user_id)) {
            const senderName = sender.rows[0]?.display_name || sender.rows[0]?.username || 'Someone';
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
      socket.to(`conversation:${data.conversationId}`).emit('user_typing', {
        userId,
        conversationId: data.conversationId,
      });
    });

    // Read receipt
    socket.on('mark_read', async (data: { conversationId: string }) => {
      try {
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

    // Join conversation room
    socket.on('join_conversation', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${userId}`);
      onlineUsers.delete(userId);
      query('UPDATE users SET is_online = false WHERE id = $1', [userId]);
    });
  });

  return io;
}
