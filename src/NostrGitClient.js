/**
 * NostrGitClient - Browser-based git sync via Nostr
 *
 * Subscribes to NIP-34 repo state events (kind 30618) and syncs
 * git repositories to browser IndexedDB using isomorphic-git.
 */

import git from 'isomorphic-git';
import { createFS, createHttpClient, parseRepoEvent, verifyEvent } from './utils.js';

export class NostrGitClient {
  /**
   * Create a new NostrGitClient
   * @param {Object} options
   * @param {string} options.repo - Git repository URL
   * @param {string} options.repoId - Repository identifier (for Nostr d tag)
   * @param {string} options.branch - Branch to track (default: 'main')
   * @param {string[]} options.relays - Nostr relay URLs
   * @param {string[]} options.trusted - Trusted publisher pubkeys
   * @param {string} options.dir - Local directory path (default: /<repoId>)
   * @param {LightningFS} options.fs - Filesystem instance (optional)
   * @param {Object} options.http - HTTP client (optional)
   * @param {string} options.corsProxy - CORS proxy URL (optional)
   */
  constructor(options) {
    this.repo = options.repo;
    this.repoId = options.repoId || options.repo.split('/').pop();
    this.branch = options.branch || 'main';
    this.relays = options.relays || ['wss://relay.damus.io', 'wss://nos.lol'];
    this.trusted = options.trusted || [];
    this.dir = options.dir || `/${this.repoId}`;

    this.fs = options.fs || createFS();
    this.pfs = this.fs.promises;
    this.http = options.http || createHttpClient({ corsProxy: options.corsProxy });

    this.websockets = [];
    this.listeners = new Map();
    this.currentCommit = null;
    this.synced = false;
    this.syncing = false;
  }

  /**
   * Add event listener
   * @param {string} event - Event name: 'sync', 'event', 'error', 'connect', 'disconnect'
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return this;
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const idx = listeners.indexOf(callback);
      if (idx >= 0) listeners.splice(idx, 1);
    }
    return this;
  }

  /**
   * Emit event to listeners
   */
  emit(event, ...args) {
    const listeners = this.listeners.get(event) || [];
    listeners.forEach(cb => {
      try { cb(...args); } catch (e) { console.error('Listener error:', e); }
    });
  }

  /**
   * Connect to Nostr relays and start listening
   */
  connect() {
    this.disconnect(); // Clean up existing connections

    this.relays.forEach((url, i) => {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        this.emit('connect', url);

        // Subscribe to repo state events
        ws.send(JSON.stringify([
          'REQ',
          `ngc-${i}`,
          {
            kinds: [30618],
            '#d': [this.repoId],
            limit: 1
          }
        ]));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg[0] === 'EVENT' && msg[2]) {
            this.handleEvent(msg[2]);
          }
        } catch {}
      };

      ws.onclose = () => {
        this.emit('disconnect', url);
      };

      ws.onerror = (err) => {
        this.emit('error', new Error(`WebSocket error: ${url}`));
      };

