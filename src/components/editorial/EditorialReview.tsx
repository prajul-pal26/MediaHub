"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc/client";
import {
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSearch,
  MapPin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Newspaper,
} from "lucide-react";
import { toast } from "sonner";

const statuses = ["needs_review", "supported", "needs_context", "rejected"] as const;
const label: Record<string, string> = {
  needs_review: "Needs review",
  supported: "Source supported",
  needs_context: "Needs context",
  rejected: "Rejected",
};
const color: Record<string, string> = {
  needs_review: "bg-amber-100 text-amber-900 border-amber-200",
  supported: "bg-emerald-100 text-emerald-900 border-emerald-200",
  needs_context: "bg-sky-100 text-sky-900 border-sky-200",
  rejected: "bg-rose-100 text-rose-900 border-rose-200",
};

export function EditorialReview() {
  const utils = trpc.useUtils();
  const [district, setDistrict] = useState("all");
  const [status, setStatus] = useState("all");
  const [publishedFrom, setPublishedFrom] = useState("");
  const [publishedTo, setPublishedTo] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    sourceName: "",
    sourceUrl: "",
    headline: "",
    district: "",
    topic: "",
    publishedDate: "",
    summary: "",
  });

  const { data: summary } = trpc.editorialResearch.summary.useQuery();
  const { data: connection } = trpc.editorialResearch.connectionStatus.useQuery();
  const { data: items = [], isLoading } = trpc.editorialResearch.list.useQuery({
    district: district === "all" ? undefined : district,
    status: status === "all" ? undefined : (status as typeof statuses[number]),
    publishedFrom: publishedFrom || undefined,
    publishedTo: publishedTo || undefined,
  });

  const add = trpc.editorialResearch.add.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.editorialResearch.list.invalidate(),
        utils.editorialResearch.summary.invalidate(),
      ]);
      setShowAdd(false);
      setForm({
        sourceName: "",
        sourceUrl: "",
        headline: "",
        district: "",
        topic: "",
        publishedDate: "",
        summary: "",
      });
      toast.success("Source added for review");
    },
    onError: (e) => toast.error(e.message),
  });

  const review = trpc.editorialResearch.review.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.editorialResearch.list.invalidate(),
        utils.editorialResearch.summary.invalidate(),
      ]);
      toast.success("Review saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const syncExternal = trpc.editorialResearch.syncExternal.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.editorialResearch.list.invalidate(),
        utils.editorialResearch.summary.invalidate(),
        utils.editorialResearch.connectionStatus.invalidate(),
      ]);
      toast.success(`${result.added} new sources added from ${result.sourceName}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const districts = useMemo<string[]>(
    () =>
      Array.from(
        new Set<string>(
          items
            .map((item: any) => item.district)
            .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
        )
      ).sort(),
    [items]
  );

  const toggleSelected = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i: any) => i.id)));
    }
  };

  return (
    <div className="w-full space-y-5">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            News Review & Evidence Queue
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Evidence-first source research. Every item needs human verification before editorial distribution across district profiles.
          </p>
          {connection?.active && (
            <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              ● {connection.source_name} connected
              {connection.last_synced_at ? " · previously synced" : " · ready to sync"}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!connection?.active || syncExternal.isPending}
            onClick={() => syncExternal.mutate()}
            className="cursor-pointer"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${syncExternal.isPending ? "animate-spin" : ""}`} />
            Sync source pool
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAdd((open) => !open)}
            className="cursor-pointer"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add source
          </Button>
        </div>
      </div>

      {/* Stats Summary Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Sources", summary?.total ?? 0, FileSearch],
          ["Awaiting review", summary?.awaitingReview ?? 0, ClipboardCheck],
          ["Source supported", summary?.supported ?? 0, ShieldCheck],
          ["Districts represented", summary?.districts ?? 0, MapPin],
        ].map(([title, value, Icon]: any) => (
          <Card key={title} className="p-4 bg-sidebar/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{title}</p>
                <p className="mt-1 text-xl font-bold text-foreground">{value}</p>
              </div>
              <div className="p-2.5 rounded-lg bg-primary/10 text-primary">
                <Icon className="h-5 w-5" />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Optional Add Source Panel */}
      {showAdd && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a source for evidence review</CardTitle>
            <CardDescription>
              Submit verified facts or articles to the queue for district review.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Input
              placeholder="Source / publisher"
              value={form.sourceName}
              onChange={(e) => setForm({ ...form, sourceName: e.target.value })}
            />
            <Input
              placeholder="Proof link (https://...)"
              value={form.sourceUrl}
              onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
            />
            <Input
              className="md:col-span-2"
              placeholder="Factual headline"
              value={form.headline}
              onChange={(e) => setForm({ ...form, headline: e.target.value })}
            />
            <Input
              placeholder="District (optional)"
              value={form.district}
              onChange={(e) => setForm({ ...form, district: e.target.value })}
            />
            <Input
              placeholder="Topic (optional)"
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
            />
            <label className="grid gap-1 text-xs text-muted-foreground">
              Published date (optional)
              <Input
                type="date"
                value={form.publishedDate}
                onChange={(e) => setForm({ ...form, publishedDate: e.target.value })}
              />
            </label>
            <Textarea
              className="md:col-span-2"
              placeholder="Context for the reviewer (optional)"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
            <div className="flex justify-end gap-2 md:col-span-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!form.sourceName || !form.sourceUrl || !form.headline || add.isPending}
                onClick={() =>
                  add.mutate({
                    sourceType: "manual",
                    sourceName: form.sourceName,
                    sourceUrl: form.sourceUrl,
                    headline: form.headline,
                    summary: form.summary || undefined,
                    district: form.district || undefined,
                    topic: form.topic || undefined,
                    publishedAt: form.publishedDate
                      ? `${form.publishedDate}T12:00:00.000Z`
                      : undefined,
                  })
                }
              >
                Save for review
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Review Queue Card with Fixed Table */}
      <Card>
        <CardHeader className="gap-4 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-semibold">Review Queue</CardTitle>
            <CardDescription>
              {selectedIds.size} of {items.length} sources selected from this pool.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={district} onValueChange={(value) => setDistrict(value ?? "all")}>
              <SelectTrigger className="w-36 h-9 text-xs">
                <SelectValue placeholder="All districts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All districts</SelectItem>
                {districts.map((name) => (
                  <SelectItem value={name} key={name} className="text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={status} onValueChange={(value) => setStatus(value ?? "all")}>
              <SelectTrigger className="w-36 h-9 text-xs">
                <SelectValue placeholder="All states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All review states</SelectItem>
                {statuses.map((value) => (
                  <SelectItem key={value} value={value} className="text-xs">
                    {label[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-muted-foreground whitespace-nowrap">From</label>
              <Input
                type="date"
                aria-label="Published from"
                className="w-32 h-9 text-xs"
                value={publishedFrom}
                onChange={(event) => setPublishedFrom(event.target.value)}
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-muted-foreground whitespace-nowrap">To</label>
              <Input
                type="date"
                aria-label="Published to"
                className="w-32 h-9 text-xs"
                value={publishedTo}
                onChange={(event) => setPublishedTo(event.target.value)}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="h-8 w-8 animate-spin mb-3 text-primary" />
              <p className="text-sm font-medium">Loading review queue…</p>
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <FileSearch className="mx-auto mb-3 h-9 w-9 opacity-50" />
              <p className="font-medium text-sm">No sources yet</p>
              <p className="mt-1 text-xs">Add a verified source link or sync pool to begin human review.</p>
            </div>
          ) : (
            <div className="max-h-[580px] overflow-auto rounded-md border border-border shadow-2xs">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur shadow-xs">
                  <TableRow className="bg-muted/70 hover:bg-muted/70">
                    <TableHead className="w-12 text-center">
                      <Checkbox
                        aria-label="Select all"
                        checked={items.length > 0 && selectedIds.size === items.length}
                        onCheckedChange={selectAll}
                      />
                    </TableHead>
                    <TableHead className="w-36">Status</TableHead>
                    <TableHead>Headline & Summary</TableHead>
                    <TableHead className="w-48">Source & District</TableHead>
                    <TableHead className="w-24 text-center">Link</TableHead>
                    <TableHead className="w-60 text-right">Review Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item: any) => (
                    <TableRow key={item.id} className="hover:bg-muted/20 transition-colors">
                      <TableCell className="text-center">
                        <Checkbox
                          aria-label={`Select ${item.headline}`}
                          checked={selectedIds.has(item.id)}
                          onCheckedChange={() => toggleSelected(item.id)}
                        />
                      </TableCell>

                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-xs font-medium px-2 py-0.5 whitespace-nowrap ${color[item.evidence_status]}`}
                        >
                          {label[item.evidence_status]}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        <div className="font-semibold text-sm text-foreground">
                          {item.headline}
                        </div>
                        {item.summary && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {item.summary}
                          </p>
                        )}
                        {item.topic && (
                          <Badge variant="secondary" className="text-[10px] mt-1.5 font-normal">
                            {item.topic}
                          </Badge>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="text-xs font-medium text-foreground">
                          {item.source_name}
                        </div>
                        {item.district && (
                          <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                            <MapPin className="h-3 w-3 text-primary shrink-0" />
                            <span>{item.district}</span>
                          </div>
                        )}
                        {item.published_at && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">
                            {new Date(item.published_at).toLocaleDateString()}
                          </div>
                        )}
                      </TableCell>

                      <TableCell className="text-center">
                        <a
                          href={item.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline font-medium"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Source
                        </a>
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Select
                            defaultValue={item.evidence_status}
                            onValueChange={(value) =>
                              value &&
                              review.mutate({
                                id: item.id,
                                evidenceStatus: value as any,
                                relevance: item.relevance,
                              })
                            }
                          >
                            <SelectTrigger className="w-32 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {statuses.map((value) => (
                                <SelectItem key={value} value={value} className="text-xs">
                                  {label[value]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 text-xs cursor-pointer"
                            disabled={review.isPending || item.evidence_status === "supported"}
                            onClick={() =>
                              review.mutate({
                                id: item.id,
                                evidenceStatus: "supported",
                                relevance: "relevant",
                              })
                            }
                          >
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-600" />
                            Supported
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
