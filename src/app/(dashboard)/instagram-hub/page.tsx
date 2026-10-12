import { Suspense } from "react";
import { InstagramHub } from "@/components/instagram/InstagramHub";
import { Loader2 } from "lucide-react";

export default function InstagramHubPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-96 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <InstagramHub />
    </Suspense>
  );
}
