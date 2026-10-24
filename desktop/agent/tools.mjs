import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { formatFunction } from './knowledge.mjs';

const text = (value) => ({ content: [{ type: 'text', text: value }], details: undefined });

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

export function createTools({ callRenderer, knowledge }) {
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

  return [...editorTools, searchDocs, getFunction, readDoc];
}
