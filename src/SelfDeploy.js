/**
 * SelfDeploy - Auto-updating pages via Nostr git sync
 *
 * Enables pages to automatically reload when their source repo
 * receives updates via Nostr announcements.
 */

import { NostrGitClient } from './NostrGitClient.js';

export class SelfDeploy {
  /**
   * Initialize self-deploying page
   *
   * @param {Object} options
   * @param {string} options.repo - Git repository URL
   * @param {string} options.repoId - Repository identifier (optional, derived from repo)
   * @param {string} options.branch - Branch to track (default: 'main')
   * @param {string[]} options.relays - Nostr relay URLs
   * @param {string[]} options.trusted - Trusted publisher pubkeys (required for auto-reload)
   * @param {Function} options.onUpdate - Called when update detected (default: reload page)
   * @param {Function} options.onSync - Called after sync completes
   * @param {Function} options.onError - Called on errors
   * @param {boolean} options.autoReload - Auto reload on update (default: true)
   * @param {number} options.reloadDelay - Delay before reload in ms (default: 1000)
   * @param {string} options.corsProxy - CORS proxy URL (optional)
   * @returns {SelfDeploy} Instance
   */
  static init(options) {
    return new SelfDeploy(options);
  }

  constructor(options) {
    if (!options.repo) {
      throw new Error('repo is required');
    }

    if (!options.trusted || options.trusted.length === 0) {
      throw new Error('trusted pubkeys required for SelfDeploy');
    }

    this.options = {
      autoReload: true,
      reloadDelay: 1000,
      branch: 'main',
      ...options
    };

    this.client = new NostrGitClient({
      repo: this.options.repo,
      repoId: this.options.repoId,
      branch: this.options.branch,
      relays: this.options.relays,
      trusted: this.options.trusted,
      corsProxy: this.options.corsProxy
    });

    this.currentCommit = null;
    this.setupListeners();
    this.client.connect();
  }

  setupListeners() {
    // Track sync events
    this.client.on('sync', (event) => {
      if (event.status === 'complete') {
        const isUpdate = this.currentCommit && this.currentCommit !== event.commit;
        this.currentCommit = event.commit;

        if (this.options.onSync) {
          this.options.onSync(event);
        }

        if (isUpdate) {
          this.handleUpdate(event);
        }
      }

      if (event.status === 'error' && this.options.onError) {
        this.options.onError(new Error(event.error));
      }
    });

    // Track repo events from trusted publishers
    this.client.on('event', (event) => {
      if (event.type === 'repo') {
        // New commit announced - trigger sync
        if (event.commit !== this.currentCommit) {
          this.client.sync(event.commit);
        }
      }
    });

    // Forward errors
    this.client.on('error', (err) => {
      if (this.options.onError) {
        this.options.onError(err);
      }
    });

    // Log connections
    this.client.on('connect', (url) => {
      console.log(`[SelfDeploy] Connected to ${url}`);
    });
  }

  handleUpdate(event) {
    console.log(`[SelfDeploy] Update detected: ${event.commit?.slice(0, 8)}`);

    if (this.options.onUpdate) {
      this.options.onUpdate(event);
    }

    if (this.options.autoReload) {
      console.log(`[SelfDeploy] Reloading in ${this.options.reloadDelay}ms...`);
      setTimeout(() => {
        location.reload();
      }, this.options.reloadDelay);
    }
  }

  /**
   * Manually trigger sync
   * @returns {Promise<Object>} Sync result
   */
  sync() {
    return this.client.sync();
  }

  /**
   * Get current commit info
   * @returns {Promise<Object>} Commit info
   */
  getCommit() {
    return this.client.getCommit();
  }

  /**
   * Read a file from the synced repo
   * @param {string} path - File path
   * @returns {Promise<string>} File content
   */
  readFile(path) {
    return this.client.readFile(path);
  }

  /**
   * List files in directory
   * @param {string} path - Directory path
   * @returns {Promise<Array>} File entries
   */
  listFiles(path) {
    return this.client.listFiles(path);
  }

  /**
   * Check if synced
   * @returns {boolean}
   */
  get synced() {
    return this.client.synced;
  }

  /**
   * Disconnect from relays
   */
  disconnect() {
    this.client.disconnect();
  }

  /**
   * Create a minimal loader script for embedding
   * Returns HTML that can be injected to enable self-deploy
   *
   * @param {Object} options - Same as constructor options
   * @returns {string} Script tag HTML
   */
  static loaderScript(options) {
    const config = JSON.stringify(options);
    return `<script type="module">
import { SelfDeploy } from 'nostr-git-client';
SelfDeploy.init(${config});
</script>`;
  }

  /**
   * Create a service worker for offline-first self-deploy
   * The service worker syncs in the background and notifies the page
   *
   * @returns {string} Service worker code
   */
  static serviceWorkerCode() {
    return `
// SelfDeploy Service Worker
// Syncs git repo in background and caches files

const CACHE_NAME = 'selfdeploy-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('message', async (event) => {
  if (event.data.type === 'SYNC') {
    // Notify all clients of update
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'UPDATE', commit: event.data.commit });
    });
  }
});

self.addEventListener('fetch', (event) => {
  // Cache-first strategy for synced files
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request);
    })
  );
});
`;
  }
}
