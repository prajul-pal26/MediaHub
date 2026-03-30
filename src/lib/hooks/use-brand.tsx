"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
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
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);

  const { data: brands = [], isLoading } = trpc.brands.list.useQuery(undefined, {
    enabled: !!profile,
  });

  useEffect(() => {
    if (!profile || brands.length === 0) return;

    if (profile.brand_id) {
      setActiveBrandId(profile.brand_id);
    } else if (brands.length > 0) {
      setActiveBrandId((prev) => prev ?? brands[0].id);
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
