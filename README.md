# nostr-git-client

Browser-based git sync via Nostr with optional Bitcoin anchoring.

Subscribe to NIP-34 repo state events (kind 30618) and sync git repositories to browser IndexedDB using isomorphic-git.

## Installation

```bash
npm install nostr-git-client
```

## Usage

### Basic Git Sync

```javascript
import { NostrGitClient } from 'nostr-git-client';

const client = new NostrGitClient({
  repo: 'https://solid.social/mel/public/myapp',
  repoId: 'myapp',
  branch: 'main',
  relays: ['wss://relay.damus.io', 'wss://nos.lol'],
  trusted: ['pubkey-hex...']  // Only sync from trusted publishers
});

client.on('sync', (event) => {
  if (event.status === 'complete') {
    console.log('Synced to:', event.commit);
  }
});

client.connect();
await client.sync();

// Read files from synced repo
const content = await client.readFile('index.html');
const files = await client.listFiles('src');
```

### State Management with Bitcoin Anchoring

```javascript
import { NostrGitClient, StateManager } from 'nostr-git-client';

const client = new NostrGitClient({
  repo: 'https://solid.social/mel/public/game',
  trusted: ['pubkey...']
});

const state = new StateManager({
  sync: client,
  file: 'state.json',
  anchor: {
    privkey: 'your-bitcoin-privkey-hex',
    network: 'testnet4'
  },
  onChange: (newState) => {
    console.log('State updated:', newState);
  }
});

await state.init();
client.connect();
await client.sync();

// Anchor current state to Bitcoin
const anchor = await state.anchor();
console.log('Anchored:', anchor.txid);
```

### Self-Deploying Pages

```javascript
import { SelfDeploy } from 'nostr-git-client';

// Auto-reload when repo is updated
SelfDeploy.init({
  repo: 'https://solid.social/mel/public/myapp',
  trusted: ['pubkey...'],
  autoReload: true,
  onUpdate: (event) => {
    console.log('Update detected:', event.commit);
  }
});
```

## API

### NostrGitClient

Main client for Nostr-based git sync.

**Constructor options:**
- `repo` - Git repository URL
- `repoId` - Repository identifier (default: derived from repo URL)
- `branch` - Branch to track (default: 'main')
- `relays` - Nostr relay URLs
- `trusted` - Trusted publisher pubkeys
- `corsProxy` - CORS proxy URL (optional)

**Methods:**
- `connect()` - Connect to relays and start listening
- `disconnect()` - Disconnect from relays
- `sync(commit?)` - Sync to specified commit or latest
- `readFile(path)` - Read file content as string
- `readFileBytes(path)` - Read file as Uint8Array
- `listFiles(path?)` - List directory contents
- `getAllFiles()` - Get all files recursively
- `getCommit()` - Get current commit info
- `clear()` - Delete local repository

**Events:**
- `sync` - Sync status changes
- `event` - Nostr events received
- `connect` - Connected to relay
- `disconnect` - Disconnected from relay
- `error` - Errors

### StateManager

Manages JSON state with optional Bitcoin anchoring.

**Constructor options:**
- `sync` - NostrGitClient instance
- `file` - Path to JSON file (default: 'state.json')
- `anchor` - Bitcoin config: `{ privkey, network }`
- `onChange` - Callback on state changes

**Methods:**
- `init()` - Initialize (loads blocktrails if anchoring)
- `loadState()` - Load state from file
- `get()` - Get current state
- `anchor()` - Anchor state to Bitcoin
- `getAnchors()` - Get anchor history
- `verifyChain()` - Verify anchor chain integrity

### SelfDeploy

Auto-updating pages.

**Static methods:**
- `init(options)` - Initialize self-deploy
- `loaderScript(options)` - Generate embed script
- `serviceWorkerCode()` - Generate SW code

**Options:**
- `repo` - Repository URL (required)
- `trusted` - Trusted pubkeys (required)
- `autoReload` - Auto reload on update (default: true)
- `reloadDelay` - Delay before reload in ms (default: 1000)
- `onUpdate` - Callback on update
- `onSync` - Callback after sync

## Dependencies

- [isomorphic-git](https://isomorphic-git.org/) - Git in JavaScript
- [@isomorphic-git/lightning-fs](https://github.com/isomorphic-git/lightning-fs) - IndexedDB filesystem
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) - Nostr protocol

**Optional:**
- [blocktrails](https://www.npmjs.com/package/blocktrails) - Bitcoin state anchoring

## License

MIT