      this.websockets.push(ws);
    });

    return this;
  }

  /**
   * Disconnect from all relays
   */
  disconnect() {
    this.websockets.forEach(ws => ws.close());
    this.websockets = [];
    return this;
  }

  /**
   * Handle incoming Nostr event
   */
  async handleEvent(event) {
    // Verify signature
    if (!await verifyEvent(event)) {
      this.emit('error', new Error('Invalid event signature'));
      return;
    }

    // Check if from trusted publisher
    if (this.trusted.length > 0 && !this.trusted.includes(event.pubkey)) {
      this.emit('event', { type: 'untrusted', event });
      return;
    }

    // Parse event
    const parsed = parseRepoEvent(event);
    if (!parsed) return;

    this.emit('event', { type: 'repo', ...parsed });

    // Check if we need to sync
    if (parsed.repoId === this.repoId && parsed.branch === this.branch) {
      if (this.currentCommit !== parsed.commit) {
        await this.sync(parsed.commit);
      }
    }
  }

  /**
   * Sync repository to specified commit (or latest)
   * @param {string} targetCommit - Commit hash to checkout (optional)
   * @returns {Object} Sync result
   */
  async sync(targetCommit = null) {
    if (this.syncing) {
      return { success: false, error: 'Already syncing' };
    }

    this.syncing = true;
    this.emit('sync', { status: 'start', commit: targetCommit });

    try {
      // Check if already cloned
      let needsClone = true;
      try {
        await this.pfs.stat(`${this.dir}/.git`);
        needsClone = false;
      } catch {}

      if (needsClone) {
        // Ensure directory exists
        try { await this.pfs.mkdir(this.dir); } catch {}

        await git.clone({
          fs: this.fs,
          http: this.http,
          dir: this.dir,
          url: this.repo,
          ref: this.branch,
          singleBranch: true,
          depth: 10
        });
      } else {
        // Fetch updates
        await git.fetch({
          fs: this.fs,
          http: this.http,
          dir: this.dir,
          url: this.repo,
          ref: this.branch,
          singleBranch: true
        });
      }

      // Checkout to specific commit or branch head
      const ref = targetCommit || this.branch;
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref,
        force: true
      });

      // Get current commit info
      const commits = await git.log({ fs: this.fs, dir: this.dir, depth: 1 });
      const commit = commits[0];
      this.currentCommit = commit?.oid;
      this.synced = true;
      this.syncing = false;

      const result = {
        success: true,
        commit: commit?.oid,
        message: commit?.commit.message,
        author: commit?.commit.author.name,
        date: new Date(commit?.commit.author.timestamp * 1000)
      };

      this.emit('sync', { status: 'complete', ...result });
      return result;

    } catch (err) {
      this.syncing = false;
      this.emit('sync', { status: 'error', error: err.message });
      this.emit('error', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Read a file from the synced repository
   * @param {string} path - File path relative to repo root
   * @returns {string} File content
   */
  async readFile(path) {
    return this.pfs.readFile(`${this.dir}/${path}`, 'utf8');
  }

  /**
   * Read a file as bytes
   * @param {string} path - File path
   * @returns {Uint8Array} File content
   */
  async readFileBytes(path) {
    return this.pfs.readFile(`${this.dir}/${path}`);
  }

  /**
   * List files in directory
   * @param {string} path - Directory path (default: repo root)
   * @returns {Array} File entries
   */
  async listFiles(path = '') {
    const fullPath = `${this.dir}/${path}`.replace(/\/+$/, '');
    const entries = await this.pfs.readdir(fullPath);

    const result = [];
    for (const entry of entries) {
      if (entry === '.git') continue;
      const stat = await this.pfs.stat(`${fullPath}/${entry}`);
      result.push({
        name: entry,
        path: path ? `${path}/${entry}` : entry,
        type: stat.isDirectory() ? 'dir' : 'file'
      });
    }

    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get all files recursively
   * @returns {Array} All file paths
   */
  async getAllFiles() {
    const files = [];
    const walk = async (path) => {
      const entries = await this.listFiles(path);
      for (const entry of entries) {
        if (entry.type === 'dir') {
          await walk(entry.path);
        } else {
          files.push(entry.path);
        }
      }
    };
    await walk('');
    return files;
  }

  /**
   * Get current commit info
   * @returns {Object} Commit info
   */
  async getCommit() {
    const commits = await git.log({ fs: this.fs, dir: this.dir, depth: 1 });
    if (commits.length === 0) return null;

    const c = commits[0];
    return {
      hash: c.oid,
      message: c.commit.message,
      author: c.commit.author.name,
      email: c.commit.author.email,
      date: new Date(c.commit.author.timestamp * 1000)
    };
  }

  /**
   * Clear local repository from IndexedDB
   */
  async clear() {
    const deleteRecursive = async (path) => {
      try {
        const entries = await this.pfs.readdir(path);
        for (const entry of entries) {
          const fullPath = `${path}/${entry}`;
          const stat = await this.pfs.stat(fullPath);
          if (stat.isDirectory()) {
            await deleteRecursive(fullPath);
          } else {
            await this.pfs.unlink(fullPath);
          }
        }
        await this.pfs.rmdir(path);
      } catch {}
    };

    await deleteRecursive(this.dir);
    this.currentCommit = null;
    this.synced = false;
  }
}
