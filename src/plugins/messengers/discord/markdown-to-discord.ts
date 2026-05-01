// Markdown to Discord format converter
// Discord natively supports: **bold**, *italic*, ~~strikethrough~~, `code`, ```code blocks```, > blockquote
// For long messages, we can use Embeds for richer formatting

/**
 * Convert standard Markdown to Discord-compatible Markdown.
 *
 * Discord already supports most GFM, so the main job here is:
 *  1. Strip unsupported HTML tags (Discord ignores them)
 *  2. Convert <b>/<i>/<s> to Discord markdown equivalents
 *  3. Ensure code blocks are preserved
 *  4. Convert headings to bold (Discord doesn't render # in regular messages)
 */
export function markdownToDiscord(markdown: string): string {
  let result = markdown

  // Convert HTML bold/strong to Discord **bold**
  result = result.replace(/<\/?(?:b|strong)>/gi, '**')

  // Convert HTML italic/em to Discord *italic*
  result = result.replace(/<\/?(?:i|em)>/gi, '*')

  // Convert HTML strikethrough to Discord ~~strike~~
  result = result.replace(/<\/?(?:s|del|strike)>/gi, '~~')

  // Convert HTML underline to Discord __underline__
  result = result.replace(/<\/?(?:u|ins)>/gi, '__')

  // Convert HTML code to Discord `code`
  result = result.replace(/<code>([^<]*)<\/code>/gi, '`$1`')

  // Convert HTML links to Discord links
  result = result.replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')

  // Convert HTML lists to plain text bullets
  result = result.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '\n$1')
  result = result.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '\n$1')
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')

  // Convert HTML blockquotes to Discord > blockquote
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content: string) => {
    return content
      .split('\n')
      .map((line: string) => `> ${line}`)
      .join('\n')
  })

  // Convert headings (# syntax) to bold text for regular messages
  // (Discord doesn't render heading syntax in normal messages)
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, text) => {
    return `**${text}**`
  })

  // Convert <hr> to separator
  result = result.replace(/<hr\s*\/?>/gi, '\n---\n')

  // Convert <br> to newline
  result = result.replace(/<br\s*\/?>/gi, '\n')

  // Strip remaining HTML tags
  result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '')

  // Decode common HTML entities
  result = result.replace(/&amp;/g, '&')
  result = result.replace(/&lt;/g, '<')
  result = result.replace(/&gt;/g, '>')
  result = result.replace(/&quot;/g, '"')
  result = result.replace(/&#39;/g, "'")

  // Clean up excess blank lines
  result = result.replace(/\n{3,}/g, '\n\n')

  return result.trim()
}
