import { Suspense } from "react";
import { FacebookHub } from "@/components/facebook/FacebookHub";
import { Loader2 } from "lucide-react";

export default function FacebookHubPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <FacebookHub />
    </Suspense>
  );
}
