import type { z } from 'zod';
import type { PriorSourcePage, WorkSearchPage } from '../../../packages/protocol/work-search';

export type SearchPage = z.infer<typeof WorkSearchPage>;
export type SearchSource = z.infer<typeof PriorSourcePage>;
export type WorkFilter = 'all' | 'active' | 'finished';
// Owned by the ready workspace, never persisted. Mutation avoids rerendering App while typing.
export type WorkSession = {
  query: string;
  filter: WorkFilter;
  page: SearchPage | null;
  searchKey: string;
  scrollTop: number;
  disclosures: Set<string>;
  sources: Map<string, SearchSource>;
};
export function createWorkSession(): WorkSession {
  return { query: '', filter: 'all', page: null, searchKey: '', scrollTop: 0, disclosures: new Set(), sources: new Map() };
}
