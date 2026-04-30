// Multi-tenant workspace registry
//
// Each workspace has its own agent whitelist, rate limits, and config.
// The default workspace handles existing single-tenant deployments.

import { RateLimiter } from './rate-limiter.js'

export interface WorkspaceConfig {
  id: string
  name: string
  agents: string[]          // whitelist of agent names available in this workspace
  rateLimit?: { rate: number; intervalSec: number; burst: number }
  members?: string[]         // userIds with access (empty = open to all)
}

export class Workspace {
  readonly id: string
  readonly name: string
  readonly agentWhitelist: Set<string>
  readonly limiter: RateLimiter
  readonly memberSet: Set<string> | null  // null = open

  constructor(cfg: WorkspaceConfig) {
    this.id = cfg.id
    this.name = cfg.name
    this.agentWhitelist = new Set(cfg.agents)
    this.limiter = new RateLimiter(
      cfg.rateLimit?.rate ?? 10,
      (cfg.rateLimit?.intervalSec ?? 60) * 1000,
      cfg.rateLimit?.burst ?? 15,
    )
    this.memberSet = cfg.members?.length ? new Set(cfg.members) : null
  }

  hasAgent(agent: string): boolean {
    // Empty whitelist = unrestricted. Named whitelist enforces membership.
    if (this.agentWhitelist.size === 0) return true
    return this.agentWhitelist.has(agent)
  }

  hasMember(userId: string): boolean {
    if (!this.memberSet) return true  // open workspace
    return this.memberSet.has(userId)
  }

  allow(userKey: string): boolean {
    return this.limiter.allow(userKey)
  }
}

export class WorkspaceRegistry {
  private workspaces = new Map<string, Workspace>()
  private defaultWorkspace: Workspace

  constructor() {
    // Default workspace is unrestricted (empty whitelist) so any registered
    // agent — including ACP-added custom agents — is reachable without
    // explicit workspace configuration.
    this.defaultWorkspace = new Workspace({
      id: 'default',
      name: 'Default',
      agents: [],
    })
    this.workspaces.set('default', this.defaultWorkspace)
  }

  add(cfg: WorkspaceConfig): void {
    this.workspaces.set(cfg.id, new Workspace(cfg))
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  /** Resolve workspace for a user. Prioritizes named workspaces over default. */
  resolve(userId: string): Workspace {
    for (const ws of this.workspaces.values()) {
      if (ws.id === 'default') continue  // default matches last
      if (ws.hasMember(userId)) return ws
    }
    return this.defaultWorkspace
  }

  /** Load from config */
  load(config: { workspaces?: WorkspaceConfig[] }): void {
    if (config.workspaces) {
      for (const cfg of config.workspaces) {
        this.add(cfg)
      }
    }
  }

  get default(): Workspace { return this.defaultWorkspace }
}

export const workspaceRegistry = new WorkspaceRegistry()
