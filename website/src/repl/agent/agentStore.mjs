// chat state lives outside the agent tab so it survives switching tabs
import { atom } from 'nanostores';
import { runEditorTool } from './editorTools.mjs';

export const agent = typeof window !== 'undefined' ? window.tourbillon?.agent : undefined;

// messages: { role: 'user' | 'assistant' | 'tool' | 'error', ... }
export const $agent = atom({ status: undefined, messages: [], busy: false, login: undefined });

const update = (changes) => $agent.set({ ...$agent.get(), ...changes });

function updateMessages(fn) {
  update({ messages: fn([...$agent.get().messages]) });
}

function updateLast(role, fn) {
  updateMessages((messages) => {
    const index = messages.findLastIndex((m) => m.role === role);
    if (index !== -1) {
      messages[index] = fn(messages[index]);
    }
    return messages;
  });
}

function handleEvent(event) {
  switch (event.type) {
    case 'busy':
      return update({ busy: event.busy });
    case 'assistant_start':
      return updateMessages((m) => [...m, { role: 'assistant', text: '', thinking: '', done: false }]);
    case 'text_delta':
      return updateLast('assistant', (m) => ({ ...m, text: m.text + event.delta }));
    case 'thinking_delta':
      return updateLast('assistant', (m) => ({ ...m, thinking: m.thinking + event.delta }));
    case 'assistant_end':
      updateLast('assistant', (m) => ({ ...m, done: true }));
      if (event.stopReason === 'error' && event.errorMessage) {
        updateMessages((m) => [...m, { role: 'error', text: event.errorMessage }]);
      }
      return;
    case 'tool_start':
      return updateMessages((m) => [...m, { role: 'tool', id: event.id, name: event.name, args: event.args }]);
    case 'tool_end':
      return updateMessages((messages) =>
        messages.map((m) =>
          m.role === 'tool' && m.id === event.id
            ? { ...m, result: event.result, isError: event.isError, done: true }
            : m,
        ),
      );
    case 'retry':
      return updateMessages((m) => [
        ...m,
        { role: 'error', text: `Retrying (${event.attempt}/${event.maxAttempts}): ${event.message}` },
      ]);
    case 'error':
      return updateMessages((m) => [...m, { role: 'error', text: event.message }]);
    case 'login':
      if (event.stage === 'done' || event.stage === 'failed') {
        update({ login: event.stage === 'failed' ? { stage: 'failed', message: event.message } : undefined });
        refreshStatus();
        return;
      }
      return update({ login: { ...$agent.get().login, ...event } });
  }
}

export async function refreshStatus() {
  update({ status: await agent.status() });
}

let initialized = false;
export function initAgent() {
  if (!agent || initialized) return;
  initialized = true;
  agent.onEvent(handleEvent);
  agent.handleTools(runEditorTool);
  refreshStatus();
}

export function sendPrompt(text) {
  updateMessages((m) => [...m, { role: 'user', text }]);
  return agent.prompt(text);
}

export async function newChat() {
  if ($agent.get().busy) {
    await agent.abort();
  }
  update({ messages: [], status: await agent.reset() });
}

export async function login() {
  update({ login: { stage: 'starting' } });
  await agent.login();
}

export async function logout() {
  update({ messages: [], status: await agent.logout() });
}

export async function setModel(id) {
  update({ status: await agent.setModel(id) });
}

export async function setThinkingLevel(level) {
  update({ status: await agent.setThinkingLevel(level) });
}
