// @fuse/gateway: require a Fuse proof on protected routes, then hand over to
// an ordinary session. Two integration styles over one core (gateway.js):
//
//   app.use(fuseGateway({ siteName, origins, protect: ['/v1/*'], registries, log }));  // Express middleware
//   await startProxyGateway({ port, upstream, protect, registries, log });            // reverse proxy
import { createGateway } from './gateway.js';

export { BURNED_REASON, DEFAULT_INSTALL_URL, createGateway } from './gateway.js';
export { startProxyGateway } from './proxy.js';
export { checkRequest } from './spec.js';
export { createChallenges, CHALLENGE_TTL_SECONDS } from './challenge.js';
export { cookieNameFor } from './sessions.js';
export { compileProtect } from './paths.js';

/**
 * Express middleware. Mount it before your routes:
 *
 *   app.use(fuseGateway({ siteName: 'Bolt API', origins: ['http://api.localhost:4720'],
 *                         protect: ['/v1/*'], registries: [url], log: url }));
 *
 * It serves /.fuse/*, answers unauthenticated requests to protected paths
 * with 401 challenges, and lets authenticated ones through with
 * req.fuse = { pseudonym, short, reputation }. `origins` is required (a
 * TypeError otherwise): requests that reach a protected path under any other
 * Host are redirected to origins[0] (GET/HEAD) or refused with 421. Call
 * `.close()` on shutdown to stop following revocations and flush the
 * reputation store.
 *
 * @param {object} options docs/protocol.md §8
 * @returns {import('express').RequestHandler & { gateway: object, close(): void }}
 */
export function fuseGateway(options) {
  const gateway = createGateway(options);
  const middleware = (req, res, next) => gateway.handle(req, res, next);
  middleware.gateway = gateway;
  middleware.close = () => gateway.close();
  return middleware;
}
