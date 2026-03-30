"use client";

import { trpc } from "@/lib/trpc/client";
import type { UserProfile } from "@/lib/types";

export function useUser() {
  const { data, isLoading } = trpc.users.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    profile: (data as UserProfile | null) ?? null,
    loading: isLoading,
  };
}
