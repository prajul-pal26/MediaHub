"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Users, Plus, Trash2, Loader2 } from "lucide-react";

export default function CompetitorsPage() {
  const { activeBrandId, loading } = useBrand();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [platform, setPlatform] = useState<string>("instagram");

  const utils = trpc.useUtils();

  const { data: competitors, isLoading } =
    trpc.analytics.getCompetitors.useQuery(
      { brandId: activeBrandId! },
      { enabled: !!activeBrandId }
    );

  const addMutation = trpc.analytics.addCompetitor.useMutation({
    onSuccess: () => {
      toast.success("Competitor added");
      setDialogOpen(false);
      setHandle("");
      setPlatform("instagram");
      utils.analytics.getCompetitors.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const removeMutation = trpc.analytics.removeCompetitor.useMutation({
    onSuccess: () => {
      toast.success("Competitor removed");
      utils.analytics.getCompetitors.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  function handleAdd() {
    if (!activeBrandId || !handle.trim()) return;
    addMutation.mutate({
      brandId: activeBrandId,
      handle: handle.trim(),
      platform: platform as "instagram" | "youtube" | "linkedin",
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!activeBrandId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Competitor Benchmarking</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Create a brand to track competitors</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Competitor Benchmarking</h1>
          <p className="text-muted-foreground">
            Track and compare competitor performance
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Competitor
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Tracked Competitors</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !competitors || competitors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-10 w-10 mx-auto mb-3 opacity-50" />
              <p className="font-medium">No competitors tracked</p>
              <p className="text-sm">
                Add competitor handles to track their performance
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Handle</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead className="text-right">Followers</TableHead>
                  <TableHead className="text-right">Posts</TableHead>
                  <TableHead className="text-right">Avg Engagement</TableHead>
                  <TableHead className="text-right">Last Updated</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(competitors || []).map((comp: any) => (
                  <TableRow key={comp.id}>
                    <TableCell className="font-medium">@{comp.handle}</TableCell>
                    <TableCell className="capitalize">{comp.platform}</TableCell>
                    <TableCell className="text-right">
                      {comp.followers?.toLocaleString() ?? "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {comp.post_count ?? "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {comp.avg_engagement != null
                        ? `${comp.avg_engagement}%`
                        : "-"}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {comp.last_updated
                        ? new Date(comp.last_updated).toLocaleDateString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                        onClick={() => removeMutation.mutate({ brandId: activeBrandId!, handle: comp.competitor_handle, platform: comp.platform })}
                        disabled={removeMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Competitor Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Competitor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Handle</Label>
              <Input
                placeholder="e.g. competitor_brand"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v ?? "instagram")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="youtube">YouTube</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!handle.trim() || addMutation.isPending}
            >
              {addMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
