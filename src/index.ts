import http from 'http';
import app from './app';
import { setupSocket } from './socket';
import { ensureCollection } from './services/typesenseService';
import dotenv from 'dotenv';

dotenv.config();

// Validate required secrets before starting
const requiredEnvVars = ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ FATAL: ${envVar} environment variable is not set. Server cannot start.`);
    process.exit(1);
  }
  if (process.env[envVar]!.length < 32) {
    console.warn(`⚠️  WARNING: ${envVar} is shorter than 32 characters. Use a stronger secret in production.`);
  }
}

// Validate JWT expiry env vars (if set) — catch misconfiguration early
const JWT_EXPIRY_PATTERN = /^\d+[smhd]?$/;
for (const envVar of ['JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN'] as const) {
  const val = process.env[envVar];
  if (val && !JWT_EXPIRY_PATTERN.test(val)) {
    console.error(`❌ FATAL: ${envVar}="${val}" is not a valid duration. Use formats like "15m", "7d", "3600".`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Set up Socket.io
setupSocket(server);

// Initialize Typesense search collection (non-blocking)
ensureCollection().catch((err) => {
  console.error('⚠️ Typesense collection init failed (will retry on first search):', err.message);
});

// Create uploads directory
import fs from 'fs';
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

server.listen(PORT, () => {
  console.log(`🚀 Pika API server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});
