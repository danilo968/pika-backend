import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import interactionRoutes from './routes/interactions';
import adminRoutes from './routes/admin';

dotenv.config();

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP — managed separately for static assets
  crossOriginEmbedderPolicy: false, // Allow cross-origin resource loading
}));

// Middleware — CORS
const corsOrigin = process.env.CORS_ORIGIN;
const isProduction = process.env.NODE_ENV === 'production';
if (!corsOrigin && isProduction) {
  console.warn('⚠️  WARNING: CORS_ORIGIN not set in production. Only production origins will be allowed.');
}
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
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    // Allow any Vercel preview/production deployment
    if (/^https:\/\/pika[-\w]*\.vercel\.app$/.test(origin)) return callback(null, true);
    // Allow explicitly listed origins
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files (with security headers)
app.use('/uploads', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  next();
}, express.static(path.join(__dirname, '..', 'uploads')));

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
app.use('/api/interactions', interactionRoutes);
app.use('/api/admin', adminRoutes);

export default app;
