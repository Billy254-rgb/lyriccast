'use strict';
// LyricCast for Windows: a small desktop shell around the same screen as the web app.
// The screen is bundled inside the app, so songs and schedules open and work with no internet.
// Internet is only used while you project, to reach your LyricCast server.
const { app, BrowserWindow, protocol, shell, net, powerSaveBlocker } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{ scheme: 'lyriccast', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const WWW = path.join(__dirname, 'www');
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620, backgroundColor: '#07070d', title: 'LyricCast', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  win.removeMenu();
  win.loadURL('lyriccast://app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('lyriccast://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    protocol.handle('lyriccast', req => {
      let rel = decodeURIComponent(new URL(req.url).pathname); if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(WWW, rel));
      if (!file.startsWith(WWW)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    powerSaveBlocker.start('prevent-display-sleep');   // the screen stays on while the operator console is open
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
