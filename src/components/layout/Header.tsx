"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ModeSwitcher } from "@/components/common/ModeSwitcher";
import { BrandSwitcher } from "@/components/common/BrandSwitcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, Settings } from "lucide-react";
import type { UserProfile, Brand } from "@/lib/types";

interface HeaderProps {
  profile: UserProfile | null;
  brands: Brand[];
  selectedBrandId: string | null;
  onBrandChange: (brandId: string) => void;
}

export function Header({ profile, brands, selectedBrandId, onBrandChange }: HeaderProps) {
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="h-14 border-b bg-card flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        {profile && (
          <BrandSwitcher
            brands={brands}
            selectedBrandId={selectedBrandId}
            onBrandChange={onBrandChange}
            profile={profile}
          />
        )}
      </div>

      <ModeSwitcher />

      <div className="flex items-center gap-2">
        {profile && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                {profile.name?.[0]?.toUpperCase() || "?"}
              </div>
              <span className="hidden sm:inline">{profile.name}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5 text-sm">
                <p className="font-medium">{profile.name}</p>
                <p className="text-muted-foreground text-xs">{profile.email}</p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/settings")}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleLogout()}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}
