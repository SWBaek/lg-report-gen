const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const filePath = process.argv.find((argument) => argument.toLowerCase().endsWith('.html'));
  if (!filePath) throw new Error('EXPORT_PREVIEW_PATH_MISSING');
  const window = new BrowserWindow({
    width: 1180,
    height: 900,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  await window.loadFile(filePath);
});

app.on('window-all-closed', () => app.quit());
