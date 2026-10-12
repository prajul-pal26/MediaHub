"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";

/**
 * The small amount of chrome the four library panels share.
 *
 * It exists so the panels agree on spacing, typography and the loading / empty /
 * error shapes without any of them importing from another panel. Nothing here
 * holds data or talks to the network.
 */

// ── Header ───────────────────────────────────────────────────────────────────

export function PanelHeader({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium leading-none">{title}</p>
          {hint && <p className="mt-1 text-xs leading-snug text-muted-foreground">{hint}</p>}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** A labelled group inside a panel. */
export function PanelGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

export function PanelLoading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function PanelEmpty({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: React.ElementType;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center">
      <Icon className="h-8 w-8 text-muted-foreground opacity-50" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function PanelError({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs leading-snug break-words text-destructive">{message}</p>
        {onRetry && (
          <Button type="button" variant="outline" size="xs" onClick={onRetry} disabled={retrying}>
            {retrying && <Loader2 className="animate-spin" />}
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

/** A quiet "N of M" style progress line used while uploads are in flight. */
export function PanelBusy({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      {label}
    </div>
  );
}

// ── Inline name prompt ───────────────────────────────────────────────────────

/**
 * An inline rename/create row instead of a modal.
 *
 * These panels mount inside the editor's inspector column, where a dialog would
 * both cover the canvas the user is naming and fight the shell for focus. Enter
 * submits, Escape cancels, and the field takes focus on mount so the flow is
 * keyboard-only if the user wants it to be.
 */
export function InlineNameForm({
  placeholder,
  submitLabel,
  busy = false,
  defaultValue = "",
  maxLength = 120,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  busy?: boolean;
  defaultValue?: string;
  maxLength?: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const trimmed = value.trim();

  function submit() {
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-7 text-xs"
      />
      <Button
        type="button"
        size="icon-sm"
        aria-label={submitLabel}
        title={submitLabel}
        disabled={!trimmed || busy}
        onClick={submit}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Check />}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Cancel"
        title="Cancel"
        disabled={busy}
        onClick={onCancel}
      >
        <X />
      </Button>
    </div>
  );
}

// ── Drop zone ────────────────────────────────────────────────────────────────

/**
 * A click-or-drop target. The hidden `<input type="file">` is what makes it
 * keyboard reachable — the visible surface is a real button, so Enter and Space
 * open the picker exactly like a click.
 */
export function DropZone({
  accept,
  multiple = true,
  disabled = false,
  busy = false,
  icon: Icon,
  title,
  hint,
  className,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ElementType;
  title: string;
  hint?: string;
  className?: string;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function handleFiles(list: FileList | null) {
    if (!list?.length) return;
    onFiles(Array.from(list));
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          if (disabled || busy) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (disabled || busy) return;
          handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-3 py-5 text-center transition-colors outline-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-muted hover:border-muted-foreground/50 hover:bg-muted/40",
          (disabled || busy) && "pointer-events-none opacity-50",
          className
        )}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Icon className="h-5 w-5 text-muted-foreground opacity-60" />
        )}
        <span className="text-xs font-medium">{title}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(event) => {
          handleFiles(event.target.files);
          // Allow re-picking the same file after a failed upload.
          event.target.value = "";
        }}
      />
    </>
  );
}
