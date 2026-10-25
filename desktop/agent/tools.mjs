import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { formatFunction } from './knowledge.mjs';

const text = (value) => ({ content: [{ type: 'text', text: value }], details: undefined });

const PARTS = ['drums', 'bass', 'other', 'vocals'];
// bar ranges are [start, end); shown with the last bar included
const barRanges = (ranges = []) =>
  ranges.length
    ? ranges.map(([start, end]) => (end - start > 1 ? `${start}-${end - 1}` : `${start}`)).join(', ')
    : 'nowhere';
const minutes = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
// dBFS to 0 (silent) .. 9 (loudest)
const levelDigit = (db) => Math.max(0, Math.min(9, Math.round((db + 54) / 5)));

function describeRecord(record, { levels = false } = {}) {
  const by = record.artist ? ` by ${record.artist}` : '';
  const parts = PARTS.filter((stem) => record.stems.includes(stem));
  const lines = [
    `${record.name}: "${record.title}"${by}`,
    `${+record.bpm.toFixed(2)} bpm, ${record.bars} bars (0-${record.bars - 1}) of ${(240 / record.bpm).toFixed(3)}s, ${minutes(record.duration)}`,
  ];
  if (record.key) {
    const [tonic, scale] = record.key.split(' ');
    lines.push(
      `key ${record.key} (Camelot ${record.camelot}, strength ${record.key_strength}); in strudel .scale("${tonic}:${scale}")`,
    );
  }
  lines.push(
    record.versions?.length
      ? `versions with the same pitch at ${record.versions.join(', ')} bpm`
      : 'no versions at other tempos',
    `sounds: ${record.stems.map((stem) => `${record.name}_${stem}`).join(', ')}`,
  );
  if (record.playing) {
    lines.push(...parts.map((stem) => `${stem} plays in bars ${barRanges(record.playing[stem])}`));
  }
  if (levels && record.levels) {
    lines.push(
      '',
      'Loudness per bar, 0 = silent to 9 = loudest:',
      ['bars'.padEnd(10), ...parts.map((p) => p.padEnd(9))].join(''),
    );
    for (let start = 0; start < record.bars; start += 8) {
      const end = Math.min(start + 8, record.bars);
      const digits = parts.map((stem) => record.levels[stem].slice(start, end).map(levelDigit).join('').padEnd(9));
      lines.push([`${start}-${end - 1}`.padEnd(10), ...digits].join(''));
    }
  }
  return lines.join('\n');
}

// editor tools run in the renderer, where the editor and the strudel runtime live
function rendererTool({ name, label, description, parameters }, callRenderer) {
  return defineTool({
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params, signal) {
      const result = await callRenderer(name, params, signal);
      if (result.error) {
        throw new Error(result.error);
      }
      return text(result.text);
    },
  });
}

