import {
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { closeBracketsKeymap } from '@codemirror/autocomplete';
import { Compartment } from '@codemirror/state';

// reconfiguring this compartment clears the undo history
export const historyCompartment = new Compartment();

// Taken + slightly modified from https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts

export const basicSetup = (() => [
  //   lineNumbers(),
  //   highlightActiveLineGutter(),
  highlightSpecialChars(),
  historyCompartment.of(history()),
  // foldGutter(),
  // drawSelection(),
  dropCursor(),
  // EditorState.allowMultipleSelections.of(true),
  // indentOnInput(),
  // syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  // autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  // highlightActiveLine(),
  // highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    // ...searchKeymap,
    ...historyKeymap,
    // ...foldKeymap,
    // ...completionKeymap,
  ]),
])();

/// A minimal set of extensions to create a functional editor. Only
/// includes [the default keymap](#commands.defaultKeymap), [undo
/// history](#commands.history), [special character
/// highlighting](#view.highlightSpecialChars), [custom selection
/// drawing](#view.drawSelection), and [default highlight
/// style](#language.defaultHighlightStyle).
export const minimalSetup = (() => [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  keymap.of([...defaultKeymap, ...historyKeymap]),
])();
