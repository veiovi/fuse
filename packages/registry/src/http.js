// HTTP plumbing for the registry: CORS, bounded JSON bodies, JSON errors, and
// a listen/close pair that also ends long-lived SSE streams.
import { createServer } from 'node:http';
import express from 'express';
import { RegistryError } from './registry.js';

export const BODY_LIMIT = '16kb';

/** Demo setting (protocol): any origin may call, including preflighted POSTs. */
export function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'OPTIONS') return next();
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers') || 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.status(204).end();
}

/** JSON bodies up to 16 KB, whatever Content-Type the client sent. */
export const jsonBody = express.json({ limit: BODY_LIMIT, type: () => true });

/** The parsed JSON object body, or {} when there is none. */
export function bodyOf(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

export function notFound(req, res) {
  res.status(404).json({ error: 'not-found', message: `no route for ${req.method} ${req.path}` });
}

// Express error middleware must declare four parameters.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    res.destroy(err);
    return;
  }
  if (err instanceof RegistryError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  const status = err.status ?? err.statusCode;
  if (err.type && status >= 400 && status < 500) {
    // body-parser rejections: oversized, unparseable or badly encoded bodies.
    const error = status === 413 ? 'body-too-large' : 'bad-request';
    const message = status === 413 ? `request bodies are limited to ${BODY_LIMIT}` : 'request body must be JSON';
    res.status(status).json({ error, message });
    return;
  }
  console.error('fuse-registry: unhandled error', err);
  res.status(500).json({ error: 'internal', message: 'internal error' });
}

/** Listen on host:port (0 picks a free port); resolves with the http.Server. */
export function listen(app, { port, host }) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** End SSE streams, stop accepting connections, and wait for in-flight requests (forced after graceMs). */
export function closeServer(server, hub, { graceMs = 2000 } = {}) {
  hub?.close();
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/** Strip trailing slashes from a base URL. */
export const baseUrl = (url) => String(url).replace(/\/+$/, '');
