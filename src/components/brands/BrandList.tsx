"use client";

import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Building2, Plus, Link2, HardDrive, Trash2, CheckCircle2 } from "lucide-react";
import type { Brand, UserProfile } from "@/lib/types";
import { canManageBrands } from "@/lib/types";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";

function BrandStats({ brandId }: { brandId: string }) {
  const { data: accounts = [] } = trpc.socialAccounts.list.useQuery({ brandId });
  const { data: driveStatus } = trpc.drive.status.useQuery({ brandId });

  return (
    <div className="flex items-center gap-4 text-sm text-muted-foreground">
      <div className="flex items-center gap-1">
        <Link2 className="h-3.5 w-3.5" />
        <span>{accounts.length} account{accounts.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="flex items-center gap-1">
        {driveStatus?.connected && driveStatus?.isActive ? (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            <span className="text-green-600">Drive connected</span>
          </>
        ) : (
          <>
            <HardDrive className="h-3.5 w-3.5" />
            <span>Drive not connected</span>
          </>
        )}
      </div>
    </div>
  );
}

interface BrandListProps {
  brands: Brand[];
  profile: UserProfile;
}

export function BrandList({ brands, profile }: BrandListProps) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.brands.delete.useMutation({
    onSuccess: () => {
      toast.success("Brand deleted");
      utils.brands.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  function handleDelete(e: React.MouseEvent, brandId: string, brandName: string) {
    e.stopPropagation();
    const typed = prompt(
      `This will permanently delete "${brandName}" and all its media, accounts, posts, and analytics.\n\nType the brand name to confirm:`
    );
    if (typed === brandName) {
      deleteMutation.mutate({ id: brandId });
    } else if (typed !== null) {
      toast.error("Brand name didn't match. Deletion cancelled.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brands</h1>
          <p className="text-muted-foreground">
            {brands.length} brand{brands.length !== 1 ? "s" : ""} in your organization
          </p>
        </div>
        {canManageBrands(profile.role) && (
          <Button onClick={() => router.push("/brands/new")}>
            <Plus className="h-4 w-4 mr-2" />
            Add Brand
          </Button>
        )}
      </div>

      {brands.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Building2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brands yet</p>
            <p className="text-sm mb-4">Create your first brand to get started</p>
            {canManageBrands(profile.role) && (
              <Button onClick={() => router.push("/brands/new")}>
                <Plus className="h-4 w-4 mr-2" />
                Add Brand
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {brands.map((brand) => (
            <Card
              key={brand.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => router.push(`/brands?selected=${brand.id}`)}
            >
              <CardContent className="pt-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {brand.logo_url ? (
                      <img
                        src={brand.logo_url}
                        alt={brand.name}
                        className="h-10 w-10 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <span className="text-primary font-bold">
                          {brand.name[0]?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div>
                      <h3 className="font-semibold">{brand.name}</h3>
                      <StatusBadge status={brand.setup_status} />
                    </div>
                  </div>
                  {profile.role === "super_admin" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-red-600"
                      onClick={(e) => handleDelete(e, brand.id, brand.name)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <BrandStats brandId={brand.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
