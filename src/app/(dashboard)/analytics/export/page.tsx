"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  Download, FileText, Table2, Loader2, FileSpreadsheet,
  BarChart3, Eye, Heart, MessageSquare, Share2,
} from "lucide-react";

type Period = "7d" | "30d" | "90d" | "all";

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn",
  facebook: "Facebook", tiktok: "TikTok", twitter: "X", snapchat: "Snapchat",
};

function generateCSV(data: any): string {
  const headers = [
    "Title", "Platform", "Account", "Content Type", "Published At", "Source",
    "Views", "Impressions", "Likes", "Comments", "Shares", "Saves", "Reach", "Clicks",
    "Engagement Rate (%)", "Retention Rate (%)", "Watch Time (s)",
    "Sentiment", "Sentiment Score", "Sentiment Summary",
  ];

  const rows = data.rows.map((r: any) => [
    `"${(r.title || "").replace(/"/g, '""')}"`,
    r.platform,
    r.account,
    r.contentType,
    r.publishedAt ? new Date(r.publishedAt).toLocaleString() : "",
    r.source,
    r.views, r.impressions, r.likes, r.comments, r.shares, r.saves, r.reach, r.clicks,
    r.engagementRate, r.retentionRate, r.watchTimeSeconds,
    r.sentiment, r.sentimentScore,
    `"${(r.sentimentSummary || "").replace(/"/g, '""')}"`,
  ]);

  const summaryRows = [
    [`"${data.brandName} — Analytics Report"`],
    [`"Period: ${data.period === 'all' ? 'All Time' : `Last ${data.period}`}"`],
    [`"Generated: ${new Date(data.generatedAt).toLocaleString()}"`],
    [`"Total Posts: ${data.totals.posts}  |  Views: ${data.totals.views}  |  Likes: ${data.totals.likes}  |  Comments: ${data.totals.comments}  |  Shares: ${data.totals.shares}"`],
    [],
    headers,
    ...rows,
    [],
    ["Platform Summary"],
    ["Platform", "Posts", "Views", "Likes", "Comments", "Shares", "Impressions"],
    ...Object.entries(data.platformTotals).map(([platform, t]: [string, any]) => [
      PLATFORM_LABELS[platform] || platform, t.posts, t.views, t.likes, t.comments, t.shares, t.impressions,
    ]),
  ];

  return summaryRows.map(row => (row as any[]).join(",")).join("\n");
}

