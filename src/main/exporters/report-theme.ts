export interface ExportDocumentInput {
  title: string;
  body: string;
  fontBase64: string;
  a4: boolean;
}

export function buildReportDocument(input: ExportDocumentInput): string {
  const body = /<h1(?:\s|>)/i.test(input.body)
    ? input.body
    : `<h1>${escapeText(input.title)}</h1>${input.body}`;
  const sheetSize = input.a4
    ? 'width:210mm;min-height:297mm;padding:18mm 18mm 20mm;'
    : 'width:min(100%,1040px);min-height:720px;padding:64px 72px 72px;';
  const pageSize = input.a4 ? 'A4 portrait' : 'auto';
  const pageMargin = input.a4 ? '16mm' : '12mm';

  return `<!doctype html>
<html lang="ko" data-layout="${input.a4 ? 'a4' : 'web'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
  <title>${escapeText(input.title)}</title>
  <style>
    @font-face {
      font-family: Pretendard;
      src: url(data:font/woff2;base64,${input.fontBase64}) format('woff2');
      font-style: normal;
      font-weight: 45 920;
      font-display: swap;
    }
    :root {
      --report-accent: #a50034;
      --report-accent-deep: #790027;
      --report-accent-soft: #f7e9ee;
      --report-ink: #262124;
      --report-muted: #6f676b;
      --report-border: #d9d3d5;
      --report-surface: #f7f5f4;
      --report-paper: #ffffff;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html {
      margin: 0;
      background: #ebe8e7;
      color: var(--report-ink);
      font-family: Pretendard, sans-serif;
      line-height: 1.68;
      word-break: keep-all;
      overflow-wrap: anywhere;
    }
    body {
      margin: 0;
      padding: 48px 24px;
      background: #ebe8e7;
    }
    .report-sheet {
      position: relative;
      ${sheetSize}
      margin: 0 auto;
      overflow: hidden;
      background: var(--report-paper);
      border: 1px solid #ded9da;
      box-shadow: 0 14px 40px rgba(48, 37, 41, 0.12);
    }
    .report-sheet::before {
      position: absolute;
      inset: 0 0 auto;
      height: 6px;
      background: var(--report-accent);
      content: '';
    }
    .report-content {
      max-width: 100%;
      color: var(--report-ink);
      font-size: 10.5pt;
      letter-spacing: -0.012em;
    }
    h1, h2, h3, h4 {
      color: var(--report-ink);
      font-weight: 700;
      line-height: 1.34;
      break-after: avoid-page;
      page-break-after: avoid;
    }
    h1 {
      margin: 4px 0 34px;
      padding: 0 0 18px;
      border-bottom: 2px solid var(--report-accent);
      color: var(--report-accent-deep);
      font-size: 27pt;
      letter-spacing: -0.035em;
    }
    h2 {
      margin: 34px 0 14px;
      padding: 2px 0 2px 12px;
      border-left: 4px solid var(--report-accent);
      font-size: 17pt;
      letter-spacing: -0.025em;
    }
    h3 {
      margin: 26px 0 10px;
      padding-bottom: 7px;
      border-bottom: 1px solid var(--report-border);
      color: #3e3539;
      font-size: 13.5pt;
    }
    h4 {
      margin: 20px 0 8px;
      color: #554a4f;
      font-size: 11.5pt;
    }
    p { margin: 0 0 12px; }
    strong { color: #3a1522; font-weight: 700; }
    ul, ol { margin: 10px 0 16px; padding-left: 1.55em; }
    li { margin: 5px 0; padding-left: 0.2em; }
    li::marker { color: var(--report-accent); font-weight: 700; }
    blockquote, .report-callout {
      margin: 18px 0;
      padding: 14px 17px;
      border: 0;
      border-left: 4px solid var(--report-accent);
      border-radius: 0 5px 5px 0;
      background: var(--report-accent-soft);
      color: #4b3740;
      break-inside: avoid-page;
    }
    blockquote > :last-child, .report-callout > :last-child { margin-bottom: 0; }
    table {
      width: 100%;
      margin: 18px 0 22px;
      border: 1px solid #cfc7ca;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 9.4pt;
      line-height: 1.48;
    }
    th, td {
      padding: 9px 10px;
      border-right: 1px solid var(--report-border);
      border-bottom: 1px solid var(--report-border);
      text-align: left;
      vertical-align: top;
    }
    th:last-child, td:last-child { border-right: 0; }
    tr:last-child > td { border-bottom: 0; }
    th {
      background: #f3e7eb;
      color: #55152a;
      font-weight: 700;
    }
    thead { display: table-header-group; }
    thead th {
      background: var(--report-accent-deep);
      color: #ffffff;
      border-color: #9d526a;
    }
    tbody tr:nth-child(even) td { background: #faf9f9; }
    tr { break-inside: avoid-page; page-break-inside: avoid; }
    figure {
      margin: 22px auto;
      text-align: center;
      break-inside: avoid-page;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 3px;
    }
    figcaption {
      margin-top: 7px;
      color: var(--report-muted);
      font-size: 8.8pt;
      text-align: center;
    }
    pre {
      margin: 16px 0;
      padding: 14px 16px;
      overflow: auto;
      border: 1px solid #ded8da;
      border-radius: 5px;
      background: #292428;
      color: #f8f6f7;
      font-family: Pretendard, sans-serif;
      font-size: 9pt;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    code {
      padding: 0.12em 0.32em;
      border-radius: 3px;
      background: #f1edef;
      color: #6e1834;
      font-family: Pretendard, sans-serif;
      font-size: 0.92em;
    }
    pre code { padding: 0; background: transparent; color: inherit; }
    a { color: #7e1235; text-decoration-color: #c47c94; text-underline-offset: 2px; }
    hr {
      height: 1px;
      margin: 28px 0;
      border: 0;
      background: var(--report-border);
    }
    .source-note {
      margin: 16px 0;
      padding: 10px 12px;
      border: 1px solid var(--report-border);
      border-radius: 4px;
      background: var(--report-surface);
      color: var(--report-muted);
      font-size: 8.8pt;
    }
    .source-ref {
      color: var(--report-accent-deep);
      font-size: 0.9em;
      font-weight: 600;
    }
    .page-break { break-before: page; page-break-before: always; }
    @page { size: ${pageSize}; margin: ${pageMargin}; }
    @media (max-width: 860px) {
      body { padding: 0; }
      .report-sheet {
        width: 100%;
        min-height: 100vh;
        padding: 38px 24px 48px;
        border: 0;
        box-shadow: none;
      }
      h1 { font-size: 23pt; }
      h2 { font-size: 15pt; }
      table { display: block; overflow-x: auto; }
    }
    @media print {
      html, body { background: #ffffff; }
      body { padding: 0; }
      .report-sheet {
        width: auto;
        min-height: auto;
        padding: 0;
        overflow: visible;
        border: 0;
        box-shadow: none;
      }
      .report-sheet::before { display: none; }
      .report-content { font-size: 10pt; }
      a { color: inherit; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <main class="report-sheet">
    <article class="report-content">${body}</article>
  </main>
</body>
</html>`;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
