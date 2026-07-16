/**
 * A small, provider-agnostic queue for WeChat tasks.
 *
 * Each sender has a single execution lane. Messages received while a task is
 * running are retained and coalesced into the next turn instead of being
 * rejected. The queue deliberately knows nothing about Codex, Claude Code or
 * the transport so it can be tested without either CLI being installed.
 */
export class PeerTaskQueue {
  constructor({ handler, batchKey, debounceMs = 650, maxPendingPerPeer = 20, maxConcurrent = 2, onError } = {}) {
    if (typeof handler !== "function") throw new TypeError("PeerTaskQueue handler is required");
    this.handler = handler;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.maxPendingPerPeer = Math.max(1, Number(maxPendingPerPeer) || 20);
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 2);
    this.onError = typeof onError === "function" ? onError : () => {};
    this.batchKey = typeof batchKey === "function" ? batchKey : () => "default";
    this.peers = new Map();
    this.activeCount = 0;
    this.waitingPeers = [];
    this.closed = false;
  }

  #peer(peerId) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { pending: [], active: false, waiting: false, timer: undefined, idleWaiters: [] };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  enqueue(peerId, item, { immediate = false } = {}) {
    if (!peerId) throw new TypeError("peerId is required");
    if (this.closed) return { accepted: false, active: false, pending: 0, closed: true };
    const peer = this.#peer(peerId);
    if (peer.pending.length >= this.maxPendingPerPeer) {
      return { accepted: false, active: peer.active, pending: peer.pending.length };
    }
    peer.pending.push(item);
    if (!peer.active) this.#schedule(peerId, immediate ? 0 : this.debounceMs);
    return { accepted: true, active: peer.active, pending: peer.pending.length };
  }

  #schedule(peerId, delayMs) {
    const peer = this.#peer(peerId);
    if (this.closed || peer.timer || peer.active || !peer.pending.length) return;
    peer.timer = setTimeout(() => {
      peer.timer = undefined;
      void this.#drain(peerId);
    }, delayMs);
  }

  async #drain(peerId) {
    const peer = this.#peer(peerId);
    if (this.closed || peer.active || !peer.pending.length) return;
    if (this.activeCount >= this.maxConcurrent) {
      if (!peer.waiting) {
        peer.waiting = true;
        this.waitingPeers.push(peerId);
      }
      return;
    }
    peer.waiting = false;
    peer.active = true;
    this.activeCount += 1;
    const firstKey = this.batchKey(peer.pending[0]);
    let batchSize = 1;
    while (batchSize < peer.pending.length && this.batchKey(peer.pending[batchSize]) === firstKey) batchSize += 1;
    const batch = peer.pending.splice(0, batchSize);
    try {
      await this.handler(peerId, batch);
    } catch (error) {
      await this.onError(error, { peerId, batch });
    } finally {
      peer.active = false;
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (peer.pending.length && !this.closed) {
        this.#schedule(peerId, this.debounceMs);
      } else {
        if (this.closed) peer.pending = [];
        const waiters = peer.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
      this.#startWaitingPeers();
    }
  }

  #startWaitingPeers() {
    while (!this.closed && this.activeCount < this.maxConcurrent && this.waitingPeers.length) {
      const peerId = this.waitingPeers.shift();
      const peer = this.peers.get(peerId);
      if (!peer) continue;
      peer.waiting = false;
      if (!peer.active && peer.pending.length) void this.#drain(peerId);
    }
  }

  status(peerId) {
    const peer = this.peers.get(peerId);
    return {
      active: Boolean(peer?.active),
      pending: peer?.pending.length || 0,
      debouncing: Boolean(peer?.timer),
    };
  }

  clear(peerId) {
    return this.takePending(peerId).length;
  }

  takePending(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return [];
    const items = peer.pending;
    peer.pending = [];
    peer.waiting = false;
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = undefined;
    if (!peer.active) {
      const waiters = peer.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
    return items;
  }

  pendingItems(peerId) {
    return [...(this.peers.get(peerId)?.pending || [])];
  }

  waitForIdle(peerId) {
    const peer = this.#peer(peerId);
    if (!peer.active && !peer.pending.length && !peer.timer) return Promise.resolve();
    return new Promise((resolve) => peer.idleWaiters.push(resolve));
  }

  async waitForAllIdle() {
    await Promise.all([...this.peers.keys()].map((peerId) => this.waitForIdle(peerId)));
  }

  close() {
    if (this.closed) return 0;
    this.closed = true;
    this.waitingPeers.length = 0;
    let cleared = 0;
    for (const peerId of this.peers.keys()) cleared += this.clear(peerId);
    return cleared;
  }
}
