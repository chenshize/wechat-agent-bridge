import assert from "node:assert/strict";
import test from "node:test";

import { MessageDeduper, PollBackoff, delay, messageIdentity } from "../src/poll-runtime.js";

test("uses stable content hashing when WeChat omits a message id", () => {
  const first = { from_user_id: "a", item_list: [{ text_item: { text: "hi" }, type: 1 }] };
  const same = { item_list: [{ type: 1, text_item: { text: "hi" } }], from_user_id: "a" };
  assert.equal(messageIdentity(first), messageIdentity(same));
});

test("fallback message ids distinguish delivery contexts", () => {
  const first = { from_user_id: "a", context_token: "one", item_list: [{ type: 1, text_item: { text: "hi" } }] };
  const second = { from_user_id: "a", context_token: "two", item_list: [{ type: 1, text_item: { text: "hi" } }] };
  assert.notEqual(messageIdentity(first), messageIdentity(second));
});

test("deduplicates and restores remembered ids", () => {
  let now = 100_000;
  const deduper = new MessageDeduper({ now: () => now });
  assert.equal(deduper.checkAndRemember("m1"), false);
  assert.equal(deduper.checkAndRemember("m1"), true);
  const restored = new MessageDeduper({ entries: deduper.snapshot(), now: () => now });
  assert.equal(restored.checkAndRemember("m1"), true);
  now += 25 * 60 * 60 * 1000;
  assert.equal(restored.checkAndRemember("m1"), false);
});

test("poll backoff grows exponentially and resets", () => {
  const backoff = new PollBackoff({ baseMs: 100, maxMs: 500, jitter: 0, random: () => 0.5 });
  assert.deepEqual([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()], [100, 200, 400, 500]);
  backoff.reset();
  assert.equal(backoff.nextDelay(), 100);
});

test("abort cancels a backoff without leaving the delay pending", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = delay(30_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - startedAt < 500);
});