export function createTools({ callRenderer, knowledge, crate }) {
  const editorTools = [
    {
      name: 'get_code',
      label: 'Read editor',
      description:
        "Returns the current code in the user's editor, and the user's selection if there is one. Call this before changing code; the user edits by hand between turns.",
      parameters: Type.Object({}),
    },
    {
      name: 'edit_code',
      label: 'Edit code',
      description:
        'Applies text replacements to the editor as one undoable change. Each old_str must match the current editor text exactly (including whitespace) and occur exactly once; include surrounding lines to make it unique. All edits apply or none. Does not evaluate: the user presses Ctrl+Enter to hear the change. Returns the updated code.',
      parameters: Type.Object({
        edits: Type.Array(
          Type.Object({
            old_str: Type.String({ description: 'Exact text to replace' }),
            new_str: Type.String({ description: 'Replacement text' }),
          }),
          { minItems: 1 },
        ),
      }),
    },
    {
      name: 'set_code',
      label: 'Replace code',
      description:
        'Replaces the whole editor content as one undoable change. Use for a new piece or a requested rewrite; prefer edit_code otherwise. Does not evaluate.',
      parameters: Type.Object({ code: Type.String() }),
    },
    {
      name: 'check_pattern',
      label: 'Check pattern',
      description:
        'Evaluates Strudel code silently, without touching the editor or the music that is playing. Reports syntax and runtime errors, sound names that are not loaded, the tempo, and a summary of the events in the first cycles. Pass the complete code you intend to put in the editor; omit code to check the current editor content.',
      parameters: Type.Object({
        code: Type.Optional(Type.String()),
        cycles: Type.Optional(Type.Number({ description: 'Cycles to query, default 4', minimum: 1, maximum: 64 })),
      }),
    },
    {
      name: 'get_status',
      label: 'Read status',
      description:
        'Returns whether music is playing, the current tempo, whether the editor has changes that were not evaluated yet, and the last evaluation error, if any.',
      parameters: Type.Object({}),
    },
    {
      name: 'list_sounds',
      label: 'List sounds',
      description:
        'Lists the loaded sounds: synths, drum machine banks, sample sets and soundfonts. Pass a query to filter names (e.g. "909", "bass", "piano").',
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    },
  ].map((tool) => rendererTool(tool, callRenderer));

  const searchDocs = defineTool({
    name: 'search_docs',
    label: 'Search docs',
    description:
      'Searches the Strudel documentation and function reference. Returns the best matching sections with examples. Use plain keywords, e.g. "reverb", "euclidean rhythm", "chord voicings".',
    parameters: Type.Object({ query: Type.String() }),
    async execute(_toolCallId, { query }) {
      const sections = knowledge.search(query);
      if (!sections.length) {
        return text(`No results for "${query}".`);
      }
      const results = sections.map((section) => {
        const body = section.text.length > 1500 ? section.text.slice(0, 1500) + '\n[...]' : section.text;
        return `## ${section.heading}\n(page: ${section.page})\n\n${body}`;
      });
      return text(results.join('\n\n---\n\n'));
    },
  });

  const getFunction = defineTool({
    name: 'get_function',
    label: 'Function reference',
    description: 'Returns the reference documentation of one Strudel function: description, parameters and examples.',
    parameters: Type.Object({ name: Type.String({ description: 'Function name, e.g. "lpf" or "jux"' }) }),
    async execute(_toolCallId, { name }) {
      const doc = knowledge.getFunction(name.replace(/^\./, '').replace(/\(.*$/, ''));
      if (!doc) {
        throw new Error(`No function named "${name}" in the reference. Try search_docs.`);
      }
      return text(formatFunction(doc));
    },
  });

  const readDoc = defineTool({
    name: 'read_doc',
    label: 'Read docs page',
    description:
      'Returns a full page of the Strudel documentation. Use a page id from search_docs results, e.g. "learn/effects" or "understand/cycles".',
    parameters: Type.Object({ page: Type.String() }),
    async execute(_toolCallId, { page }) {
      const doc = knowledge.getPage(page);
      if (!doc) {
        const ids = knowledge.listPages().map((p) => p.id);
        throw new Error(`No page "${page}". Pages: ${ids.join(', ')}`);
      }
      const body = doc.text.length > 30000 ? doc.text.slice(0, 30000) + '\n[truncated]' : doc.text;
      return text(`# ${doc.title}\n\n${body}`);
    },
  });

  const listRecords = defineTool({
    name: 'list_records',
    label: 'List records',
    description:
      "Lists the records in the user's crate (tracks separated into stems and cut into bars): name, title, tempo, key, versions at other tempos, bars and where each stem plays.",
    parameters: Type.Object({}),
    async execute() {
      const records = crate?.records() ?? [];
      if (!records.length) {
        return text('The crate is empty. The user can drop audio files on the app to import them.');
      }
      return text(records.map((record) => describeRecord(record)).join('\n\n'));
    },
  });

  const getRecord = defineTool({
    name: 'get_record',
    label: 'Read record',
    description:
      'Returns one record of the crate: tempo, key, versions at other tempos, bar count, sound names, the bar ranges where each stem plays, and the loudness of each stem per bar.',
    parameters: Type.Object({ name: Type.String({ description: 'Record name, e.g. "nataalma"' }) }),
    async execute(_toolCallId, { name }) {
      const records = crate?.records() ?? [];
      const record = records.find((r) => r.name === name.trim().toLowerCase());
      if (!record) {
        throw new Error(`No record named "${name}". Records: ${records.map((r) => r.name).join(', ') || 'none'}`);
      }
      return text(describeRecord(record, { levels: true }));
    },
  });

  const makeTempoVersion = defineTool({
    name: 'make_tempo_version',
    label: 'Make tempo version',
    description:
      "Makes a version of a record at another tempo with the same pitch, in the background (about 3 seconds per minute of the record). Once it exists, the record's sounds play it whenever the code runs near that tempo; until then they play the original.",
    parameters: Type.Object({
      name: Type.String({ description: 'Record name, e.g. "nataalma"' }),
      bpm: Type.Number({ description: 'The tempo of the code, e.g. 124 for setcpm(124/4)' }),
    }),
    async execute(_toolCallId, { name: given, bpm }) {
      if (!crate) {
        throw new Error('The crate is not available.');
      }
      const name = given.trim().toLowerCase();
      const { state } = crate.makeVersion(name, bpm);
      const messages = {
        original: `${name} is ${bpm} bpm already; no version is needed.`,
        exists: `${name} has a version at ${bpm} bpm already.`,
        queued: `The ${bpm} bpm version of ${name} is queued; the crate tab shows its progress.`,
        running: `The ${bpm} bpm version of ${name} is being made; the crate tab shows its progress.`,
      };
      return text(messages[state]);
    },
  });

  return [...editorTools, searchDocs, getFunction, readDoc, listRecords, getRecord, makeTempoVersion];
}
