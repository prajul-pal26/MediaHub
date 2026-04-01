"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc/client";
import {
  Loader2, ChevronLeft, ChevronRight, Shield, Clock,
} from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  "brand.create": "bg-green-100 text-green-800",
  "brand.delete": "bg-red-100 text-red-800",
  "user.invite": "bg-blue-100 text-blue-800",
  "user.remove": "bg-red-100 text-red-800",
  "user.role_change": "bg-yellow-100 text-yellow-800",
  "publish.schedule": "bg-purple-100 text-purple-800",
  "publish.now": "bg-purple-100 text-purple-800",
};

export function AuditLog() {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [resourceFilter, setResourceFilter] = useState<string>("all");

  const { data, isLoading } = trpc.users.getAuditLog.useQuery({
    page,
    limit: 30,
    action: actionFilter !== "all" ? actionFilter : undefined,
    resourceType: resourceFilter !== "all" ? resourceFilter : undefined,
  });

  const logs = data?.logs || [];
  const totalPages = data?.totalPages || 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Audit Log
          </h2>
          <p className="text-sm text-muted-foreground">
            Track all actions across your organization
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={actionFilter} onValueChange={(v) => { if (v) { setActionFilter(v); setPage(1); } }}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue placeholder="All Actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="brand.create">Brand Created</SelectItem>
              <SelectItem value="brand.delete">Brand Deleted</SelectItem>
              <SelectItem value="user.invite">User Invited</SelectItem>
              <SelectItem value="user.remove">User Removed</SelectItem>
              <SelectItem value="user.role_change">Role Changed</SelectItem>
              <SelectItem value="publish.schedule">Post Scheduled</SelectItem>
              <SelectItem value="publish.now">Post Published</SelectItem>
            </SelectContent>
          </Select>
          <Select value={resourceFilter} onValueChange={(v) => { if (v) { setResourceFilter(v); setPage(1); } }}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="All Resources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Resources</SelectItem>
              <SelectItem value="brand">Brand</SelectItem>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="post">Post</SelectItem>
              <SelectItem value="media">Media</SelectItem>
              <SelectItem value="social_account">Social Account</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Shield className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No audit logs</p>
              <p className="text-sm">Actions will appear here as your team uses the platform</p>
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log: any) => {
                const user = log.users;
                return (
                  <div key={log.id} className="flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/30 transition-colors">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                      <span className="text-xs font-medium">
                        {user?.name?.[0]?.toUpperCase() || "?"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium">{user?.name || "System"}</span>
                        {user?.role && (
                          <Badge variant="outline" className="text-[10px] px-1.5">{user.role}</Badge>
                        )}
                        <Badge className={`text-[10px] px-1.5 ${ACTION_COLORS[log.action] || "bg-gray-100 text-gray-800"}`}>
                          {log.action}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{log.resource_type}</span>
                        {log.resource_id && (
                          <span className="font-mono text-[10px]">{log.resource_id.slice(0, 8)}...</span>
                        )}
                        {log.source && (
                          <Badge variant="secondary" className="text-[10px] px-1">{log.source}</Badge>
                        )}
                      </div>
                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <p className="text-[11px] text-muted-foreground mt-1 font-mono bg-muted/50 px-2 py-1 rounded">
                          {JSON.stringify(log.metadata).slice(0, 120)}
                          {JSON.stringify(log.metadata).length > 120 ? "..." : ""}
                        </p>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
                      <Clock className="h-3 w-3" />
                      {new Date(log.created_at).toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({data?.total || 0} total)
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
