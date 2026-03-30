/**
 * Typed wrapper for service role Supabase client.
 * Since we don't use supabase gen types, we cast queries to `any`
 * to avoid `never` type issues with the untyped client.
 */
import { createServiceRoleClient } from "./server";

export function getDb() {
  const client = createServiceRoleClient();

  return {
    from(table: string) {
      return client.from(table) as any;
    },
    rpc(fn: string, params?: Record<string, unknown>) {
      return (client.rpc as any)(fn, params);
    },
  };
}
