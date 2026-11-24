// Renders build/icon.svg to a transparent 1024px build/icon.png using Electron's own Chromium.
// Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = path.join(__dirname, '../build/icon.svg');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
  await win.loadFile(svg);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '../build/icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
