import ky, { HTTPError } from 'ky';
import type { z } from 'zod';
export const http = ky.create({
  credentials: 'include',
  timeout: 15000,
  retry: { limit: 1, methods: ['get'] },
  redirect: 'error',
});
export async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await http.get(path).json<unknown>());
}
export function errorMessage(error: unknown): string {
  if (error instanceof HTTPError) {
    if (error.response.status === 400) return '입력한 내용을 확인해 주세요.';
    if (error.response.status === 401) return '연결이 만료됐어요. 다시 연결해 주세요.';
    if (error.response.status === 403) return '이 작업에 대한 권한이 없어요.';
    if (error.response.status === 409) return '상태가 변경됐어요. 새로고침한 뒤 다시 시도해 주세요.';
    return `요청을 완료하지 못했어요. (${error.response.status})`;
  }
  if (error instanceof Error) return '서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';
  return '예상하지 못한 오류가 발생했어요.';
}
