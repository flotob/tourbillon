// sandboxed preloads must be commonjs
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('tourbillon', {
  desktop: true,
  platform: process.platform,
});
