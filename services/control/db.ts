import postgres from "postgres";
export function createDatabase(url: string) {
  return postgres(url, {
    max: 5,
    prepare: false,
    connection: { search_path: "assistant,public" },
    transform: {
      value: {
        from: (value, column) =>
          column.type === 1184 && value instanceof Date ? value.toISOString() : value,
      },
    },
  });
}
export type Database = ReturnType<typeof createDatabase>;
export type Transaction = postgres.TransactionSql;
export type Query = Database | Transaction;
