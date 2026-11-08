import postgres from "postgres";

export type Db = postgres.Sql;
/** A connection or a transaction: anything that runs queries. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export interface DbOptions {
  /**
   * Through Supabase's transaction pooler (Vercel): no prepared statements, one connection per
   * function instance. Direct or session connections (migrations, the B1b gateway's LISTEN) leave
   * this off.
   */
  pooled?: boolean;
  max?: number;
}

export function createDb(url: string, { pooled = false, max }: DbOptions = {}): Db {
  return postgres(url, {
    prepare: !pooled,
    max: max ?? (pooled ? 1 : 5),
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: "nexus-bot" },
    onnotice: () => {},
  });
}
