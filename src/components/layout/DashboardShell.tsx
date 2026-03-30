"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useUser } from "@/lib/hooks/use-user";
import { BrandProvider, useBrand } from "@/lib/hooks/use-brand";
import type { Brand } from "@/lib/types";

function DashboardContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { profile, loading } = useUser();
  const { brands, activeBrandId, setActiveBrandId } = useBrand();

  const isChatPage = pathname.startsWith("/chat");

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden">
      {!isChatPage && <Sidebar profile={profile} />}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header
          profile={profile}
          brands={brands as Brand[]}
          selectedBrandId={activeBrandId}
          onBrandChange={setActiveBrandId}
        />
        <main className={`flex-1 overflow-auto ${isChatPage ? "p-0" : "p-6"} bg-zinc-100`}>{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <BrandProvider>
      <DashboardContent>{children}</DashboardContent>
    </BrandProvider>
  );
}
