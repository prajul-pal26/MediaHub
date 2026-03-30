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

export function PersonalLlmKey() {
  const [showDialog, setShowDialog] = useState(false);
  const { data: configs = [], isLoading } = trpc.llm.listConfigs.useQuery();
  const { data: usageData } = trpc.llm.getUsageSummary.useQuery();
  const utils = trpc.useUtils();

  const deleteMutation = trpc.llm.deleteConfig.useMutation({
    onSuccess: () => {
      toast.success("Personal LLM key removed");
      utils.llm.listConfigs.invalidate();
      utils.llm.getActiveConfig.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const personalConfig = configs.find((c: any) => c.scope === "user");
  const summary = usageData?.summary;

  function handleRemove() {
    if (!personalConfig) return;
    if (
      confirm(
        "Remove your personal LLM key? You will fall back to the org/brand LLM."
      )
    ) {
      deleteMutation.mutate({ id: personalConfig.id });
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
      <div className="flex items-center gap-2">
        <Key className="h-5 w-5 text-primary" />
        <div>
          <h2 className="text-lg font-semibold">Personal LLM Key</h2>
          <p className="text-sm text-muted-foreground">
            Configure your own LLM API key for chat
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          {personalConfig ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Provider</p>
                  <p className="font-medium">
                    {providerLabels[personalConfig.provider as Provider] ||
                      personalConfig.provider}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Model</p>
                  <p className="font-medium">
                    {personalConfig.default_model || "Default"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">API Key</p>
                  <p className="font-mono text-xs">
                    {personalConfig.api_key_masked}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Badge variant="default">Configured</Badge>
              </div>

              {summary && (
                <div className="grid grid-cols-2 gap-3 pt-2 border-t text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">
                      Requests Today
                    </p>
                    <p className="font-semibold">
                      {summary.daily_requests}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">
                      Requests This Month
                    </p>
                    <p className="font-semibold">
                      {summary.monthly_requests}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowDialog(true)}
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Edit My LLM Key
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-500 hover:text-red-700"
                  onClick={handleRemove}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                No personal LLM key configured.
              </p>
              <Button size="sm" onClick={() => setShowDialog(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add My LLM Key
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Your personal key takes priority over the org/brand LLM.
      </p>

      {showDialog && (
        <PersonalKeyDialog
          open={showDialog}
          onClose={() => setShowDialog(false)}
          existingConfig={personalConfig}
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
  } | null;
}) {
  const [provider, setProvider] = useState<Provider>(
    (existingConfig?.provider as Provider) || "openrouter"
  );
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
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
        scope: "user",
        provider,
        api_key: apiKey || "unchanged",
        default_model: model || undefined,
        label: "Personal",
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
                placeholder="Enter model identifier"
                disabled={saving}
              />
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
