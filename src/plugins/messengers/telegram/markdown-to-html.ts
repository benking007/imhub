// Markdown to Telegram HTML converter
// Telegram supports a subset of HTML: <b>, <i>, <u>, <s>, <code>, <pre>, <a>

import { marked } from 'marked'

/**
 * Process math/LaTeX formulas - convert to code blocks
 */
function processMath(markdown: string): string {
  // Block math $$ ... $$ -> code block
  let result = markdown.replace(/\$\$([\s\S]*?)\$\$/g, (_, formula) => {
    return `\`\`\`math\n${formula.trim()}\n\`\`\``
  })

  // Inline math $ ... $ -> inline code (be careful not to match currency)
  result = result.replace(/\$([^$\n]+)\$/g, (_, formula) => {
    // Skip if it looks like currency (e.g., $100, $5.00)
    if (/^\d+(\.\d+)?$/.test(formula.trim())) {
      return `$${formula}$`
    }
    return `\`${formula.trim()}\``
  })

  return result
}

/**
 * Convert HTML to Telegram-compatible HTML
 * Telegram only supports: b, i, u, s, del, strike, code, pre, a, span (tg-spoiler, tg-emoji)
 */
function htmlToTelegramHtml(html: string): string {
  let result = html

  // Convert tables to pre-formatted text
  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows: string[][] = []

    // Extract header rows
    const theadMatch = tableContent.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
    if (theadMatch) {
      const headerRow = extractRowCells(theadMatch[1])
      if (headerRow.length > 0) rows.push(headerRow)
    }

    // Extract body rows
    const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
    const bodyContent = tbodyMatch ? tbodyMatch[1] : tableContent

    // Match all tr elements
    const trMatches = bodyContent.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)
    for (const trMatch of trMatches) {
      const row = extractRowCells(trMatch[1])
      if (row.length > 0) rows.push(row)
    }

    if (rows.length === 0) return ''

    // Calculate column widths
    const colCount = Math.max(...rows.map(r => r.length))
    const widths: number[] = Array(colCount).fill(0)
    for (const row of rows) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i], cell.length)
      })
    }

    // Cap widths at 20 for mobile
    const cappedWidths = widths.map(w => Math.min(w, 20))

    // Format as text table
    const lines: string[] = []
    rows.forEach((row, rowIdx) => {
      const cells = row.map((cell, i) => {
        const width = cappedWidths[i] || 10
        const truncated = cell.length > width ? cell.slice(0, width - 1) + '…' : cell
        return truncated.padEnd(width)
      })
      // Pad missing cells
      while (cells.length < colCount) {
        cells.push(' '.repeat(cappedWidths[cells.length] || 10))
      }
      lines.push('| ' + cells.join(' | ') + ' |')
      // Add separator after header
      if (rowIdx === 0) {
        const separator = cappedWidths.map(w => '-'.repeat(w))
        lines.push('| ' + separator.join(' | ') + ' |')
      }
    })

    return `<pre>${escapeHtml(lines.join('\n'))}</pre>`
  })

  // Helper to extract cells from a row
  function extractRowCells(rowHtml: string): string[] {
    const cells: string[] = []
    const cellMatches = rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)
    for (const match of cellMatches) {
      // Strip HTML tags and get plain text
      const text = match[1].replace(/<[^>]+>/g, '').trim()
      cells.push(text)
    }
    return cells
  }

  // Convert <kbd> to <code>
  result = result.replace(/<kbd>([^<]*)<\/kbd>/gi, '<code>$1</code>')

  // Convert headers to bold
  result = result.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n<b>$1</b>\n\n')

  // Convert lists to bullet points
  result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '\n$1\n')
  result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '\n$1\n')
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '• $1\n')

  // Convert blockquotes to italic
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '<i>$1</i>\n\n')

  // Fix code blocks: convert <pre><code class="lang"> to <pre language="lang">
  result = result.replace(/<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/gi, (_, lang, code) => {
    if (lang) {
      return `<pre language="${lang}">${code}</pre>`
    }
    return `<pre>${code}</pre>`
  })

  // Convert <mark>, <highlight> to <b>
  result = result.replace(/<mark[^>]*>([^<]*)<\/mark>/gi, '<b>$1</b>')
  result = result.replace(/<highlight[^>]*>([^<]*)<\/highlight>/gi, '<b>$1</b>')

  // Strip <sub>, <sup> (no good equivalent)
  result = result.replace(/<su[bp][^>]*>([^<]*)<\/su[bp]>/gi, '$1')

  // Convert semantic tags to Telegram equivalents
  result = result.replace(/<(\/?)strong>/gi, '<$1b>')
  result = result.replace(/<(\/?)em>/gi, '<$1i>')
  result = result.replace(/<(\/?)ins>/gi, '<$1u>')
  result = result.replace(/<(\/?)del>/gi, '<$1s>')
  result = result.replace(/<(\/?)strike>/gi, '<$1s>')

  // Replace <hr> with separator
  result = result.replace(/<hr\s*\/?>/gi, '\n―――\n')

  // Replace <br> with newline
  result = result.replace(/<br\s*\/?>/gi, '\n')

  // Convert images to links
  result = result.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '<a href="$2">$1</a>')
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '<a href="$1">$2</a>')
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '<a href="$1">Image</a>')

  // Strip all other unsupported HTML tags but keep content
  const supportedTags = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'span', 'tg-spoiler', 'tg-emoji'])
  result = result.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (match, isClosing, tagName) => {
    const tag = tagName.toLowerCase()
    if (supportedTags.has(tag)) {
      // For <a>, keep only href attribute
      if (tag === 'a' && !isClosing) {
        const hrefMatch = match.match(/href="([^"]*)"/i) || match.match(/href='([^']*)'/i)
        if (hrefMatch) {
          return `<a href="${hrefMatch[1]}">`
        }
        return '<a href="#">'
      }
      // For <pre>, keep only language attribute (check both class="language-X" and language="X")
      if (tag === 'pre' && !isClosing) {
        // Check for language="X" first (already converted)
        const directLangMatch = match.match(/language="([^"]*)"/i) || match.match(/language='([^']*)'/i)
        if (directLangMatch) {
          return `<pre language="${directLangMatch[1]}">`
        }
        // Then check for class="language-X" (from marked)
        const classLangMatch = match.match(/class="language-([^"]*)"/i) || match.match(/class='language-([^']*)'/i)
        if (classLangMatch) {
          return `<pre language="${classLangMatch[1]}">`
        }
        return '<pre>'
      }
      // Keep supported tags without attributes
      return isClosing ? `</${tag}>` : `<${tag}>`
    }
    // Remove unsupported tag
    return ''
  })

  // Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n')

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert Markdown to Telegram-compatible HTML
 */
export function markdownToTelegramHtml(markdown: string): string {
  // Pre-process: convert math formulas
  const processed = processMath(markdown)

  // Parse markdown to HTML
  const html = marked.parse(processed, {
    gfm: true,
    breaks: false,
  }) as string

  // Convert to Telegram-compatible HTML
  const telegramHtml = htmlToTelegramHtml(html)

  return telegramHtml.trim()
}
