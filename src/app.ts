import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import storiesRoutes from './routes/stories';
import postsRoutes from './routes/posts';
import friendsRoutes from './routes/friends';
import messagesRoutes from './routes/messages';
import usersRoutes from './routes/users';
import venueRoutes from './routes/venues';
import businessRoutes from './routes/businesses';
import navigationRoutes from './routes/navigation';
import supportRoutes from './routes/support';
import notificationRoutes from './routes/notifications';

dotenv.config();

const app = express();

// Middleware — CORS
const corsOrigin = process.env.CORS_ORIGIN || '*';
const allowedOrigins: string[] | string = corsOrigin === '*'
  ? '*'
  : [
      ...corsOrigin.split(',').map(s => s.trim()),
      // Allow local dev servers
      'http://localhost:8081',
      'http://127.0.0.1:8081',
      'http://localhost:19006',
      'http://localhost:3000',
    ];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', name: 'Pika API', version: '1.0.1', build: '2026-03-06' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/conversations', messagesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/navigation', navigationRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/notifications', notificationRoutes);

export default app;
