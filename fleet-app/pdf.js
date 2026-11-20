'use strict';
/**
 * Tiny PDF writer (no dependencies): A4 pages, Helvetica / Helvetica-Bold text, lines, rectangles.
 * Coordinates are in points from the TOP-LEFT corner (y grows downwards) for convenience.
 * Text uses the standard WinAnsi encoding – characters outside it are replaced ("₹" → "Rs.").
 */
const zlib = require('node:zlib');

// Glyph widths (1/1000 em) for ASCII 32–126 – standard Adobe font metrics.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611,
  389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// A few useful characters outside ASCII that WinAnsi has
const WIN = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const EXTRA_W = { 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xB7: 278, 0xB0: 400, 0xD7: 584 };

/** JS string → array of WinAnsi byte codes. */
function encode(str) {
  const out = [];
  for (const ch of String(str ?? '').replace(/₹\s?/g, 'Rs. ').replace(/[→]/g, '->').replace(/[←]/g, '<-').replace(/\s+/g, ' ')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) out.push(c);
    else if (WIN[ch]) out.push(WIN[ch]);
    else if (c >= 0xA0 && c <= 0xFF) out.push(c);
    else out.push(63); // '?'
  }
  return out;
}
function textWidth(str, size, bold = false) {
  const t = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const c of encode(str)) w += c >= 32 && c < 127 ? t[c - 32] : EXTRA_W[c] || 556;
  return (w * size) / 1000;
}
/** Shorten text to fit a width, adding "…". */
function fit(str, maxW, size, bold = false) {
  let s = String(str ?? '');
  if (textWidth(s, size, bold) <= maxW) return s;
  while (s.length > 1 && textWidth(s + '…', size, bold) > maxW) s = s.slice(0, -1);
  return s + '…';
}
const pdfString = (codes) => '(' + codes.map((c) => (c === 40 || c === 41 || c === 92 ? '\\' + String.fromCharCode(c)
  : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c))).join('') + ')';
const n = (v) => (Math.round(v * 100) / 100).toString();
const rgb = (c) => c.map((x) => n(x / 255)).join(' ');

class PDF {
  constructor({ title = 'Report', author = '' } = {}) {
    this.W = 595.28; this.H = 841.89; // A4
    this.margin = 40;
    this.pages = [];
    this.title = title; this.author = author;
    this.addPage();
  }
  addPage() { this.ops = []; this.pages.push(this.ops); this.y = this.margin; return this; }
  get bottom() { return this.H - this.margin - 24; } // space kept for the footer
  /** Start a new page if fewer than `h` points are left. Returns true when a page was added. */
  ensure(h) { if (this.y + h > this.bottom) { this.addPage(); return true; } return false; }
  text(x, y, str, { size = 10, bold = false, color = [17, 24, 39], align = 'left', maxWidth = null } = {}) {
    let s = maxWidth ? fit(str, maxWidth, size, bold) : String(str ?? '');
    const w = textWidth(s, size, bold);
    const tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${n(tx)} ${n(this.H - y - size * 0.8)} Td ${pdfString(encode(s))} Tj ET`);
    return w;
  }
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    const p = `${n(x)} ${n(this.H - y - h)} ${n(w)} ${n(h)} re`;
    if (fill && stroke) this.ops.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${lineWidth} w ${p} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${p} f`);
    else if (stroke) this.ops.push(`${rgb(stroke)} RG ${lineWidth} w ${p} S`);
  }
  line(x1, y1, x2, y2, { color = [229, 231, 235], width = 0.6 } = {}) {
    this.ops.push(`${rgb(color)} RG ${width} w ${n(x1)} ${n(this.H - y1)} m ${n(x2)} ${n(this.H - y2)} l S`);
  }
  /**
   * Table with automatic page breaks (header repeated).
   * columns: [{ label, width, align, bold }]; rows: arrays of strings; options.totals: one bold row at the end.
   */
  table(columns, rows, { x = this.margin, size = 8.5, rowH = 15, headerFill = [15, 118, 110], zebra = [244, 246, 248], totals = null } = {}) {
    const header = () => {
      this.rect(x, this.y, columns.reduce((t, c) => t + c.width, 0), rowH + 2, { fill: headerFill });
      let cx = x;
      for (const c of columns) {
        const tx = c.align === 'right' ? cx + c.width - 4 : cx + 4;
        this.text(tx, this.y + 4.5, c.label, { size, bold: true, color: [255, 255, 255], align: c.align === 'right' ? 'right' : 'left', maxWidth: c.width - 8 });
        cx += c.width;
      }
      this.y += rowH + 2;
    };
    const drawRow = (r, i, bold = false) => {
      if (this.ensure(rowH)) header();
      const width = columns.reduce((t, c) => t + c.width, 0);
      if (bold) this.rect(x, this.y, width, rowH, { fill: [220, 252, 231] });
      else if (i % 2 === 1) this.rect(x, this.y, width, rowH, { fill: zebra });
      let cx = x;
      columns.forEach((c, k) => {
        const tx = c.align === 'right' ? cx + c.width - 4 : cx + 4;
        this.text(tx, this.y + 4, r[k] ?? '', { size, bold: bold || c.bold, align: c.align === 'right' ? 'right' : 'left', maxWidth: c.width - 8 });
        cx += c.width;
      });
      this.y += rowH;
    };
    this.ensure(rowH * 3);
    header();
    rows.forEach((r, i) => drawRow(r, i));
    if (totals) drawRow(totals, 0, true);
  }
  /** Build the file. footer(pageNo, pageCount) → string drawn at the bottom of every page. */
  output(footer = null) {
    if (footer) {
      this.pages.forEach((ops, i) => {
        this.ops = ops;
        this.line(this.margin, this.H - this.margin - 10, this.W - this.margin, this.H - this.margin - 10);
        this.text(this.margin, this.H - this.margin - 4, footer(i + 1, this.pages.length), { size: 7.5, color: [107, 114, 128] });
        this.text(this.W - this.margin, this.H - this.margin - 4, `Page ${i + 1} of ${this.pages.length}`, { size: 7.5, color: [107, 114, 128], align: 'right' });
      });
    }
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const data = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const content = add({ stream: data, dict: `<< /Length ${data.length} /Filter /FlateDecode >>` });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    // document info uses PDFDocEncoding, not WinAnsi – keep it to plain ASCII
    const ascii = (t) => encode(String(t).replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')).map((c) => (c < 127 ? c : 63));
    const info = add(`<< /Title ${pdfString(ascii(this.title))} /Author ${pdfString(ascii(this.author))} /Producer (Fleet Driver Monitor) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const body = typeof o === 'string' ? Buffer.from(o, 'latin1')
        : Buffer.concat([Buffer.from(`${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream', 'latin1')]);
      const tail = Buffer.from('\nendobj\n', 'latin1');
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PDF, textWidth, fit, encode };
