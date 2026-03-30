"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRouter } from "next/navigation";
import type { Brand, UserProfile } from "@/lib/types";
import { isBrandRole } from "@/lib/types";

interface BrandSwitcherProps {
  brands: Brand[];
  selectedBrandId: string | null;
  onBrandChange: (brandId: string) => void;
  profile: UserProfile;
}

export function BrandSwitcher({
  brands,
  selectedBrandId,
  onBrandChange,
  profile,
}: BrandSwitcherProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Brand-level users don't see the switcher
  if (isBrandRole(profile.role)) {
    const brand = brands.find((b) => b.id === profile.brand_id);
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium">
        <div className="h-6 w-6 rounded bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
          {brand?.name?.[0] || "?"}
        </div>
        {brand?.name || "My Brand"}
      </div>
    );
  }

  const selectedBrand = brands.find((b) => b.id === selectedBrandId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex items-center justify-between w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        <div className="flex items-center gap-2 truncate">
          <div className="h-5 w-5 rounded bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
            {selectedBrand?.name?.[0] || "A"}
          </div>
          <span className="truncate">
            {selectedBrand?.name || "All Brands"}
          </span>
        </div>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0">
        <Command>
          <CommandInput placeholder="Search brands..." />
          <CommandList>
            <CommandEmpty>No brands found.</CommandEmpty>
            <CommandGroup>
              {brands.map((brand) => (
                <CommandItem
                  key={brand.id}
                  value={brand.name}
                  onSelect={() => {
                    onBrandChange(brand.id);
                    setOpen(false);
                  }}
                >
                  <div className="h-5 w-5 rounded bg-primary/10 flex items-center justify-center text-xs font-bold text-primary mr-2">
                    {brand.name[0]}
                  </div>
                  {brand.name}
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      selectedBrandId === brand.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
            {(profile.role === "super_admin" || profile.role === "agency_admin") && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      setOpen(false);
                      router.push("/brands/new");
                    }}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add Brand
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
