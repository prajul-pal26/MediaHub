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
import { Separator } from "@/components/ui/separator";
import {
  Key,
  Loader2,
  Save,
  CheckCircle2,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

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

type UserConfig = {
  id: string;
  provider: string;
  default_model: string | null;
  base_url: string | null;
  api_key_masked: string;
  api_key?: string;
  label?: string;
  is_active?: boolean;
};

export function PersonalLlmKey() {
  const [dialog, setDialog] = useState<UserConfig | "new" | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const { data: configs = [], isLoading } = trpc.llm.listConfigs.useQuery();
  const { data: usageData } = trpc.llm.getUsageSummary.useQuery();
  const utils = trpc.useUtils();

  const refresh = () => {
    utils.llm.listConfigs.invalidate();
    utils.llm.getActiveConfig.invalidate();
  };

  const deleteMutation = trpc.llm.deleteConfig.useMutation({
    onSuccess: () => {
      toast.success("Key removed");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const activateMutation = trpc.llm.setActiveConfig.useMutation({
    onSuccess: () => {
      toast.success("Active key switched");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const userConfigs = (configs as any[]).filter(
    (c) => c.scope === "user"
  ) as UserConfig[];
  const summary = usageData?.summary;

  function handleRemove(cfg: UserConfig) {
    if (confirm(`Remove the key for ${cfg.label || "this account"}?`)) {
      deleteMutation.mutate({ id: cfg.id });
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Personal LLM Keys</h2>
            <p className="text-sm text-muted-foreground">
              Chat pools all saved keys, load-balances across them, and auto-switches
              when one hits its free limit.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setDialog("new")}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Add key
        </Button>
      </div>

      {userConfigs.length === 0 ? (
        <Card>
          <CardContent className="text-center py-8 space-y-3">
            <p className="text-sm text-muted-foreground">
              No personal LLM key configured.
            </p>
            <Button size="sm" onClick={() => setDialog("new")}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add your first key
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {userConfigs.map((cfg) => {
            const show = !!revealed[cfg.id];
            return (
              <Card key={cfg.id} className={cfg.is_active ? "border-primary" : undefined}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">
                          {cfg.label && cfg.label !== "Personal"
                            ? cfg.label
                            : "Personal key"}
                        </p>
                        {cfg.is_active ? (
                          <Badge variant="default" className="gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Active
                          </Badge>
                        ) : (
                          <Badge variant="outline">Saved</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {providerLabels[cfg.provider as Provider] || cfg.provider}
                        {" · "}
                        {cfg.default_model || "default model"}
                      </p>
                    </div>
                    {!cfg.is_active && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => activateMutation.mutate({ id: cfg.id })}
                        disabled={activateMutation.isPending}
                      >
                        Use this key
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {show ? cfg.api_key || cfg.api_key_masked : cfg.api_key_masked}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        setRevealed((r) => ({ ...r, [cfg.id]: !r[cfg.id] }))
                      }
                      className="text-muted-foreground hover:text-foreground shrink-0"
                      aria-label={show ? "Hide key" : "Show key"}
                    >
                      {show ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>

                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => setDialog(cfg)}>
                      <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-500 hover:text-red-700"
                      onClick={() => handleRemove(cfg)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {summary && (
        <Card>
          <CardContent className="grid grid-cols-2 gap-3 pt-4 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Requests Today</p>
              <p className="font-semibold">{summary.daily_requests}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Requests This Month</p>
              <p className="font-semibold">{summary.monthly_requests}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Your saved keys take priority over the org/brand LLM. The active key is tried
        first; the rest are automatic failovers if it&apos;s rate-limited.
      </p>

      {dialog !== null && (
        <PersonalKeyDialog
          open={dialog !== null}
          onClose={() => setDialog(null)}
          existingConfig={dialog === "new" ? null : dialog}
        />
      )}
    </div>
  );
}

// ─── Personal Key Dialog ───

function PersonalKeyDialog({
  open,
  onClose,
  existingConfig,
}: {
  open: boolean;
  onClose: () => void;
  existingConfig?: {
    id: string;
    provider: string;
    default_model: string | null;
    base_url: string | null;
    api_key_masked: string;
    api_key?: string;
    label?: string;
    is_active?: boolean;
  } | null;
}) {
  const [provider, setProvider] = useState<Provider>(
    (existingConfig?.provider as Provider) || "openrouter"
  );
  // Pre-fill the real key so the eye-toggle reveals it and edits don't wipe it.
  const [apiKey, setApiKey] = useState(existingConfig?.api_key || "");
  const [baseUrl, setBaseUrl] = useState(existingConfig?.base_url || "");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(existingConfig?.default_model || "");
  const [accountEmail, setAccountEmail] = useState(
    existingConfig?.label && existingConfig.label !== "Personal" ? existingConfig.label : ""
  );
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
        scope: "user",
        provider,
        api_key: apiKey || "unchanged",
        base_url: provider === "custom" ? baseUrl || undefined : undefined,
        default_model: model || undefined,
        label: accountEmail.trim() || "Personal",
        // New keys become active (switch to it); edits keep current state.
        is_active: existingConfig ? existingConfig.is_active ?? true : true,
      });
      toast.success("Personal LLM key saved");
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
      if (result.success)
        toast.success(result.message || "LLM connection verified");
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
            {existingConfig ? "Edit" : "Add"} Personal LLM Key
          </DialogTitle>
          <DialogDescription>
            Configure your personal LLM API key. This takes priority over
            org/brand LLM settings.
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
                placeholder={
                  existingConfig?.api_key_masked || "Enter API key"
                }
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

          <div className="space-y-2">
            <Label>Account email</Label>
            <Input
              type="email"
              value={accountEmail}
              onChange={(e) => setAccountEmail(e.target.value)}
              placeholder="agent@cotgen.in"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              The account this API key was created under — shown for reference.
            </p>
          </div>

          {provider === "custom" && (
            <div className="space-y-2">
              <Label>Base URL</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://integrate.api.nvidia.com/v1"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                OpenAI-compatible endpoint. For NVIDIA NIM use{" "}
                <code className="text-[11px]">https://integrate.api.nvidia.com/v1</code>.
              </p>
            </div>
          )}

          {models.length > 0 ? (
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
          ) : provider === "custom" ? (
            <div className="space-y-2">
              <Label>Model ID</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="meta/llama-3.1-70b-instruct"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Use a model that supports tool-calling and is available on your tier —{" "}
                <code className="text-[11px]">meta/llama-3.1-70b-instruct</code> (recommended)
                or <code className="text-[11px]">meta/llama-3.1-8b-instruct</code> (fastest).
                Note: heavy models like <code className="text-[11px]">llama-3.3-70b</code> /
                <code className="text-[11px]">deepseek-v4</code> often time out or 503 on the
                free tier.
              </p>
            </div>
          ) : null}

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
