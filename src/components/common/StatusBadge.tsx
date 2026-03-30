import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusColors: Record<string, string> = {
  // Post statuses
  draft: "bg-gray-100 text-gray-700",
  pending_approval: "bg-yellow-100 text-yellow-700",
  scheduled: "bg-blue-100 text-blue-700",
  publishing: "bg-purple-100 text-purple-700",
  published: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  // Job statuses
  queued: "bg-gray-100 text-gray-700",
  processing: "bg-purple-100 text-purple-700",
  completed: "bg-green-100 text-green-700",
  dead: "bg-red-100 text-red-700",
  // Brand setup
  incomplete: "bg-yellow-100 text-yellow-700",
  active: "bg-green-100 text-green-700",
  // Credential status
  development: "bg-gray-100 text-gray-700",
  in_review: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        statusColors[status] || "bg-gray-100 text-gray-700",
        className
      )}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
