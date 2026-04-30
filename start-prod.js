const { registry } = await import('./dist/core/registry.js');
const { sessionManager } = await import('./dist/core/session.js');
const { workspaceRegistry } = await import('./dist/core/workspace.js');
const { startWebServer } = await import('./dist/web/server.js');
const { startACPServer } = await import('./dist/core/acp-server.js');

await sessionManager.start();
await registry.loadBuiltInPlugins();
workspaceRegistry.load({});

await startWebServer({ port: 3000, defaultAgent: 'opencode' });
await startACPServer({ port: 9090, defaultAgent: 'opencode' });
