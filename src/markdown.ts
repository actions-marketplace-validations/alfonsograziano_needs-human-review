// Text from the PR (file names, title) and from the model goes into the PR
// comment. These helpers keep it plain text: no new blocks, headings, HTML,
// images, links or @mentions.

/** A code span that holds any text, backticks and newlines included. */
export function code(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') || flat === '' ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * One line of untrusted text for a list item or a paragraph. Newlines are
 * collapsed, HTML is escaped, images and links are broken, @mentions do not
 * ping, block syntax at the start is escaped, and the length is capped.
 * Code spans made by `code()` are kept as they are.
 */
export function inline(text: string, max = 500): string {
  const parts = text.replace(/\s*[\r\n]+\s*/g, ' ').split(/(`+[^`]*?`+)/g);
  let out = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // a code span
      return part
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/!\[/g, '!\\[')
        .replace(/\]\(/g, ']\\(')
        .replace(/@(?=[A-Za-z0-9])/g, '@​');
    })
    .join('');
  out = out.replace(/^(\s*)([#=|+*~-]|\d+[.)])/, '$1\\$2');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
