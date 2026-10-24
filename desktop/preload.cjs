// sandboxed preloads must be commonjs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tourbillon', {
  desktop: true,
  platform: process.platform,
  agent: {
    status: () => ipcRenderer.invoke('agent:status'),
    login: () => ipcRenderer.invoke('agent:login'),
    pasteLoginUrl: (url) => ipcRenderer.invoke('agent:login-paste', url),
    cancelLogin: () => ipcRenderer.invoke('agent:login-cancel'),
    logout: () => ipcRenderer.invoke('agent:logout'),
    setModel: (id) => ipcRenderer.invoke('agent:set-model', id),
    setThinkingLevel: (level) => ipcRenderer.invoke('agent:set-thinking', level),
    prompt: (text) => ipcRenderer.invoke('agent:prompt', text),
    abort: () => ipcRenderer.invoke('agent:abort'),
    reset: () => ipcRenderer.invoke('agent:reset'),
    onEvent(callback) {
      const listener = (_event, agentEvent) => callback(agentEvent);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
    // the agent calls editor tools; handler(name, args) resolves to { text } or { error }
    handleTools(handler) {
      const listener = async (_event, { id, name, args }) => {
        let result;
        try {
          result = await handler(name, args);
        } catch (err) {
          result = { error: err?.message ?? String(err) };
        }
        ipcRenderer.send('agent:tool-result', { id, result });
      };
      ipcRenderer.on('agent:tool-request', listener);
      return () => ipcRenderer.removeListener('agent:tool-request', listener);
    },
  },
});
