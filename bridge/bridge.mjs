#!/usr/bin/env node
/**
 * Tarka MCP bridge: connects an external LLM harness (any MCP client, e.g. Claude Code or
 * Codex) to the Tarka browser extension.
 *
 *   MCP client <-> (stdio, JSON-RPC) <-> this process <-> (WebSocket) <-> Tarka extension
 *
 * stdout carries ONLY MCP JSON-RPC traffic; every diagnostic goes to stderr. The shared token
 * lives in ~/.tarka/bridge.json and must be pasted once into the Tarka side panel.
 */

// stdout is the MCP stream: force any stray console.log to stderr.
console.log = (...a) => console.error(...a);

async function main() {
  let wsServerMod, mcpServerMod, sessionMod, tokenStoreMod, protocolMod;
  try {
    wsServerMod = await import('./wsServer.mjs');
    mcpServerMod = await import('./mcpServer.mjs');
    sessionMod = await import('./session.mjs');
    tokenStoreMod = await import('./tokenStore.mjs');
    protocolMod = await import('./protocol.mjs');
  } catch (err) {
    console.error(`[bridge] missing dependencies (${err?.message ?? err}). Please run: cd bridge && npm install`);
    process.exit(1);
  }

  const log = (msg) => console.error(`[bridge] ${msg}`);

  // Arguments
  const argv = process.argv.slice(2);
  let port = 7877;
  let tokenFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (flag === '--port') port = Number(value);
    if (flag === '--token-file') tokenFile = value;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('[bridge] invalid --port value');
    process.exit(1);
  }

  const { token, created } = tokenStoreMod.loadOrCreateToken(tokenFile);
  if (created) log(`Tarka Bridge Token: ${token}  (paste this once into the Tarka side panel settings)`);

  // Only one bridge process can hold the WebSocket port the extension dials. When another
  // harness's bridge already owns it, exiting would make the MCP client report "failed to
  // connect" and hide every tool; instead keep serving MCP and answer tool calls with a
  // clear error (the session's portNotOwned flag). Other bind errors are still fatal.
  const server = await wsServerMod.startWsServer({ port, token, log }).catch((err) => {
    log(`could not bind 127.0.0.1:${port}: ${err?.message ?? err}`);
    if (err?.code === 'EADDRINUSE') {
      log(`port ${port} is already owned by another bridge process (started by another harness). ` +
        `This bridge serves MCP but cannot reach the extension; stop the other bridge ` +
        `(or quit that harness) and restart this one.`);
      return null;
    }
    process.exit(1);
  });
  if (server) log(`listening on 127.0.0.1:${server.port} (waiting for the Tarka extension to connect)`);

  let currentSocket = null;

  const session = new sessionMod.BridgeSession({
    sendToExtension: (type, payload, id) => {
      if (!currentSocket) {
        log(`cannot send ${type}: no extension connected`);
        return;
      }
      try {
        currentSocket.send(protocolMod.encodeFrame(type, payload, id));
      } catch (err) {
        log(`send ${type} failed: ${err?.message ?? err}`);
      }
    },
    isConnected: () => currentSocket !== null,
    portNotOwned: server === null,
    notify: (params) => {
      if (params.progressToken == null) return;
      try {
        mcpServer.notification({ method: 'notifications/progress', params });
      } catch (err) {
        log(`progress notification failed: ${err?.message ?? err}`);
      }
    },
    log,
  });

  if (server) {
    server.onConnection((socket) => {
      log('extension connected');
      if (currentSocket) {
        log('replacing a previously connected extension');
        try { currentSocket.close(); } catch { /* already gone */ }
      }
      currentSocket = socket;
      socket.on('message', (data) => {
        const frame = protocolMod.parseFrame(data.toString());
        if (!frame) {
          log('ignoring a malformed frame');
          return;
        }
        session.onFrame(frame);
      });
      socket.on('close', () => {
        if (currentSocket === socket) {
          currentSocket = null;
          log('extension disconnected');
          session.onDisconnect();
        }
      });
      socket.on('error', () => {});
    });

    // Keep the extension's service worker alive while connected: a WebSocket ping every 20 s
    // resets Chrome MV3's 30 s idle timer.
    const wsPing = setInterval(() => {
      if (currentSocket) {
        try { currentSocket.ping(); } catch { /* socket gone */ }
      }
    }, 20_000);
    wsPing.unref();
  }

  const mcpServer = await mcpServerMod.runMcpServer({ session, log });
  log('MCP server ready on stdio');

  // SIGINT/SIGTERM: stop any active browser run before exiting.
  const shutdown = (signal) => {
    log(`received ${signal}, stopping any active run and exiting`);
    try {
      if (currentSocket) session.stopActive();
    } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[bridge] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
