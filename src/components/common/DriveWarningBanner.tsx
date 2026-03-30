"use client";

import { AlertCircle, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface DriveWarningBannerProps {
  brandId: string;
  brandName?: string;
}

export function DriveWarningBanner({ brandId, brandName }: DriveWarningBannerProps) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800">
      <AlertCircle className="h-5 w-5 shrink-0" />
      <div className="flex-1 text-sm">
        <p className="font-medium">Google Drive disconnected{brandName ? ` for ${brandName}` : ""}</p>
        <p className="text-yellow-700">Uploads and publishing are blocked until Drive is reconnected.</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-yellow-300 text-yellow-800 hover:bg-yellow-100"
        onClick={() => router.push(`/accounts?reconnect=${brandId}`)}
      >
        <HardDrive className="h-4 w-4 mr-1" />
        Reconnect
      </Button>
    </div>
  );
}
