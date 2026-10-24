import { useStore } from '@nanostores/react';
import { useEffect, useRef, useState } from 'react';
import cx from '@src/cx.mjs';
import { useSettings } from '../../settings.mjs';
import {
  $agent,
  agent,
  initAgent,
  login,
  logout,
  newChat,
  sendPrompt,
  setModel,
  setThinkingLevel,
} from './agentStore.mjs';

const toolLabels = {
  get_code: 'read the editor',
  edit_code: 'edited the code',
  set_code: 'replaced the code',
  check_pattern: 'checked the pattern',
  get_status: 'read the status',
  list_sounds: 'listed sounds',
  search_docs: 'searched the docs',
  get_function: 'looked up a function',
  read_doc: 'read a docs page',
};

function toolDetail({ name, args }) {
  if (name === 'search_docs') return args?.query;
  if (name === 'get_function') return args?.name;
  if (name === 'read_doc') return args?.page;
  if (name === 'list_sounds') return args?.query;
  if (name === 'edit_code') return `${args?.edits?.length ?? 0} change(s)`;
}

// minimal markdown: fenced code blocks, inline code, bold
function Markdown({ text }) {
  const parts = text.split(/```[a-z]*\n?([\s\S]*?)(?:```|$)/g);
  return parts.map((part, i) =>
    i % 2 ? (
      <pre key={i} className="bg-background p-2 my-1 rounded-md overflow-x-auto text-xs">
        {part.trimEnd()}
      </pre>
    ) : (
      <span key={i} className="whitespace-pre-wrap">
        {part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((span, j) =>
          span.startsWith('`') ? (
            <code key={j} className="bg-background px-1 rounded">
              {span.slice(1, -1)}
            </code>
          ) : span.startsWith('**') ? (
            <strong key={j}>{span.slice(2, -2)}</strong>
          ) : (
            span
          ),
        )}
      </span>
    ),
  );
}

function ToolCall({ message }) {
  const [open, setOpen] = useState(false);
  const detail = toolDetail(message);
  return (
    <div className="text-xs opacity-70">
      <button className="hover:opacity-50 text-left" onClick={() => setOpen(!open)}>
        {message.done ? (message.isError ? '✕' : '✓') : '…'} {toolLabels[message.name] ?? message.name}
        {detail ? `: ${detail}` : ''}
      </button>
      {open && message.result && (
        <pre className="bg-background p-2 mt-1 rounded-md overflow-x-auto whitespace-pre-wrap">{message.result}</pre>
      )}
    </div>
  );
}

function Message({ message }) {
  if (message.role === 'user') {
    return <div className="bg-background rounded-md px-3 py-2 whitespace-pre-wrap">{message.text}</div>;
  }
  if (message.role === 'tool') {
    return <ToolCall message={message} />;
  }
  if (message.role === 'error') {
    return <div className="text-background bg-foreground rounded-md px-3 py-2">{message.text}</div>;
  }
  if (!message.text && message.done) {
    return null;
  }
  return (
    <div>
      {message.thinking && !message.text && <div className="text-xs opacity-50 italic">thinking…</div>}
      <Markdown text={message.text} />
    </div>
  );
}

function Login({ state }) {
  const { login: loginState } = state;
  const [pasted, setPasted] = useState('');
  const waiting = loginState && loginState.stage !== 'failed';
  return (
    <div className="p-4 space-y-4 text-foreground">
      <p>
        The agent writes and changes code in your editor when you ask it to. It never plays anything itself: you decide
        when to hear a change with Ctrl+Enter.
      </p>
      {!waiting && (
        <button className="bg-background px-4 py-2 rounded-md hover:opacity-50" onClick={login}>
          Sign in with ChatGPT
        </button>
      )}
      {waiting && (
        <div className="space-y-2">
          <p>{loginState.message ?? 'Complete the sign-in in your browser.'}</p>
          {loginState.stage === 'prompt' && (
            <form
              className="flex space-x-2"
              onSubmit={(e) => {
                e.preventDefault();
                agent.pasteLoginUrl(pasted);
              }}
            >
              <input
                className="grow bg-background px-2 py-1 rounded-md border-none text-sm"
                placeholder="If the browser shows an error, paste its address here"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <button className="px-2 hover:opacity-50">submit</button>
            </form>
          )}
          <button className="text-sm underline hover:opacity-50" onClick={() => agent.cancelLogin()}>
            cancel
          </button>
        </div>
      )}
      {loginState?.stage === 'failed' && <p className="text-sm">Sign-in failed: {loginState.message}</p>}
    </div>
  );
}

function Select({ value, options, onChange, title }) {
  return (
    <select
      title={title}
      className="bg-background text-foreground text-xs border-none rounded-md py-1 pl-2 pr-6"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function AgentTab() {
  const state = useStore($agent);
  const { fontFamily } = useSettings();
  const [input, setInput] = useState('');
  const scrollRef = useRef();
  const { status, messages, busy } = state;

  useEffect(() => {
    initAgent();
  }, []);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!agent) {
    return <div className="p-4 text-foreground">The agent is only available in the desktop app.</div>;
  }
  if (!status) {
    return <div className="p-4 text-foreground">loading…</div>;
  }
  if (!status.loggedIn) {
    return <Login state={state} />;
  }

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    sendPrompt(text);
  };

  return (
    <div className="flex flex-col h-full text-foreground text-sm" style={{ fontFamily }}>
      <div className="flex items-center space-x-2 px-2 py-1 border-b border-muted">
        <Select
          title="model"
          value={status.model}
          options={status.models.map((m) => ({ value: m.id, label: m.name }))}
          onChange={setModel}
        />
        <Select
          title="thinking"
          value={status.thinkingLevel}
          options={status.thinkingLevels.map((level) => ({ value: level, label: `thinking: ${level}` }))}
          onChange={setThinkingLevel}
        />
        <div className="grow" />
        <button className="text-xs hover:opacity-50" onClick={newChat}>
          new chat
        </button>
        <button className="text-xs hover:opacity-50" onClick={logout}>
          sign out
        </button>
      </div>
      <div ref={scrollRef} className="grow overflow-auto p-2 space-y-3">
        {!messages.length && (
          <div className="opacity-50 p-2">
            Ask for something, e.g. "make a 130 bpm techno beat" or "make the hihats more interesting". Select code in
            the editor to talk about just that part.
          </div>
        )}
        {messages.map((message, i) => (
          <Message key={i} message={message} />
        ))}
        {busy && <div className="text-xs opacity-50">working…</div>}
      </div>
      <form
        className="flex items-end space-x-2 p-2 border-t border-muted"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          rows={2}
          className="grow bg-background text-foreground rounded-md border-none resize-none text-sm"
          placeholder="Ask the agent…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="px-2 py-1 hover:opacity-50" onClick={() => agent.abort()}>
            stop
          </button>
        ) : (
          <button type="submit" className="px-2 py-1 hover:opacity-50">
            send
          </button>
        )}
      </form>
    </div>
  );
}
