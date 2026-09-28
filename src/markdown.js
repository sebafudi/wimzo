// Render only known Markdown tokens through DOM APIs. Source HTML stays inert.
export function markdownRenderer(lexer, document) {
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const decode = value => String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name) => {
    const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if (name[0] !== '#') return named[name.toLowerCase()] ?? match;
    const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2),16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd';
  });
  function safeLink(value) {
    const href = decode(value).trim();
    if (!/^https?:\/\//i.test(href)) return null;
    try { const url = new URL(href); return ['http:','https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
  }
  function children(parent, tokens = [], depth = 0) {
    if (depth > 50) { parent.append(node('span', '[Nested content omitted]')); return; }
    for (const token of tokens) {
      let el;
      switch (token.type) {
        case 'space': case 'def': continue;
        case 'heading': el = node('h' + Math.min(6, Math.max(1, token.depth))); break;
        case 'paragraph': el = node('p'); break;
        case 'strong': el = node('strong'); break;
        case 'em': el = node('em'); break;
        case 'del': el = node('del'); break;
        case 'blockquote': el = node('blockquote'); break;
        case 'br': el = node('br'); break;
        case 'hr': el = node('hr'); break;
        case 'code': el = node('pre'); el.append(node('code', token.text)); parent.append(el); continue;
        case 'codespan': parent.append(node('code', decode(token.text))); continue;
        case 'html': parent.append(node('span', token.raw || token.text)); continue;
        case 'image': parent.append(node('span', '[Image: ' + decode(token.text) + ']')); continue;
        case 'link': {
          const href = safeLink(token.href);
          el = node(href ? 'a' : 'span');
          if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
          else el.title = decode(token.href);
          break;
        }
        case 'list': {
          el = node(token.ordered ? 'ol' : 'ul');
          if (token.ordered && token.start !== 1) el.start = token.start;
          for (const item of token.items) {
            const li = node('li');
            if (item.task) { const check = node('input'); check.type = 'checkbox'; check.disabled = true; check.checked = item.checked; check.setAttribute('aria-label', item.checked ? 'Completed' : 'Not completed'); li.append(check); }
            children(li, item.tokens, depth + 1); el.append(li);
          }
          parent.append(el); continue;
        }
        case 'table': {
          const wrap = node('div'); wrap.className = 'markdown-table'; el = node('table');
          const head = node('thead'), row = node('tr');
          token.header.forEach(cell => { const th = node('th'); children(th, cell.tokens, depth + 1); row.append(th); }); head.append(row); el.append(head);
          const body = node('tbody');
          for (const cells of token.rows) { const tr = node('tr'); cells.forEach(cell => { const td = node('td'); children(td, cell.tokens, depth + 1); tr.append(td); }); body.append(tr); }
          el.append(body); wrap.append(el); parent.append(wrap); continue;
        }
        case 'text': case 'escape':
          if (token.tokens) children(parent, token.tokens, depth + 1);
          else parent.append(document.createTextNode(decode(token.text)));
          continue;
        default: parent.append(document.createTextNode(token.raw || token.text || '')); continue;
      }
      if (token.tokens) children(el, token.tokens, depth + 1);
      else if (token.text) el.textContent = decode(token.text);
      parent.append(el);
    }
  }
  function blocks(source) {
    if (source.length > 200000 || source.split('\n').length > 2000) throw new Error('This document is too large for formatted review. Use Raw diff.');
    const tokens = lexer(source, {gfm:true}).filter(t => !['space','def'].includes(t.type));
    if (tokens.length > 1000) throw new Error('This document has too many sections for formatted review. Use Raw diff.');
    return tokens;
  }
  function render(source) { const article = node('article'); article.className = 'markdown-document'; children(article, blocks(source || '')); return article; }
  function compare(before, after) {
    const old = blocks(before || ''), next = blocks(after || '');
    // Compare complete rendered blocks so changed references and formatting count too.
    const key = token => { const el = node('div'); children(el, [token]); return el.innerHTML; };
    const a = old.map(key), b = next.map(key);
    const widths = b.length + 1, table = new Uint16Array((a.length + 1) * widths);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * widths + j] = a[i] === b[j] ? 1 + table[(i+1)*widths+j+1] : Math.max(table[(i+1)*widths+j],table[i*widths+j+1]);
    const article = node('article'); article.className = 'markdown-document markdown-comparison';
    function add(token, change) { const section = node('div'); section.className = 'markdown-block ' + change; if (change !== 'unchanged') { const label = node('div', change === 'added' ? 'Added' : 'Removed'); label.className = 'markdown-change-label'; section.append(label); } children(section,[token]); article.append(section); }
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { add(next[j++],'unchanged'); i++; }
      else if (i < a.length && (j === b.length || table[(i+1)*widths+j] >= table[i*widths+j+1])) add(old[i++],'removed');
      else add(next[j++],'added');
    }
    if (!article.querySelector('.added,.removed')) { const message = node('p', before === after ? 'No content changes.' : 'The rendered content is unchanged. Raw diff shows source formatting changes.'); message.className = 'markdown-hint'; article.prepend(message); }
    return article;
  }
  return {render,compare};
}
