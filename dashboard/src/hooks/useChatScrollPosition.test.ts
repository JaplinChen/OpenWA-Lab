import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bottomVisibleMessageId } from './useChatScrollPosition.ts';

// Build a fake scroll box whose rows are laid out 100px tall starting at offsetTop 0.
function box(scrollTop: number, clientHeight: number, ids: string[]) {
  const nodes = ids.map((id, i) => ({
    offsetTop: i * 100,
    getAttribute: (n: string) => (n === 'data-wa-message-id' ? id : null),
  }));
  return { scrollTop, clientHeight, querySelectorAll: () => nodes };
}

test('no rows: returns null', () => {
  assert.equal(bottomVisibleMessageId(box(0, 500, [])), null);
});

test('scrolled to bottom: newest message is the anchor', () => {
  // 5 rows (0..400), viewport 500 tall scrolled to 0 sees all → last one is newest seen.
  assert.equal(bottomVisibleMessageId(box(0, 500, ['a', 'b', 'c', 'd', 'e'])), 'e');
});

test('scrolled up: anchor is the bottom-most row still within the viewport', () => {
  // viewportBottom = scrollTop(0) + clientHeight(250) = 250 → rows at 0,100,200 are visible; 300+ not.
  assert.equal(bottomVisibleMessageId(box(0, 250, ['a', 'b', 'c', 'd', 'e'])), 'c');
});

test('scrolled partway down: anchor tracks the new bottom of the viewport', () => {
  // viewportBottom = 150 + 250 = 400 → rows with offsetTop <= 400 are a..e(400) → e.
  assert.equal(bottomVisibleMessageId(box(150, 250, ['a', 'b', 'c', 'd', 'e'])), 'e');
});
