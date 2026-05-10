import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env: look alongside the backend, then one level up (dev workspace root)
const envPaths = [
  join(__dirname, '.env'),
  join(__dirname, '..', '.env'),
];
for (const p of envPaths) {
  if (existsSync(p)) { dotenv.config({ path: p }); break; }
}

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import { initDatabase, saveDatabase } from './db/database.js';
import createMatchesRouter from './routes/matches.js';
import { setupSocket } from './socket/liveUpdates.js';
import { Poller } from './services/poller.js';
import { HybridProvider } from './providers/HybridProvider.js';

const PORT = process.env.PORT || 3002;

// Resolve frontend-dist: in packaged app ELECTRON_RESOURCES points to
// Contents/Resources where extraResources are placed; in dev it lives one
// level up from the backend folder.
function resolveFrontendDist() {
  const r = process.env.ELECTRON_RESOURCES;
  if (r) return join(r, 'frontend-dist');          // packaged (extraResources)
  return join(__dirname, '..', 'frontend-dist');   // dev
}

async function main() {
  const app    = express();
  const server = createServer(app);
  const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  app.use(cors({ origin: '*' }));
  app.use(express.json());

  // ── Database ──────────────────────────────────────────────────────────────
  await initDatabase();

  // ── Provider ──────────────────────────────────────────────────────────────
  const provider = new HybridProvider();

  // ── API routes ────────────────────────────────────────────────────────────
  app.use('/api', createMatchesRouter(provider));
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', provider: 'hybrid', timestamp: new Date().toISOString() })
  );

  // ── Tray popover ──────────────────────────────────────────────────────────
  app.get('/tray-popover.html', (_req, res) => {
    const r = process.env.ELECTRON_RESOURCES;
    const p = r
      ? join(r, 'electron', 'tray-popover.html')          // packaged (extraResources)
      : join(__dirname, '..', 'electron', 'tray-popover.html'); // dev
    res.sendFile(p);
  });

  // ── Frontend static files ─────────────────────────────────────────────────
  const frontendDist = resolveFrontendDist();
  if (frontendDist) {
    app.use(express.static(frontendDist));
    // SPA fallback
    app.get('*', (_req, res) => res.sendFile(join(frontendDist, 'index.html')));
    console.log(`[Server] Serving frontend from ${frontendDist}`);
  } else {
    console.warn('[Server] frontend-dist not found — run "npm run build:frontend" first');
  }

  // ── Socket.IO ─────────────────────────────────────────────────────────────
  const socketHandler = setupSocket(io);

  // ── Poller ────────────────────────────────────────────────────────────────
  const poller = new Poller(provider, (data) => {
    socketHandler.broadcastMatchUpdate({
      matches:   data.matches,
      timestamp: new Date().toISOString(),
    });

    for (const change of data.changes) {
      if (change.type === 'score' && change.event) {
        socketHandler.broadcastScoreEvent(change.event);
      } else if (change.type === 'events_full' && change.events) {
        for (const event of change.events) {
          socketHandler.broadcastScoreEvent(event);
        }
      }
    }

    if (!data.isInitial) {
      const liveCount = data.matches.filter(m => ['1H', 'HT', '2H'].includes(m.status)).length;
      console.log(`[Poller] ${data.changes.length} change(s), ${liveCount} live`);
    }
  });

  await poller.start();

  // ── Listen ────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`\n  Top 14 Desktop Backend`);
    console.log(`  ───────────────────────`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://localhost:${PORT}/api/matches\n`);
  });

  process.on('SIGINT', () => {
    poller.stop();
    saveDatabase();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
