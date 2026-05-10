import { Tray, BrowserWindow, Menu, nativeImage, screen, app } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let trayInstance  = null;
let popoverWindow = null;

// ── Tray icon ─────────────────────────────────────────────────────────────────
// Priority:
//   1. assets/icon.png (512×512 rugby ball emoji) — resized to 22×22
//   2. assets/trayTemplate.png — if someone provides a proper macOS template
//   3. Known-valid 1×1 transparent PNG (guaranteed non-empty nativeImage)
//
// Wrapping new Tray() in a try-catch prevents a bad icon from crashing the
// entire whenReady handler in the packaged build.

// Known-valid 1×1 transparent PNG (verified IEND CRC)
const TRANSPARENT_1X1 =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAC' +
  'hwGA60e6kgAAAABJRU5ErkJggg==';

function buildTrayIcon() {
  // 1. Try icon.png (always present — generated from emoji)
  const iconPath     = join(__dirname, '..', 'assets', 'icon.png');
  const templatePath = join(__dirname, '..', 'assets', 'trayTemplate.png');
  for (const p of [iconPath, templatePath]) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        // Resize to 22×22 for menu bar; keep aspect ratio
        return img.resize({ width: 22, height: 22 });
      }
    } catch (_) {}
  }
  // 2. Guaranteed fallback
  return nativeImage.createFromDataURL(TRANSPARENT_1X1);
}

// ── Popover window ────────────────────────────────────────────────────────────

function createPopover(backendUrl) {
  const win = new BrowserWindow({
    width:  340,
    height: 480,
    show:   false,
    frame:  false,
    resizable:    false,
    movable:      false,
    alwaysOnTop:  true,
    hasShadow:    true,
    transparent:  false,
    skipTaskbar:  true,
    webPreferences: {
      preload:          join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadURL(`${backendUrl}/tray-popover.html`);
  win.on('blur', () => win.hide());

  return win;
}

function positionPopover(win) {
  if (!trayInstance) return;
  const trayBounds = trayInstance.getBounds();
  const winBounds  = win.getBounds();
  const display    = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea   = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width  / 2 - winBounds.width  / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width  - winBounds.width  - 8));
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - winBounds.height - 8));

  win.setPosition(x, y);
}

// ── Public factory ────────────────────────────────────────────────────────────

export function createTray({ backendUrl, onOpenApp }) {
  const icon = buildTrayIcon();

  try {
    trayInstance = new Tray(icon);
  } catch (err) {
    // Last resort: empty nativeImage — menu-bar entry will still show via setTitle
    console.error('[Tray] new Tray() failed, retrying with empty image:', err.message);
    trayInstance = new Tray(nativeImage.createEmpty());
  }

  // Use an emoji label — guaranteed visible on any macOS menu bar,
  // even when no icon asset file is present.
  trayInstance.setTitle('🏉');
  trayInstance.setToolTip('Top 14 Live');

  popoverWindow = createPopover(backendUrl);

  // Left-click: toggle popover
  trayInstance.on('click', () => {
    if (popoverWindow.isVisible()) {
      popoverWindow.hide();
    } else {
      positionPopover(popoverWindow);
      popoverWindow.show();
      popoverWindow.focus();
    }
  });

  // Right-click: context menu
  trayInstance.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Ouvrir Top 14 Live',
        click: () => { popoverWindow.hide(); onOpenApp(); },
      },
      { type: 'separator' },
      { label: 'Quitter', accelerator: 'Cmd+Q', click: () => app.quit() },
    ]);
    trayInstance.popUpContextMenu(menu);
  });

  return {
    instance:    trayInstance,
    hidePopover: () => popoverWindow?.hide(),
  };
}
