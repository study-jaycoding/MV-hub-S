// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommentPanel } from '../src/components/common/CommentPanel';
import { requestCommentHighlight, takeCommentHighlight } from '../src/lib/commentHighlight';

let host: HTMLDivElement;
let root: Root;
const scroll = vi.fn();
const layout = vi.fn(() => 100);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { escape: (text: string) => text.replace(/:/g, '\\:') });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(layout);
  scroll.mockClear(); layout.mockClear();
  takeCommentHighlight(['c']);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('restarts the same comment, keeps its input, and clears two seconds after the latest request', () => {
  act(() => root.render(<CommentPanel comments={[{
    id: 'c', author: 'me', author_name: 'Me', text: 'Comment', created_at: '2026-11-05', parent_id: null,
  }]} label="Generation" myId="me" panelRef={() => {}} pos={null} onHeadMouseDown={() => {}}
    onClose={() => {}} onSend={async () => true} onEdit={async () => true} onDelete={() => {}} />));
  const row = host.querySelector<HTMLElement>('[data-comment-id="c"]')!;
  const edit = [...row.querySelectorAll('button')].find(b => b.textContent === '수정')!;
  act(() => edit.click());
  const input = row.querySelector<HTMLInputElement>('input[name="e"]')!;
  input.value = 'Unsaved edit';
  act(() => requestCommentHighlight('c'));
  expect(row.classList.contains('is-target')).toBe(true);
  expect(layout).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1500));
  act(() => requestCommentHighlight('c'));
  expect(layout).toHaveBeenCalledTimes(2);
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-comment-id="c"]')).toBe(row);
  expect(input.value).toBe('Unsaved edit');
  act(() => vi.advanceTimersByTime(501));
  expect(row.classList.contains('is-target')).toBe(true);
  act(() => vi.advanceTimersByTime(1499));
  expect(row.classList.contains('is-target')).toBe(false);
  expect(row.style.animation).toBe('');
});
