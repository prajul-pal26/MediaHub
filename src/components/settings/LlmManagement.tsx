"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Brain,
  Key,
  Shield,
  BarChart3,
  Loader2,
  Save,
  CheckCircle2,
  Eye,
  EyeOff,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

// ─── Provider / model config ───

type Provider = "openrouter" | "openai" | "anthropic" | "google" | "custom";

const providerLabels: Record<Provider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  custom: "Custom",
};

const modelsByProvider: Record<Provider, { value: string; label: string }[]> = {
  openrouter: [
    { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "deepseek/deepseek-chat-v3", label: "DeepSeek Chat V3" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  google: [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
  custom: [],
};

// ─── Upsert Config Dialog ───

function ConfigDialog({
  open,
  onClose,
  existingConfig,
  scope,
}: {
  open: boolean;
  onClose: () => void;
  existingConfig?: {
    id: string;
    provider: string;
    default_model: string | null;
    base_url: string | null;
    api_key_masked: string;
  } | null;
  scope: "org" | "brand" | "user";
}) {
  const [provider, setProvider] = useState<Provider>(
    (existingConfig?.provider as Provider) || "openrouter"
  );
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(existingConfig?.base_url || "");
  const [model, setModel] = useState(existingConfig?.default_model || "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const utils = trpc.useUtils();
  const upsertMutation = trpc.llm.upsertConfig.useMutation();
  const testMutation = trpc.credentials.test.useMutation();

  const models = modelsByProvider[provider] || [];

  async function handleSave() {
    if (!apiKey && !existingConfig) {
      toast.error("API Key is required");
      return;
    }
    setSaving(true);
    try {
      await upsertMutation.mutateAsync({
        id: existingConfig?.id,
        scope,
        provider,
        api_key: apiKey || "unchanged",
        base_url: provider === "custom" ? baseUrl : undefined,
        default_model: model || undefined,
        label: "Default",
      });
      toast.success("LLM configuration saved");
      utils.llm.listConfigs.invalidate();
      utils.llm.getActiveConfig.invalidate();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save";
      toast.error(msg);
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    try {
      const result = await testMutation.mutateAsync({
        platform: "llm_provider" as any,
      });
      if (result.success) toast.success(result.message || "LLM connection verified");
      else toast.error(result.error || "Test failed");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Test failed";
      toast.error(msg);
    }
    setTesting(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existingConfig ? "Edit" : "Add"} {scope === "org" ? "Org" : "Personal"} LLM Configuration
          </DialogTitle>
          <DialogDescription>
            Configure the LLM provider and API key for{" "}
            {scope === "org" ? "your organization" : "your personal use"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v as Provider);
                setModel("");
              }}
              disabled={saving}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(providerLabels) as Provider[]).map((p) => (
                  <SelectItem key={p} value={p}>
                    {providerLabels[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={existingConfig?.api_key_masked || "Enter API key"}
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {provider === "custom" && (
            <div className="space-y-2">
              <Label>Base URL</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                disabled={saving}
              />
            </div>
          )}

          {models.length > 0 && (
            <div className="space-y-2">
              <Label>Default Model</Label>
              <Select
                value={model}
                onValueChange={(v) => setModel(v || "")}
                disabled={saving}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {provider === "custom" && (
            <div className="space-y-2">
              <Label>Model ID</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Enter model identifier"
                disabled={saving}
              />
            </div>
          )}

          <Separator />

          <div className="flex gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="flex-1"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !existingConfig}
            >
              {testing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-2" />
              )}
              Test
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tab 1: LLM Providers (multiple org configs) ───

function LlmProvidersTab() {
  const [showDialog, setShowDialog] = useState(false);
  const [editConfig, setEditConfig] = useState<any>(null);
  const { data: configs = [], isLoading } = trpc.llm.listConfigs.useQuery();
  const utils = trpc.useUtils();
  const deleteMutation = trpc.llm.deleteConfig.useMutation({
    onSuccess: () => { toast.success("LLM provider removed"); utils.llm.listConfigs.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const orgConfigs = configs.filter((c: any) => c.scope === "org");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Organization LLM Providers</h3>
          <p className="text-xs text-muted-foreground">
            Add multiple providers and assign different ones to different brands
          </p>
        </div>
        <Button size="sm" onClick={() => { setEditConfig(null); setShowDialog(true); }}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Provider
        </Button>
      </div>

      {orgConfigs.length > 0 ? (
        <div className="grid gap-3">
          {orgConfigs.map((cfg: any) => (
            <Card key={cfg.id}>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="grid grid-cols-3 gap-4 text-sm flex-1">
                    <div>
                      <p className="text-muted-foreground text-xs">Provider</p>
                      <p className="font-medium">
                        {providerLabels[cfg.provider as Provider] || cfg.provider}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Model</p>
                      <p className="font-medium">{cfg.default_model || "Default"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">API Key</p>
                      <p className="font-mono text-xs">{cfg.api_key_masked}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Badge variant={cfg.is_active ? "default" : "secondary"}>
                      {cfg.is_active ? "Active" : "Inactive"}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => { setEditConfig(cfg); setShowDialog(true); }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500 hover:text-red-600"
                      onClick={() => { if (confirm(`Remove ${providerLabels[cfg.provider as Provider] || cfg.provider}?`)) deleteMutation.mutate({ id: cfg.id }); }}
                      disabled={deleteMutation.isPending}
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No LLM providers configured yet. Click &quot;Add Provider&quot; to add one.
          </CardContent>
        </Card>
      )}

      <ConfigDialog
        open={showDialog}
        onClose={() => { setShowDialog(false); setEditConfig(null); }}
        existingConfig={editConfig}
        scope="org"
      />
    </div>
  );
}

// ─── Tab 2: Brand Access (assign specific LLM per brand) ───

const llmPlatformLabels: Record<string, string> = {
  llm_openrouter: "OpenRouter",
  llm_anthropic: "Anthropic (Claude)",
  llm_openai: "OpenAI (GPT)",
  llm_google: "Google Gemini",
};

function BrandAccessTab() {
  const { data: brands = [] } = trpc.brands.list.useQuery();
  const { data: credentials = [] } = trpc.credentials.list.useQuery();
  const { data: accessList = [], isLoading } = trpc.llm.listBrandAccess.useQuery();
  const utils = trpc.useUtils();

  // Only show the 4 new LLM providers that are configured (exclude legacy llm_provider)
  const connectedLlmProviders = credentials
    .filter((c: any) => c.platform.startsWith("llm_") && c.platform !== "llm_provider")
    .map((c: any) => c.platform);

  const grantMutation = trpc.llm.grantBrandAccess.useMutation({
    onSuccess: () => {
      toast.success("Brand LLM access updated");
      utils.llm.listBrandAccess.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const revokeMutation = trpc.llm.revokeBrandAccess.useMutation({
    onSuccess: () => {
      toast.success("Brand LLM access revoked");
      utils.llm.listBrandAccess.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  function getAccessForBrand(brandId: string) {
    return accessList.find((a: any) => a.brand_id === brandId && a.is_active);
  }

  function handleAssign(brandId: string, provider: string) {
    if (provider === "none") {
      revokeMutation.mutate({ brand_id: brandId });
    } else {
      grantMutation.mutate({ brand_id: brandId, provider });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Brand LLM Access</h3>
        <p className="text-xs text-muted-foreground">
          Assign a specific LLM provider to each brand. Different brands can use different providers based on their plan.
        </p>
      </div>

      {connectedLlmProviders.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No LLM providers configured yet. Go to &quot;Platform Credentials&quot; tab and add at least one LLM provider (OpenRouter, Anthropic, OpenAI, or Google Gemini).
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-4 divide-y">
            {brands.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No brands found
              </p>
            ) : (
              brands.map((brand: any) => {
                const access = getAccessForBrand(brand.id);
                const assignedProvider = access?.provider || "none";

                return (
                  <div
                    key={brand.id}
                    className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                        {brand.name?.[0]?.toUpperCase() || "?"}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{brand.name}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Select
                        value={assignedProvider}
                        onValueChange={(v) => handleAssign(brand.id, v)}
                        disabled={grantMutation.isPending || revokeMutation.isPending}
                      >
                        <SelectTrigger className="w-[200px] h-9 text-sm">
                          <SelectValue placeholder="No LLM assigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No access</SelectItem>
                          {connectedLlmProviders.map((platform: string) => (
                            <SelectItem key={platform} value={platform}>
                              {llmPlatformLabels[platform] || platform}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Badge variant={access ? "default" : "secondary"}>
                        {access ? llmPlatformLabels[assignedProvider] || "Active" : "No access"}
                      </Badge>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Tab 3: Usage & Limits ───

function UsageLimitsTab() {
  const { data: brands = [] } = trpc.brands.list.useQuery();
  const { data: usageData } = trpc.llm.getUsageSummary.useQuery();
  const [limitsDialogBrand, setLimitsDialogBrand] = useState<{
    id: string;
    name: string;
  } | null>(null);

  return (
    <div className="space-y-4">
      {/* Org usage summary */}
      {usageData?.summary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              Organization Usage Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">
                  Today&apos;s Requests
                </p>
                <p className="text-lg font-semibold">
                  {usageData.summary.daily_requests}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">
                  Monthly Requests
                </p>
                <p className="text-lg font-semibold">
                  {usageData.summary.monthly_requests}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Total Tokens</p>
                <p className="text-lg font-semibold">
                  {usageData.summary.total_tokens.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">
                  Est. Cost
                </p>
                <p className="text-lg font-semibold">
                  ${usageData.summary.total_cost.toFixed(4)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-brand usage cards */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Per-Brand Usage</h3>
        <div className="grid gap-3">
          {brands.map((brand: any) => (
            <BrandUsageCard
              key={brand.id}
              brand={brand}
              onSetLimits={() =>
                setLimitsDialogBrand({ id: brand.id, name: brand.name })
              }
            />
          ))}
          {brands.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No brands found
            </p>
          )}
        </div>
      </div>

      {limitsDialogBrand && (
        <LimitsDialog
          brandId={limitsDialogBrand.id}
          brandName={limitsDialogBrand.name}
          open={!!limitsDialogBrand}
          onClose={() => setLimitsDialogBrand(null)}
        />
      )}
    </div>
  );
}

function BrandUsageCard({
  brand,
  onSetLimits,
}: {
  brand: { id: string; name: string };
  onSetLimits: () => void;
}) {
  const { data: usageData } = trpc.llm.getUsageSummary.useQuery({
    brand_id: brand.id,
  });
  const { data: limits = [] } = trpc.llm.getLimits.useQuery({
    brand_id: brand.id,
  });

  const limit = limits[0] as
    | {
        daily_requests: number;
        monthly_requests: number;
        max_tokens_per_request: number;
      }
    | undefined;
  const summary = usageData?.summary;

  const dailyPct = limit && summary
    ? Math.min(100, Math.round((summary.daily_requests / limit.daily_requests) * 100))
    : 0;
  const monthlyPct = limit && summary
    ? Math.min(100, Math.round((summary.monthly_requests / limit.monthly_requests) * 100))
    : 0;

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
              {brand.name?.[0]?.toUpperCase() || "?"}
            </div>
            <p className="text-sm font-medium">{brand.name}</p>
          </div>
          <Button size="sm" variant="outline" onClick={onSetLimits}>
            Set Limits
          </Button>
        </div>

        {limit && summary ? (
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Daily Requests</span>
                <span>
                  {summary.daily_requests} / {limit.daily_requests}
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Monthly Requests</span>
                <span>
                  {summary.monthly_requests} / {limit.monthly_requests}
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${monthlyPct}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No limits configured. Click &quot;Set Limits&quot; to add usage
            limits.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Limits Dialog ───

function LimitsDialog({
  brandId,
  brandName,
  open,
  onClose,
}: {
  brandId: string;
  brandName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: existingLimits = [] } = trpc.llm.getLimits.useQuery({
    brand_id: brandId,
  });
  const existing = existingLimits[0] as
    | {
        daily_requests: number;
        monthly_requests: number;
        max_tokens_per_request: number;
      }
    | undefined;

  const [daily, setDaily] = useState(existing?.daily_requests ?? 100);
  const [monthly, setMonthly] = useState(existing?.monthly_requests ?? 3000);
  const [maxTokens, setMaxTokens] = useState(
    existing?.max_tokens_per_request ?? 4096
  );
  const [saving, setSaving] = useState(false);

  const utils = trpc.useUtils();
  const setLimitsMutation = trpc.llm.setLimits.useMutation();

  async function handleSave() {
    setSaving(true);
    try {
      await setLimitsMutation.mutateAsync({
        brand_id: brandId,
        daily_requests: daily,
        monthly_requests: monthly,
        max_tokens_per_request: maxTokens,
      });
      toast.success(`Limits updated for ${brandName}`);
      utils.llm.getLimits.invalidate();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save limits";
      toast.error(msg);
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Set Limits: {brandName}</DialogTitle>
          <DialogDescription>
            Configure usage limits for this brand.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Daily Request Limit</Label>
            <Input
              type="number"
              value={daily}
              onChange={(e) => setDaily(Number(e.target.value))}
              min={0}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label>Monthly Request Limit</Label>
            <Input
              type="number"
              value={monthly}
              onChange={(e) => setMonthly(Number(e.target.value))}
              min={0}
              disabled={saving}
            />
          </div>
          <div className="space-y-2">
            <Label>Max Tokens per Request</Label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              min={0}
              disabled={saving}
            />
          </div>

          <Separator />

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Limits
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───

export function LlmManagement() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">LLM Access Control</h2>
          <p className="text-sm text-muted-foreground">
            Manage AI chat providers, brand access, and usage limits
          </p>
        </div>
      </div>

      <Tabs defaultValue="access">
        <TabsList>
          <TabsTrigger value="access" className="gap-2">
            <Shield className="h-3.5 w-3.5" />
            Brand Access
          </TabsTrigger>
          <TabsTrigger value="usage" className="gap-2">
            <BarChart3 className="h-3.5 w-3.5" />
            Usage &amp; Limits
          </TabsTrigger>
        </TabsList>

        <TabsContent value="access" className="mt-4">
          <BrandAccessTab />
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <UsageLimitsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
