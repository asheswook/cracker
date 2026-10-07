import { expect, test } from 'bun:test';
import { createErrorToasts } from '../apps/web/src/error-toasts';

test('repeated publication and simultaneous duplicate text show a single error', () => {
  const toasts = createErrorToasts();
  toasts.show('Upload failed', 'upload-1'); toasts.show('Upload failed', 'upload-1'); toasts.show('Upload failed', 'upload-2');
  expect(toasts.snapshot()).toHaveLength(1);
  toasts.dismiss('upload-1'); toasts.show('Upload failed', 'upload-1');
  expect(toasts.snapshot()).toHaveLength(0);
  toasts.show('Upload failed', 'upload-retried');
  expect(toasts.snapshot()).toEqual([{ id: 'upload-retried', message: 'Upload failed' }]);
});
test('a burst is bounded without mutating earlier snapshots, and logout clears pending errors', () => {
  const toasts = createErrorToasts(); toasts.show('first', '1'); const earlier = toasts.snapshot();
  for (let i = 2; i <= 5; i++) toasts.show(`error ${i}`, `${i}`);
  expect(toasts.snapshot().map(toast => toast.id)).toEqual(['3', '4', '5']);
  expect(earlier).toEqual([{ id: '1', message: 'first' }]);
  toasts.clear(); expect(toasts.snapshot()).toHaveLength(0);
});
