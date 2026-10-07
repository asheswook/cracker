import { createContext } from 'react';
export type HeaderTimeBinding = Readonly<{ available: boolean; pinned: boolean; toggle: () => void }>;
export const HeaderTimeContext = createContext<((binding: HeaderTimeBinding | null) => void) | null>(null);
