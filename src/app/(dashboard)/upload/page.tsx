"use client";

import { Upload, HardDrive, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { useRouter } from "next/navigation";
import { UploadForm } from "@/components/media/UploadForm";

export default function UploadPage() {
  const { activeBrandId, loading } = useBrand();
  const router = useRouter();

  const { data: driveStatus, isLoading: driveLoading } = trpc.drive.status.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const driveReady = driveStatus?.connected && driveStatus?.isActive;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Upload Media</h1>
        <p className="text-muted-foreground">Upload files to your brand&apos;s Google Drive</p>
      </div>

      {!driveLoading && !driveReady && activeBrandId && (
        <div className="flex items-center gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Google Drive not connected</p>
            <p className="text-sm text-yellow-700">Connect Google Drive before uploading media.</p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 border-yellow-300 text-yellow-800 hover:bg-yellow-100" onClick={() => router.push("/accounts")}>
            <HardDrive className="h-4 w-4 mr-1" />
            Connect Drive
          </Button>
        </div>
      )}

      {!activeBrandId ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Upload className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Create a brand first to start uploading</p>
          </div>
        </div>
      ) : driveReady ? (
        <UploadForm brandId={activeBrandId} />
      ) : (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Upload className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">Upload disabled</p>
            <p className="text-sm">Connect Google Drive to enable uploads</p>
          </div>
        </div>
      )}
    </div>
  );
}
