// OpenCode adapter plugin entry — re-exports + driver factory.
//
// Two drivers coexist:
//   • stdio (default): opencode-stdio-adapter.ts — `opencode run --format json`
//   • http: opencode-http-adapter.ts — `opencode serve` + REST + SSE (P1.5+)
//
// Selection: env IMHUB_OPENCODE_DRIVER=http picks the HTTP driver. Anything
// else (incl unset, empty string, unrecognized value) keeps stdio. Default is
// preserved as stdio so this PR is a no-op until ops flip the env.
//
// Why a runtime env switch instead of config: lets us A/B inside a single
// systemd unit by restarting with the env set, with zero config-file edits.
// Once HTTP is proven we promote it to default and can drop the switch.

import { logger } from '../../../core/logger.js'
import { OpenCodeAdapter } from './opencode-stdio-adapter.js'
import { OpenCodeHttpAdapter } from './opencode-http-adapter.js'

export { OpenCodeAdapter } from './opencode-stdio-adapter.js'
export { OpenCodeHttpAdapter } from './opencode-http-adapter.js'

function createOpencodeAdapter(): OpenCodeAdapter {
  const driver = (process.env.IMHUB_OPENCODE_DRIVER || '').toLowerCase()
  if (driver === 'http') {
    return new OpenCodeHttpAdapter()
  }
  if (driver && driver !== 'stdio') {
    logger.warn(
      { component: 'agent.opencode', requestedDriver: driver, fallback: 'stdio' },
      `[opencode] unknown IMHUB_OPENCODE_DRIVER=${driver}, falling back to stdio`,
    )
  }
  return new OpenCodeAdapter()
}

export const opencodeAdapter = createOpencodeAdapter()
