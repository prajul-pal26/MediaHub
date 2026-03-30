"use client";

import { Suspense } from "react";
import { useUser } from "@/lib/hooks/use-user";
import { BrandSetupWizard } from "@/components/brands/BrandSetupWizard";
import { canManageBrands } from "@/lib/types";

function NewBrandContent() {
  const { profile, loading } = useUser();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!profile || !canManageBrands(profile.role)) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">You don&apos;t have permission to create brands.</p>
      </div>
    );
  }

  return <BrandSetupWizard />;
}

export default function NewBrandPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <NewBrandContent />
    </Suspense>
  );
}
