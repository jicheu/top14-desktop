import { app, BrowserWindow, ipcMain, nativeTheme, nativeImage, utilityProcess } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTray } from './tray.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const BACKEND_PORT = 3002;
const BACKEND_URL  = `http://localhost:${BACKEND_PORT}`;

let mainWindow  = null;
let backendProc = null;
let tray        = null;
let hidePopover = () => {};   // filled in once createTray() runs

// ── Backend ──────────────────────────────────────────────────────────────────

function startBackend() {
  const backendDir = isDev
    ? join(__dirname, '..', 'backend')
    : join(process.resourcesPath, 'backend');

  const serverPath = join(backendDir, 'server.js');

  // utilityProcess.fork() spawns a real Node.js child (not Electron binary)
  backendProc = utilityProcess.fork(serverPath, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT:                String(BACKEND_PORT),
      ELECTRON_USER_DATA:  app.getPath('userData'),
      ELECTRON_RESOURCES:  process.resourcesPath,   // lets backend resolve packaged file paths
    },
    stdio: isDev ? 'pipe' : 'pipe',
  });

  if (isDev) {
    backendProc.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`));
    backendProc.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  }

  backendProc.on('exit', (code) => {
    console.log(`[Main] Backend exited (code ${code})`);
  });

  // Poll the health endpoint until the server is ready
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      import('http').then(({ default: http }) => {
        const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
          if (res.statusCode === 200) {
            clearInterval(poll);
            console.log('[Main] Backend ready at', BACKEND_URL);
            resolve();
          }
        });
        req.on('error', () => {});
        req.setTimeout(200, () => req.destroy());
      });
    }, 400);
  });
}

// ── Main window ───────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width:  1200,
    height: 820,
    minWidth:  800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1923' : '#f5f8fa',
    webPreferences: {
      preload:          join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  mainWindow.loadURL(BACKEND_URL);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Hide instead of destroy so the tray stays active between sessions.
  // app.isQuitting is set to true in before-quit so Cmd+Q / "Quitter" can exit.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      app.dock?.hide();
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return mainWindow;
}

// Helper — closes popover then brings main window to front.
function openMainWindow() {
  hidePopover();
  app.dock?.show();
  if (!mainWindow) createMainWindow();
  else { mainWindow.show(); mainWindow.focus(); }
  app.focus({ steal: true });
}

// ── IPC ───────────────────────────────────────────────────────────────────────

// Helper — fully quits the app, killing backend and all Electron processes.
function quitApp() {
  app.isQuitting = true;
  backendProc?.kill();
  setTimeout(() => process.exit(0), 300);
  app.quit();
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('open-main-window', openMainWindow);
ipcMain.handle('get-backend-url',  () => BACKEND_URL);
ipcMain.handle('quit-app', () => quitApp());

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── Dock icon ──────────────────────────────────────────────────────────────
  const iconPath = isDev
    ? join(__dirname, '..', 'assets', 'icon.png')
    : join(process.resourcesPath, 'assets', 'icon.png');

  try {
    const dockIcon = nativeImage.createFromPath(iconPath);
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  } catch (_) {}

  await startBackend();

  // Always open the main window immediately on launch.
  // The tray provides additional quick-access from the menu bar.
  app.dock?.show();
  createMainWindow();

  const result = createTray({
    backendUrl: BACKEND_URL,
    onOpenApp:  openMainWindow,
    onQuit:     quitApp,
  });
  tray        = result.instance;
  hidePopover = result.hidePopover;
});

app.on('activate', () => {
  // Dock icon clicked (or Cmd+Tab) after window was hidden.
  openMainWindow();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  backendProc?.kill();
});