async function generatePDF(data: any) {
  const { default: jsPDF } = await import("jspdf");
  await import("jspdf-autotable");

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const brandName = data.brandName;
  const periodLabel = data.period === "all" ? "All Time" : `Last ${data.period}`;

  // ─── Title Page ───
  doc.setFontSize(28);
  doc.setFont("helvetica", "bold");
  doc.text(brandName, pageWidth / 2, 50, { align: "center" });

  doc.setFontSize(16);
  doc.setFont("helvetica", "normal");
  doc.text("Social Media Analytics Report", pageWidth / 2, 65, { align: "center" });

  doc.setFontSize(12);
  doc.setTextColor(100);
  doc.text(`Period: ${periodLabel}`, pageWidth / 2, 80, { align: "center" });
  doc.text(`Generated: ${new Date(data.generatedAt).toLocaleString()}`, pageWidth / 2, 88, { align: "center" });

  // KPI boxes
  doc.setTextColor(0);
  const kpis = [
    { label: "Posts", value: data.totals.posts },
    { label: "Views", value: data.totals.views },
    { label: "Likes", value: data.totals.likes },
    { label: "Comments", value: data.totals.comments },
    { label: "Shares", value: data.totals.shares },
    { label: "Reach", value: data.totals.reach },
  ];

  const kpiStartX = 30;
  const kpiWidth = (pageWidth - 60) / kpis.length;
  const kpiY = 110;

  kpis.forEach((kpi, i) => {
    const x = kpiStartX + i * kpiWidth;
    doc.setDrawColor(200);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, kpiY, kpiWidth - 4, 25, 2, 2, "FD");

    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(kpi.value.toLocaleString(), x + (kpiWidth - 4) / 2, kpiY + 11, { align: "center" });

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(kpi.label, x + (kpiWidth - 4) / 2, kpiY + 19, { align: "center" });
    doc.setTextColor(0);
  });

  // ─── Platform Breakdown Page ───
  doc.addPage();
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Platform Breakdown", 14, 20);

  const platRows = Object.entries(data.platformTotals).map(([platform, t]: [string, any]) => [
    PLATFORM_LABELS[platform] || platform,
    t.posts.toString(),
    t.views.toLocaleString(),
    t.likes.toLocaleString(),
    t.comments.toLocaleString(),
    t.shares.toLocaleString(),
    t.impressions.toLocaleString(),
    t.views > 0 ? `${Math.round((t.likes + t.comments + t.shares) / t.views * 10000) / 100}%` : "0%",
  ]);

  (doc as any).autoTable({
    startY: 28,
    head: [["Platform", "Posts", "Views", "Likes", "Comments", "Shares", "Impressions", "Engagement"]],
    body: platRows,
    theme: "grid",
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 9, fontStyle: "bold" },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  // ─── All Posts Detail Page ───
  doc.addPage();
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Post Performance Detail", 14, 20);

  const postRows = data.rows.map((r: any) => [
    r.title.length > 35 ? r.title.slice(0, 35) + "..." : r.title,
    PLATFORM_LABELS[r.platform] || r.platform,
    r.account,
    r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : "",
    r.views.toLocaleString(),
    r.likes.toLocaleString(),
    r.comments.toLocaleString(),
    r.shares.toLocaleString(),
    `${r.engagementRate}%`,
    r.sentiment !== "—" ? r.sentiment : "",
  ]);

  (doc as any).autoTable({
    startY: 28,
    head: [["Title", "Platform", "Account", "Published", "Views", "Likes", "Comments", "Shares", "Engagement", "Sentiment"]],
    body: postRows,
    theme: "grid",
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 8, fontStyle: "bold" },
    bodyStyles: { fontSize: 7.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 0: { cellWidth: 50 } },
  });

  // ─── Sentiment Summary Page ───
  const sentimentRows = data.rows.filter((r: any) => r.sentiment !== "—");
  if (sentimentRows.length > 0) {
    doc.addPage();
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text("Sentiment Analysis", 14, 20);

    const sentRows = sentimentRows.map((r: any) => [
      r.title.length > 40 ? r.title.slice(0, 40) + "..." : r.title,
      r.platform,
      r.sentiment,
      r.sentimentScore.toFixed(2),
      r.sentimentSummary.length > 80 ? r.sentimentSummary.slice(0, 80) + "..." : r.sentimentSummary,
    ]);

    (doc as any).autoTable({
      startY: 28,
      head: [["Post", "Platform", "Sentiment", "Score", "Summary"]],
      body: sentRows,
      theme: "grid",
      headStyles: { fillColor: [236, 72, 153], textColor: 255, fontSize: 9, fontStyle: "bold" },
      bodyStyles: { fontSize: 8 },
      alternateRowStyles: { fillColor: [253, 242, 248] },
      columnStyles: { 4: { cellWidth: 80 } },
    });
  }

  // ─── Footer on every page ───
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`${brandName} — Analytics Report — Page ${i} of ${pageCount}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 8, { align: "center" });
    doc.text("Generated by MediaHub", pageWidth - 14, doc.internal.pageSize.getHeight() - 8, { align: "right" });
  }

  return doc;
}

export default function ExportPage() {
  const { activeBrandId, loading } = useBrand();
  const [period, setPeriod] = useState<Period>("30d");
  const [exporting, setExporting] = useState<string | null>(null);

  const { data, isLoading } = trpc.analytics.getExportData.useQuery(
    { brandId: activeBrandId!, period },
    { enabled: !!activeBrandId }
  );

  async function handleCSV() {
    if (!data) return;
    setExporting("csv");
    try {
      const csv = generateCSV(data);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.brandName.replace(/\s+/g, "_")}_analytics_${period}_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    } catch (e: any) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(null);
    }
  }

  async function handlePDF() {
    if (!data) return;
    setExporting("pdf");
    try {
      const doc = await generatePDF(data);
      doc.save(`${data.brandName.replace(/\s+/g, "_")}_analytics_${period}_${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success("PDF downloaded");
    } catch (e: any) {
      toast.error(`Export failed: ${e.message}`);
    } finally {
      setExporting(null);
    }
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
        <h1 className="text-2xl font-bold">Export Reports</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Download className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Export Reports</h1>
        <p className="text-muted-foreground">Download analytics reports for meetings and presentations</p>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Period:</span>
        {(["7d", "30d", "90d", "all"] as Period[]).map((p) => (
          <Button key={p} variant={period === p ? "default" : "outline"} size="sm" onClick={() => setPeriod(p)}>
            {p === "all" ? "All Time" : p}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No data for this period</p>
            <p className="text-sm">Publish content and wait for analytics to be collected</p>
          </div>
        </div>
      ) : (
        <>
          {/* Export Buttons */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={handlePDF}>
              <CardContent className="pt-6 flex items-center gap-4">
                <div className="h-14 w-14 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
                  <FileText className="h-7 w-7 text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-lg">PDF Report</h3>
                  <p className="text-sm text-muted-foreground">
                    Professional multi-page report with KPIs, platform breakdown, post details, and sentiment. Ready for presentations.
                  </p>
                </div>
                <Button disabled={!!exporting} onClick={(e) => { e.stopPropagation(); handlePDF(); }}>
                  {exporting === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </Button>
              </CardContent>
            </Card>

            <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={handleCSV}>
              <CardContent className="pt-6 flex items-center gap-4">
                <div className="h-14 w-14 rounded-xl bg-green-100 flex items-center justify-center flex-shrink-0">
                  <FileSpreadsheet className="h-7 w-7 text-green-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-lg">CSV Spreadsheet</h3>
                  <p className="text-sm text-muted-foreground">
                    Full data export with every metric per post. Open in Excel, Google Sheets, or any spreadsheet tool.
                  </p>
                </div>
                <Button disabled={!!exporting} onClick={(e) => { e.stopPropagation(); handleCSV(); }}>
                  {exporting === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Data Preview */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Table2 className="h-5 w-5" />
                Report Preview — {data.brandName}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Summary KPIs */}
              <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-6">
                {[
                  { icon: <BarChart3 className="h-4 w-4" />, label: "Posts", value: data.totals.posts },
                  { icon: <Eye className="h-4 w-4" />, label: "Views", value: data.totals.views },
                  { icon: <Heart className="h-4 w-4" />, label: "Likes", value: data.totals.likes },
                  { icon: <MessageSquare className="h-4 w-4" />, label: "Comments", value: data.totals.comments },
                  { icon: <Share2 className="h-4 w-4" />, label: "Shares", value: data.totals.shares },
                ].map((kpi) => (
                  <div key={kpi.label} className="p-3 rounded-lg border bg-muted/30 text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">{kpi.icon}</div>
                    <p className="text-lg font-bold">{kpi.value.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">{kpi.label}</p>
                  </div>
                ))}
              </div>

              {/* Platform breakdown */}
              <h4 className="text-sm font-semibold mb-2">Platform Breakdown</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
                {Object.entries(data.platformTotals).map(([platform, t]: [string, any]) => (
                  <div key={platform} className="p-3 rounded-lg border">
                    <p className="text-sm font-medium">{PLATFORM_LABELS[platform] || platform}</p>
                    <p className="text-xs text-muted-foreground">{t.posts} posts</p>
                    <div className="flex gap-3 mt-1 text-xs">
                      <span>{t.views.toLocaleString()} views</span>
                      <span>{t.likes.toLocaleString()} likes</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Post list preview */}
              <h4 className="text-sm font-semibold mb-2">Posts ({data.rows.length})</h4>
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {data.rows.slice(0, 20).map((r: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded border text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-[10px] shrink-0">{PLATFORM_LABELS[r.platform] || r.platform}</Badge>
                      <span className="truncate">{r.title}</span>
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground shrink-0 ml-4">
                      <span>{r.views.toLocaleString()} views</span>
                      <span>{r.likes} likes</span>
                      <span>{r.engagementRate}%</span>
                    </div>
                  </div>
                ))}
                {data.rows.length > 20 && (
                  <p className="text-xs text-muted-foreground text-center py-2">
                    +{data.rows.length - 20} more posts in the full export
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
