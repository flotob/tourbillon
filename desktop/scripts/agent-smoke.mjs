// scripted model for testing the agent without a provider account:
// TOURBILLON_AGENT_SCRIPT=scripts/agent-smoke.mjs pnpm desktop
// every prompt runs the same sequence of tool calls against the real editor
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const piece = `setcpm(124/4)
$: s("bd*4").bank("RolandTR909")
$: s("hh*8").bank("RolandTR909").gain(0.5)`;

export async function setup(runtime) {
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'smoke-test', name: 'smoke test' }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const steps = [
    fauxToolCall('get_code', {}),
    fauxToolCall('check_pattern', { code: piece }),
    fauxToolCall('check_pattern', { code: '$: s("nosuchsound*4")' }),
    fauxToolCall('set_code', { code: piece }),
    fauxToolCall('edit_code', { edits: [{ old_str: 'hh*8', new_str: 'hh*16' }] }),
    fauxToolCall('list_sounds', { query: 'tr909' }),
    fauxToolCall('search_docs', { query: 'reverb' }),
    fauxToolCall('get_status', {}),
  ];
  // the last step queues the sequence again, so every prompt replays it
  const script = () => [
    ...steps.map((call) => fauxAssistantMessage([call])),
    () => {
      faux.appendResponses(script());
      return fauxAssistantMessage('Done: wrote a **909** beat. Press `Ctrl+Enter` to hear it.');
    },
  ];
  faux.setResponses(script());
  return faux.getModel();
}
