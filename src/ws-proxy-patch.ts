/**
 * Monkey-patch the `ws` module so that every WebSocket opened by discord.js
 * (or any other CJS consumer of `ws`) goes through the HTTP(S) proxy.
 *
 * This file MUST be imported before discord.js is loaded — the @discordjs/ws
 * package captures `ws.WebSocket` at module-evaluation time, so patching
 * later has no effect.
 */
import { createRequire } from 'module';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

if (proxyUrl) {
  const require = createRequire(import.meta.url);
  const wsModule = require('ws') as any;
  const OrigWS = wsModule.WebSocket;
  const agent = new HttpsProxyAgent(proxyUrl);

  const PatchedWS = function (url: string, protocols: any, opts: any) {
    return new OrigWS(url, protocols, { ...opts, agent });
  } as any;
  PatchedWS.prototype = OrigWS.prototype;
  Object.assign(PatchedWS, OrigWS);
  wsModule.WebSocket = PatchedWS;
}
