import http from 'http';
import app from './app';
import { setupSocket } from './socket';
import { ensureCollection } from './services/typesenseService';
import { initScheduler } from './services/scheduler';
import dotenv from 'dotenv';

dotenv.config();

// Validate required Supabase env vars before starting
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ FATAL: ${envVar} environment variable is not set. Server cannot start.`);
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

  // Start scheduled tasks (monthly venue sync)
  initScheduler();
});
