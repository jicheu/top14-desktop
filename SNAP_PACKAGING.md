# Snap Packaging Guide — top14-live

## Overview

This snap packages the **Top 14 Live** Electron desktop app as a strictly-confined snap targeting **core24** (Ubuntu 24.04) using snapcraft 8.x.

---

## Prerequisites

### 1. Install snapcraft

```bash
sudo snap install snapcraft --classic
```

### 2. Set up LXD (recommended build backend)

```bash
sudo snap install lxd
sudo lxd init --minimal
sudo usermod -aG lxd $USER
# Log out and back in for the group change to take effect
```

Snapcraft uses LXD to build inside a clean Ubuntu 24.04 container — never build with `--destructive-mode`, which pollutes the host system.

---

## Pre-build: Frontend Distribution

The `frontend-dist/` directory must be present before running snapcraft. It is built from a separate repository (`top14/frontend`).

If `frontend-dist/` is missing or stale:

```bash
# From the top14 frontend repository:
cd ../top14/frontend
npm ci
npm run build

# Then, back in this repo:
cd ../top14-desktop
rm -rf frontend-dist
cp -r ../top14/frontend/dist frontend-dist
```

Verify the directory exists before proceeding:

```bash
ls frontend-dist/index.html
```

---

## Build

From the project root:

```bash
export SNAPCRAFT_BUILD_INFO=1
snapcraft pack
```

This produces a `.snap` file in the project root (e.g. `top14-live_1.0.0_amd64.snap`).

---

## Install and Test

### First test (devmode — bypasses confinement)

```bash
sudo snap install --devmode top14-live_*.snap
top14-live
```

Verify the app launches, the tray icon appears, and live scores load.

### Switch to strict confinement

```bash
sudo snap install --dangerous top14-live_*.snap
top14-live
```

Check `journalctl` for AppArmor denials if anything breaks:

```bash
sudo journalctl -xe | grep DENIED
```

---

## Interface Connections

All interfaces used by this snap **auto-connect** on install — no manual `snap connect` commands are required.

| Interface | Auto-connect | Purpose |
|-----------|:---:|---------|
| `network` | ✅ | Outbound HTTP for live score polling |
| `network-bind` | ✅ | Embedded Express server on `localhost:3002` |
| `home` | ✅ | User data directory (on Ubuntu Desktop) |
| `audio-playback` | ✅ | Audio output (provided by gnome extension) |
| `browser-support` | ✅ | Chromium/Electron renderer process APIs |
| `desktop` | ✅ | Session D-Bus / XDG portals (via gnome extension) |
| `desktop-legacy` | ✅ | Accessibility / input methods (via gnome extension) |
| `opengl` | ✅ | GPU-accelerated rendering (via gnome extension) |
| `wayland` | ✅ | Wayland compositor (via gnome extension) |
| `x11` | ✅ | X11 display (via gnome extension) |
| `gsettings` | ✅ | GNOME settings (via gnome extension) |

> **Note:** On Ubuntu Server or IoT, the `home` interface requires a manual connect:
> ```bash
> sudo snap connect top14-live:home
> ```

---

## Troubleshooting

### App fails to start

Open a shell inside the snap's confinement to inspect the environment:

```bash
snap run --shell top14-live
./opt/top14-live/top14-live --no-sandbox
```

### AppArmor denials (permission errors)

```bash
sudo journalctl -xe | grep DENIED
# or
sudo dmesg | grep DENIED
```

### Electron sandbox errors

The snap passes `--no-sandbox` to Electron because strict snap confinement acts as the sandbox. If you see sandbox-related errors, confirm the flag is being passed:

```bash
cat /snap/top14-live/current/usr/share/applications/top14-live.desktop
```

### Backend not starting

The embedded Express backend is spawned as an Electron utility process from `resources/backend/server.js`. Check stderr output:

```bash
snap run --shell top14-live
cd /snap/top14-live/current
./opt/top14-live/top14-live --no-sandbox 2>&1 | grep '\[backend\]'
```

### Stage-package resolution failures

If `snapcraft pack` fails with a missing package, check the exact Noble (24.04) package name:

```bash
# Inside an LXD container or on Ubuntu 24.04:
apt-cache search <package-name>
```

---

## Publishing to the Snap Store (optional)

1. Create an account at <https://snapcraft.io>
2. Register the snap name: `snapcraft register top14-live`
3. Upload: `snapcraft upload top14-live_*.snap --release=stable`

> This snap uses **strict confinement** and all-auto-connecting interfaces, so it does not require manual Snap Store review for confinement level. Standard automated review applies.
