// the strudel docs (website/src/pages) and function reference (doc.json), searchable by the agent
import fs from 'node:fs';
import path from 'node:path';

const entities = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };

// doc.json descriptions are html
function htmlToText(html = '') {
  return html
    .replace(/<code>(.*?)<\/code>/g, '`$1`')
    .replace(/<\/p>\s*/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot|#39);/g, (m) => entities[m])
    .trim();
}

export function formatFunction(doc) {
  const lines = [`### ${doc.name}`];
  if (doc.synonyms?.length) {
    lines.push(`synonyms: ${doc.synonyms.join(', ')}`);
  }
  if (doc.description) {
    lines.push(htmlToText(doc.description));
  }
  for (const param of doc.params ?? []) {
    const type = param.type?.names?.join(' | ');
    lines.push(`- param \`${param.name}\`${type ? ` (${type})` : ''}: ${htmlToText(param.description)}`);
  }
  for (const example of doc.examples ?? []) {
    lines.push('```js\n' + example.trim() + '\n```');
  }
  return lines.join('\n');
}

// turns an mdx page into markdown: code examples are kept, components are dropped
function mdxToText(source, functions) {
  return (
    source
      .replace(/^---[\s\S]*?---\s*/, '')
      .replace(/^import .*$/gm, '')
      .replace(/<MiniRepl[\s\S]*?tune=\{`([\s\S]*?)`\}[\s\S]*?\/>/g, (_, tune) => '\n```js\n' + tune.trim() + '\n```\n')
      .replace(/<JsDoc[^>]*?name="([^"]+)"[^>]*?\/>/g, (_, name) => {
        const doc = functions.get(name);
        return doc ? '\n' + formatFunction(doc) + '\n' : '';
      })
      // only components (uppercase) and images: lowercase <...> is usually mini-notation
      .replace(/<\/?[A-Z][^>]*>/g, '')
      .replace(/<img[^>]*>(<\/img>)?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function listMdx(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // german translations duplicate the english pages
      return entry.name === 'de' ? [] : listMdx(full, base);
    }
    return entry.name.endsWith('.mdx') ? [path.relative(base, full).replace(/\.mdx$/, '')] : [];
  });
}

const tokenize = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function splitSections(page, text) {
  const sections = [];
  let heading = page.title;
  let lines = [];
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) {
      sections.push({ page: page.id, heading, text: body });
    }
  };
  let inCode = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      inCode = !inCode;
    }
    const match = !inCode && line.match(/^#{1,3} (.*)/);
    if (match) {
      flush();
      heading = match[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

export function loadKnowledge(repoDir) {
  const functions = new Map();
  const docJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'doc.json'), 'utf8'));
  for (const doc of docJson.docs) {
    if (!doc.name || doc.name.startsWith('_') || doc.kind === 'package') continue;
    if (!doc.description && !doc.examples) continue;
    functions.set(doc.name, doc);
    for (const synonym of doc.synonyms ?? []) {
      if (!functions.has(synonym)) {
        functions.set(synonym, doc);
      }
    }
  }

  const pagesDir = path.join(repoDir, 'website/src/pages');
  const pages = new Map();
  for (const id of listMdx(pagesDir)) {
    const source = fs.readFileSync(path.join(pagesDir, id + '.mdx'), 'utf8');
    const title = source.match(/^title:\s*(.*)$/m)?.[1]?.trim() ?? id;
    pages.set(id, { id, title, text: mdxToText(source, functions) });
  }

  const sections = [...pages.values()].flatMap((page) => splitSections(page, page.text));
  for (const doc of new Set(functions.values())) {
    sections.push({ page: 'reference', heading: doc.name, text: formatFunction(doc), fn: doc.name });
  }

  // bm25 over sections, headings weigh more than body text
  for (const section of sections) {
    section.terms = new Map();
    const add = (token, weight) => section.terms.set(token, (section.terms.get(token) ?? 0) + weight);
    tokenize(section.heading).forEach((token) => add(token, 3));
    tokenize(section.text).forEach((token) => add(token, 1));
    section.length = [...section.terms.values()].reduce((a, b) => a + b, 0);
  }
  const avgLength = sections.reduce((sum, s) => sum + s.length, 0) / sections.length;
  const docFreq = new Map();
  for (const section of sections) {
    for (const token of section.terms.keys()) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  function search(query, limit = 6) {
    const tokens = [...new Set(tokenize(query))];
    const exact = query.trim();
    const scored = sections.map((section) => {
      let score = 0;
      for (const token of tokens) {
        const tf = section.terms.get(token);
        if (!tf) continue;
        const idf = Math.log(1 + (sections.length - docFreq.get(token) + 0.5) / (docFreq.get(token) + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (section.length / avgLength)));
      }
      if (section.fn && section.fn === exact) {
        score += 100;
      }
      return { section, score };
    });
    // a function's docs appear on a learn page and in the reference: keep the better match
    const seen = new Set();
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .filter(({ section }) => !seen.has(section.heading) && seen.add(section.heading))
      .slice(0, limit)
      .map(({ section }) => section);
  }

  return {
    functionCount: new Set(functions.values()).size,
    pageCount: pages.size,
    search,
    getFunction: (name) => functions.get(name),
    getPage: (id) => pages.get(id.replace(/^\/|\/$/g, '')),
    listPages: () => [...pages.values()].map(({ id, title }) => ({ id, title })),
  };
}
