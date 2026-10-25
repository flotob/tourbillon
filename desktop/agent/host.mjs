// runs the pi agent in the main process and talks to the renderer over ipc
import { app, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { createChatStore, entriesToMessages } from './chats.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { systemPrompt } from './prompt.mjs';
import { createTools } from './tools.mjs';

const PROVIDER = 'openai';
const TOOL_TIMEOUT_MS = 30000;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];

const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

function truncate(value, max = 4000) {
  return value.length > max ? value.slice(0, max) + '\n[...]' : value;
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export async function setupAgent({ getWindow, repoDir, db, crate }) {
  const agentDir = path.join(app.getPath('userData'), 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const prefsPath = path.join(agentDir, 'prefs.json');
  const prefs = { model: undefined, thinkingLevel: 'low' };
  try {
    Object.assign(prefs, JSON.parse(fs.readFileSync(prefsPath, 'utf8')));
  } catch {
    // first start
  }
  const savePrefs = () => fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));

  // sign in with chatgpt registers this installation with openai under a stable id
  const loginOptions = {
    agentName: 'Tourbillon',
    getDeviceId() {
      if (!prefs.deviceId) {
        prefs.deviceId = randomUUID();
        savePrefs();
      }
      return prefs.deviceId;
    },
  };

  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
  });
  const knowledge = loadKnowledge(repoDir);

  // test seam: a module that registers a scripted model instead of a real provider
  let scriptedModel;
  if (process.env.TOURBILLON_AGENT_SCRIPT) {
    const script = await import(pathToFileURL(path.resolve(process.env.TOURBILLON_AGENT_SCRIPT)).href);
    scriptedModel = await script.setup(runtime);
  }

  const send = (event) => getWindow()?.webContents.send('agent:event', event);
  const fromWindow = (event) => event.sender === getWindow()?.webContents;

  // tool calls that need the editor are answered by the renderer
  const pendingTools = new Map();
  let nextToolId = 0;
  function callRenderer(name, args, signal) {
    const win = getWindow();
    if (!win) {
      return Promise.resolve({ error: 'The editor window is not open.' });
    }
    const id = ++nextToolId;
    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        pendingTools.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => done({ error: `${name} timed out` }), TOOL_TIMEOUT_MS);
      signal?.addEventListener('abort', () => done({ error: 'aborted' }), { once: true });
      pendingTools.set(id, done);
      win.webContents.send('agent:tool-request', { id, name, args });
    });
  }
  ipcMain.on('agent:tool-result', (event, { id, result }) => {
    if (fromWindow(event)) {
      pendingTools.get(id)?.(result);
    }
  });

  const tools = createTools({ callRenderer, knowledge, crate });
  const chats = createChatStore(db);
  let session;
  let sessionManager;
  let unsubscribe;
  // the track whose code the agent works on, and the chat about it
  let trackId;
  let chatId;

  const isLoggedIn = () => !!scriptedModel || runtime.hasConfiguredAuth(PROVIDER);

  async function availableModels() {
    if (scriptedModel) {
      return [scriptedModel];
    }
    if (!isLoggedIn()) {
      return [];
    }
    return (await runtime.getAvailable(PROVIDER)).filter((model) => model.provider === PROVIDER);
  }

  async function selectedModel() {
    if (scriptedModel) {
      return scriptedModel;
    }
    const models = await availableModels();
    return models.find((model) => model.id === prefs.model);
  }

  function persist() {
    if (chatId && sessionManager) {
      chats.sync(chatId, sessionManager);
    }
  }

  function forward(event) {
    if (event.type === 'message_end' || event.type === 'agent_settled') {
      persist();
    }
    switch (event.type) {
      case 'agent_start':
        return send({ type: 'busy', busy: true });
      case 'agent_settled':
        return send({ type: 'busy', busy: false, aborted: event.aborted });
      case 'message_start':
        return event.message.role === 'assistant' && send({ type: 'assistant_start' });
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta' || update.type === 'thinking_delta') {
          send({ type: update.type, delta: update.delta });
        }
        return;
      }
      case 'message_end':
        return (
          event.message.role === 'assistant' &&
          send({
            type: 'assistant_end',
            stopReason: event.message.stopReason,
            errorMessage: event.message.errorMessage,
          })
        );
      case 'tool_execution_start':
        return send({ type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args });
      case 'tool_execution_end':
        return send({
          type: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          result: truncate(resultText(event.result)),
        });
      case 'auto_retry_start':
        return send({
          type: 'retry',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          message: event.errorMessage,
        });
    }
  }

  async function ensureSession() {
    if (session) {
      return session;
    }
    sessionManager = chatId
      ? SessionManager.inMemory(agentDir, undefined, chats.load(chatId))
      : SessionManager.inMemory(agentDir);
    ({ session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      modelRuntime: runtime,
      model: await selectedModel(),
      thinkingLevel: prefs.thinkingLevel,
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager,
      noTools: 'builtin',
      customTools: tools,
    }));
    unsubscribe = session.subscribe(forward);
    return session;
  }

  function disposeSession() {
    persist();
    unsubscribe?.();
    session?.dispose();
    session = undefined;
    sessionManager = undefined;
  }

  async function switchChat(id) {
    if (session?.isStreaming) {
      await session.abort();
    }
    disposeSession();
    chatId = id;
    return {
      chatId,
      chats: chats.list(trackId),
      messages: chatId ? entriesToMessages(chats.load(chatId)) : [],
    };
  }

  async function status() {
    const models = await availableModels();
    const current = session?.model ?? (await selectedModel());
    return {
      loggedIn: isLoggedIn(),
      busy: !!session?.isStreaming,
      models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
      model: current?.id ?? prefs.model,
      thinkingLevel: session?.thinkingLevel ?? prefs.thinkingLevel,
      thinkingLevels: THINKING_LEVELS,
      knowledge: { pages: knowledge.pageCount, functions: knowledge.functionCount },
    };
  }

  let login;
  ipcMain.handle('agent:status', (event) => fromWindow(event) && status());

  ipcMain.handle('agent:login', async (event) => {
    if (!fromWindow(event) || login) return;
    const controller = new AbortController();
    login = { controller, prompt: undefined };
    try {
      await runtime.login(
        PROVIDER,
        'oauth',
        {
          signal: controller.signal,
          notify(authEvent) {
            if (authEvent.type === 'auth_url') {
              shell.openExternal(authEvent.url);
              send({ type: 'login', stage: 'browser', url: authEvent.url });
            } else if (authEvent.type === 'progress' || authEvent.type === 'info') {
              send({ type: 'login', stage: 'progress', message: authEvent.message });
            }
          },
          prompt(authPrompt) {
            return new Promise((resolve, reject) => {
              login.prompt = { resolve, reject };
              send({
                type: 'login',
                stage: 'prompt',
                message: authPrompt.message,
                placeholder: authPrompt.placeholder,
              });
              authPrompt.signal?.addEventListener(
                'abort',
                () => {
                  login.prompt = undefined;
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
          },
        },
        loginOptions,
      );
      disposeSession();
      send({ type: 'login', stage: 'done' });
    } catch (err) {
      send({ type: 'login', stage: 'failed', message: controller.signal.aborted ? 'Login cancelled' : err.message });
    } finally {
      login = undefined;
    }
    return status();
  });

  // the url the browser was redirected to, pasted by the user when the callback did not arrive
  ipcMain.handle('agent:login-paste', (event, value) => fromWindow(event) && login?.prompt?.resolve(value));
  ipcMain.handle('agent:login-cancel', (event) => fromWindow(event) && login?.controller.abort());

  ipcMain.handle('agent:logout', async (event) => {
    if (!fromWindow(event)) return;
    disposeSession();
    await runtime.logout(PROVIDER);
    return status();
  });

  ipcMain.handle('agent:set-model', async (event, id) => {
    if (!fromWindow(event)) return;
    prefs.model = id;
    savePrefs();
    const model = await selectedModel();
    if (session && model) {
      await session.setModel(model);
    }
    return status();
  });

  ipcMain.handle('agent:set-thinking', async (event, level) => {
    if (!fromWindow(event) || !THINKING_LEVELS.includes(level)) return;
    prefs.thinkingLevel = level;
    savePrefs();
    session?.setThinkingLevel(level);
    return status();
  });

  ipcMain.handle('agent:prompt', async (event, text) => {
    if (!fromWindow(event)) return;
    try {
      if (!chatId) {
        chatId = chats.create(trackId, text.length > 60 ? text.slice(0, 60) + '…' : text);
        send({ type: 'chats', chatId, chats: chats.list(trackId) });
      }
      const current = await ensureSession();
      if (current.isStreaming) {
        // typed while the agent works: handle it once the current step is done
        await current.steer(text);
      } else {
        await current.prompt(text);
      }
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
  });

  ipcMain.handle('agent:abort', (event) => fromWindow(event) && session?.abort());

  // the renderer opens a track: show its latest chat
  ipcMain.handle('agent:open-track', async (event, id) => {
    if (!fromWindow(event)) return;
    trackId = id;
    return switchChat(chats.latest(trackId)?.id);
  });

  ipcMain.handle('agent:open-chat', (event, id) => fromWindow(event) && switchChat(id));

  // a new chat is stored once its first prompt is sent
  ipcMain.handle('agent:new-chat', (event) => fromWindow(event) && switchChat(undefined));

  ipcMain.handle('agent:delete-chat', async (event, id) => {
    if (!fromWindow(event)) return;
    if (id === chatId) {
      await switchChat(undefined);
    }
    chats.remove(id);
    return { chatId, chats: chats.list(trackId) };
  });
}
