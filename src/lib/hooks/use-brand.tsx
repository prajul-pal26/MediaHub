"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { trpc } from "@/lib/trpc/client";
import { useUser } from "./use-user";

interface BrandContextType {
  brands: any[];
  activeBrandId: string | null;
  setActiveBrandId: (id: string) => void;
  loading: boolean;
}

const BrandContext = createContext<BrandContextType>({
  brands: [],
  activeBrandId: null,
  setActiveBrandId: () => {},
  loading: true,
});

export function BrandProvider({ children }: { children: ReactNode }) {
  const { profile } = useUser();
  const [activeBrandId, setActiveBrandIdRaw] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data: brands = [], isLoading } = trpc.brands.list.useQuery(undefined, {
    enabled: !!profile,
  });

  // When brand changes, invalidate all brand-dependent queries
  const setActiveBrandId = useCallback((id: string) => {
    setActiveBrandIdRaw((prev) => {
      if (prev !== id) {
        // Invalidate all brand-dependent queries so they refetch with the new brandId
        utils.invalidate();
      }
      return id;
    });
  }, [utils]);

  useEffect(() => {
    if (!profile || brands.length === 0) return;

    if (profile.brand_id) {
      setActiveBrandIdRaw(profile.brand_id);
    } else if (brands.length > 0) {
      setActiveBrandIdRaw((prev) => prev ?? brands[0].id);
    }
  }, [profile, brands]);

  return (
    <BrandContext.Provider value={{ brands, activeBrandId, setActiveBrandId, loading: isLoading }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand() {
  return useContext(BrandContext);
}
