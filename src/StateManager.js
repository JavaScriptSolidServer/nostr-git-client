/**
 * StateManager - JSON state management with optional Bitcoin anchoring
 *
 * Manages a JSON state file from a synced git repository.
 * Optionally anchors state changes to Bitcoin via blocktrails.
 */

export class StateManager {
  /**
   * Create a StateManager
   * @param {Object} options
   * @param {NostrGitClient} options.sync - NostrGitClient instance
   * @param {string} options.file - Path to JSON state file (default: 'state.json')
   * @param {Object} options.anchor - Bitcoin anchoring options (optional)
   * @param {string} options.anchor.privkey - Private key hex for anchoring
   * @param {string} options.anchor.network - 'testnet4' or 'mainnet' (default: 'testnet4')
   * @param {Function} options.onChange - Callback when state changes
   */
  constructor(options) {
    this.sync = options.sync;
    this.file = options.file || 'state.json';
    this.anchorConfig = options.anchor || null;
    this.onChange = options.onChange || null;

    this.state = null;
    this.stateHash = null;
    this.anchors = [];
    this.blocktrails = null;

    // Listen for sync events
    this.sync.on('sync', async (event) => {
      if (event.status === 'complete') {
        await this.loadState();
      }
    });
  }

  /**
   * Initialize the state manager
   * Loads blocktrails if anchoring is enabled
   */
  async init() {
    // Try to load blocktrails for anchoring
    if (this.anchorConfig) {
      try {
        const bt = await import('blocktrails');
        this.blocktrails = bt;
      } catch {
        console.warn('blocktrails not available - anchoring disabled');
        this.anchorConfig = null;
      }
    }

    // Load initial state if synced
    if (this.sync.synced) {
      await this.loadState();
    }

    return this;
  }

  /**
   * Load state from the synced file
   */
  async loadState() {
    try {
      const content = await this.sync.readFile(this.file);
      const newState = JSON.parse(content);
      const newHash = await this.hashState(newState);

      if (newHash !== this.stateHash) {
        this.state = newState;
        this.stateHash = newHash;

        if (this.onChange) {
          this.onChange(this.state);
        }
      }

      return this.state;
    } catch (err) {
      // File might not exist yet
      if (err.code === 'ENOENT') {
        this.state = {};
        this.stateHash = null;
        return this.state;
      }
      throw err;
    }
  }

  /**
   * Get current state
   * @returns {Object} Current state
   */
  get() {
    return this.state;
  }

  /**
   * Hash state for anchoring/comparison
   * @param {Object} state - State to hash
   * @returns {string} SHA-256 hash hex
   */
  async hashState(state) {
    const json = JSON.stringify(state, null, 2);
    const bytes = new TextEncoder().encode(json);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Anchor current state to Bitcoin
   * Creates a P2TR output committing to the state hash
   * @returns {Object} Anchor result with txid
   */
  async anchor() {
    if (!this.blocktrails || !this.anchorConfig) {
      throw new Error('Anchoring not configured');
    }

    if (!this.state || !this.stateHash) {
      throw new Error('No state to anchor');
    }

    const bt = this.blocktrails;
    const privkey = this.anchorConfig.privkey;
    const network = this.anchorConfig.network || 'testnet4';

    // Get previous anchor states for chaining
    const prevStates = this.anchors.map(a => a.hash);
    const allStates = [...prevStates, this.stateHash];

    // Derive pubkey from privkey
    const pubkeyBase = bt.getPublicKey(privkey);

    // For first anchor, derive simple tweaked address
    // For subsequent anchors, use chained derivation
    let fromPubkey, toPubkey;

    if (prevStates.length === 0) {
      // First anchor - spend from base key to tweaked key
      fromPubkey = pubkeyBase;
      toPubkey = bt.derivePubkey(pubkeyBase, this.stateHash);
    } else {
      // Chained anchor - spend from previous tweaked to new tweaked
      fromPubkey = bt.deriveChainedPubkey(pubkeyBase, prevStates);
      toPubkey = bt.deriveChainedPubkey(pubkeyBase, allStates);
    }

    // Get UTXOs from previous address
    const fromAddress = bt.pubkeyToAddress(fromPubkey, network);
    const utxos = await bt.fetchUTXOs(fromAddress, network);

    if (utxos.length === 0) {
      throw new Error(`No funds at ${fromAddress}`);
    }

    // Use largest UTXO
    const utxo = utxos.reduce((a, b) => a.value > b.value ? a : b);

    // Create and broadcast transaction
    const toAddress = bt.pubkeyToAddress(toPubkey, network);
    const fee = 300; // Minimal fee for P2TR

    const tx = bt.createAnchorTx({
      utxo,
      privkey,
      prevStates,
      newState: this.stateHash,
      toAddress,
      fee,
      network
    });

    const txid = await bt.broadcastTx(tx, network);

    // Record anchor
    const anchor = {
      txid,
      hash: this.stateHash,
      address: toAddress,
      timestamp: Date.now(),
      state: JSON.parse(JSON.stringify(this.state))
    };

    this.anchors.push(anchor);

    return anchor;
  }

  /**
   * Get all anchors
   * @returns {Array} List of anchors
   */
  getAnchors() {
    return this.anchors;
  }

  /**
   * Verify anchor chain
   * Checks that all anchors form a valid chain
   * @returns {boolean} True if valid
   */
  async verifyChain() {
    if (!this.blocktrails || this.anchors.length === 0) {
      return true;
    }

    const bt = this.blocktrails;
    const network = this.anchorConfig?.network || 'testnet4';
    const pubkeyBase = bt.getPublicKey(this.anchorConfig.privkey);

    // Verify each anchor has the expected address
    const states = [];
    for (const anchor of this.anchors) {
      states.push(anchor.hash);
      const expectedPubkey = bt.deriveChainedPubkey(pubkeyBase, states);
      const expectedAddress = bt.pubkeyToAddress(expectedPubkey, network);

      if (anchor.address !== expectedAddress) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get anchor chain storage key
   */
  get storageKey() {
    return `state-anchors-${this.sync.repoId}-${this.file}`;
  }

  /**
   * Save anchors to localStorage
   */
  saveAnchors() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.storageKey, JSON.stringify(this.anchors));
    }
  }

  /**
   * Load anchors from localStorage
   */
  loadAnchors() {
    if (typeof localStorage !== 'undefined') {
      try {
        const saved = localStorage.getItem(this.storageKey);
        if (saved) {
          this.anchors = JSON.parse(saved);
        }
      } catch {}
    }
  }
}
