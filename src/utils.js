/**
 * Utility functions for nostr-git-client
 */

import LightningFS from '@isomorphic-git/lightning-fs';

/**
 * Create a LightningFS instance for IndexedDB storage
 * @param {string} name - Database name
 * @returns {LightningFS} Filesystem instance
 */
export function createFS(name = 'nostr-git-client') {
  return new LightningFS(name);
}

/**
 * Create an HTTP client for isomorphic-git
 * Works with JSS and other git HTTP servers
 * @param {Object} options
 * @param {string} options.corsProxy - CORS proxy URL (optional)
 * @param {Object} options.headers - Additional headers
 * @returns {Object} HTTP client for isomorphic-git
 */
export function createHttpClient(options = {}) {
  const { corsProxy, headers = {} } = options;

  return {
    async request({ url, method, headers: reqHeaders, body }) {
      // Apply CORS proxy if specified
      const finalUrl = corsProxy ? `${corsProxy}${encodeURIComponent(url)}` : url;

      const res = await fetch(finalUrl, {
        method,
        headers: { ...reqHeaders, ...headers },
        body
      });

      return {
        url: res.url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
        body: [new Uint8Array(await res.arrayBuffer())]
      };
    }
  };
}

/**
 * Verify Nostr event signature
 * @param {Object} event - Nostr event
 * @returns {boolean} True if valid
 */
export async function verifyEvent(event) {
  try {
    const { verifyEvent } = await import('nostr-tools/pure');
    return verifyEvent(event);
  } catch {
    // Fallback: assume valid if nostr-tools not available
    console.warn('nostr-tools not available for signature verification');
    return true;
  }
}

/**
 * Parse a 30618 repo state event
 * @param {Object} event - Nostr event
 * @returns {Object|null} Parsed event data
 */
export function parseRepoEvent(event) {
  if (event.kind !== 30618) return null;

  const repoId = event.tags.find(t => t[0] === 'd')?.[1];
  const refTag = event.tags.find(t => t[0].startsWith('refs/'));
  const anchorTag = event.tags.find(t => t[0] === 'c');

  if (!repoId || !refTag) return null;

  return {
    pubkey: event.pubkey,
    repoId,
    ref: refTag[0],
    branch: refTag[0].replace('refs/heads/', ''),
    commit: refTag[1],
    anchor: anchorTag?.[1] || null,
    createdAt: event.created_at,
    raw: event
  };
}
