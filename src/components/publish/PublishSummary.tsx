"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PLATFORM_RULES } from "@/server/services/media/rules-engine";

interface Job {
  assetId: string;
  socialAccountId: string;
  action: string;
  resizeOption: string | null;
  fileName?: string;
  accountName?: string;
}

interface PublishSummaryProps {
  jobs: Job[];
}

export function PublishSummary({ jobs }: PublishSummaryProps) {
  if (jobs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        Select actions and accounts to see publish summary
      </p>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Publish Summary: {jobs.length} job{jobs.length !== 1 ? "s" : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {jobs.map((job, i) => {
          const rule = PLATFORM_RULES[job.action];
          return (
            <div
              key={i}
              className="flex items-center justify-between text-xs p-2 bg-muted rounded"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{job.fileName || "File"}</span>
                <span className="text-muted-foreground">→</span>
                <span>@{job.accountName || "account"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">
                  {rule?.label || job.action}
                </Badge>
                {job.resizeOption && job.resizeOption !== "keep_original" && (
                  <Badge variant="outline" className="text-[10px]">
                    {job.resizeOption.replace("_", " ")}
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
