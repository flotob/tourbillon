// sandboxed preloads must be commonjs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tourbillon', {
  desktop: true,
  platform: process.platform,
  tracks: {
    list: () => ipcRenderer.invoke('tracks:list'),
    get: (id) => ipcRenderer.invoke('tracks:get', id),
    create: (track) => ipcRenderer.invoke('tracks:create', track),
    save: (id, code) => ipcRenderer.invoke('tracks:save', id, code),
    rename: (id, title) => ipcRenderer.invoke('tracks:rename', id, title),
    remove: (id) => ipcRenderer.invoke('tracks:delete', id),
    evaluated: (id, code) => ipcRenderer.invoke('tracks:evaluated', id, code),
    versions: (id) => ipcRenderer.invoke('tracks:versions', id),
    removeIfEmpty: (id) => ipcRenderer.invoke('tracks:delete-if-empty', id),
    getTabs: () => ipcRenderer.invoke('tracks:get-tabs'),
    setTabs: (tabs) => ipcRenderer.invoke('tracks:set-tabs', tabs),
  },
  // app menu actions, e.g. 'new-track' (Cmd+N) and 'close-tab' (Cmd+W)
  onMenu(callback) {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
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
    // chats belong to the open track; these return { chatId, chats, messages }
    openTrack: (trackId) => ipcRenderer.invoke('agent:open-track', trackId),
    openChat: (chatId) => ipcRenderer.invoke('agent:open-chat', chatId),
    newChat: () => ipcRenderer.invoke('agent:new-chat'),
    deleteChat: (chatId) => ipcRenderer.invoke('agent:delete-chat', chatId),
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
