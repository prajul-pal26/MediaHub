"use client";

import { useUser } from "@/lib/hooks/use-user";
import { BrandList } from "@/components/brands/BrandList";
import { trpc } from "@/lib/trpc/client";

export default function BrandsPage() {
  const { profile, loading: profileLoading } = useUser();
  const { data: brands, isLoading: brandsLoading } = trpc.brands.list.useQuery(undefined, {
    enabled: !!profile,
  });

  if (profileLoading || brandsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!profile) return null;

  return <BrandList brands={brands || []} profile={profile} />;
}
