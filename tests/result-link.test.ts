import { expect, test } from 'bun:test';
import { parseResultLink } from '../apps/web/src/result-link';
import { Id } from '../apps/web/src/types';

test('result links require one valid conversation and at most one valid message', () => {
  const conversation = Id.parse(crypto.randomUUID()), message = Id.parse(crypto.randomUUID());
  expect(parseResultLink(new URL(`https://fixture.test/?conversation=${conversation}&message=${message}`)))
    .toEqual({ kind: 'result', conversation, message });
  expect(parseResultLink(new URL(`https://fixture.test/?conversation=${conversation}`)))
    .toEqual({ kind: 'result', conversation });
  for (const query of [`message=${message}`, `conversation=${conversation}&conversation=${message}`, `conversation=${conversation}&message=${message}&message=${message}`, `conversation=external`, `conversation=${conversation}&message=invalid`]) {
    expect(parseResultLink(new URL(`https://fixture.test/?${query}`))).toEqual({ kind: 'invalid' });
  }
  expect(parseResultLink(new URL('https://fixture.test/?showcase=1'))).toEqual({ kind: 'none' });
});
