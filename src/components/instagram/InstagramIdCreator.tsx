"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { CalendarDays, KeyRound, Mail, Plus, RefreshCw, Search, UserRound, UserRoundPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc/client";
import { useBrand } from "@/lib/hooks/use-brand";

type CreatorForm = {
  email: string;
  password: string;
  day: string;
  month: string;
  year: string;
  fullName: string;
  username: string;
};

type CreatorReply = {
  source?: string;
  state?: "opening" | "filled" | "otp-required" | "otp-submitted" | "complete" | "error";
  message?: string;
};
type ImportedProfile = {
  id: string;
  district: string | null;
  instaName: string;
  email: string;
  password: string;
  status: "pending" | "done";
  sourceRowNumber: number;
};
type NewProfile = { district: string; instaName: string; email: string; password: string };

const months = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const initialForm: CreatorForm = {
  email: "", password: "", day: "", month: "", year: "", fullName: "", username: "",
};

/**
 * Hands a one-time, in-memory request to the locally installed Chrome extension.
 * Credentials are sent only to the user-installed local extension for this
 * explicit account-creation action; the database stores profile credentials encrypted.
 */
export function InstagramIdCreator() {
  const [form, setForm] = useState<CreatorForm>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [otpOpen, setOtpOpen] = useState(false);
  const [otp, setOtp] = useState("");
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  const [otpResult, setOtpResult] = useState<"idle" | "success" | "error">("idle");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileSearch, setProfileSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newProfile, setNewProfile] = useState<NewProfile>({ district: "", instaName: "", email: "", password: "" });
  const utils = trpc.useUtils();
  const { activeBrandId } = useBrand();
  const profilesQuery = trpc.instaProfileUsers.list.useQuery();
  const statusMutation = trpc.instaProfileUsers.setStatus.useMutation({
    onSuccess: () => utils.instaProfileUsers.list.invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const syncSheetMutation = trpc.instaProfileUsers.syncSheet.useMutation({
    onSuccess: (result) => {
      toast.success(`Google Sheet synced: ${result.updated} updated${result.appended ? `, ${result.appended} added` : ""}.`);
      utils.instaProfileUsers.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const profiles = (profilesQuery.data ?? []) as ImportedProfile[];
  const matchingProfiles = useMemo(() => {
    const query = profileSearch.trim();
    if (!query) return profiles;
    // Treat the query as text, not executable regex. Separators are deliberately
    // interchangeable so `Badalta Moradabad` finds `Badalta_Moradabad`.
    const expression = new RegExp(query
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[\s_.-]+/g, "[\\s_.-]*"), "i");
    return profiles.filter((profile) => expression.test(profile.instaName));
  }, [profileSearch, profiles]);
  const createMutation = trpc.instaProfileUsers.create.useMutation({
    onSuccess: (profile) => {
      setSelectedProfileId(profile.id);
      setForm({ email: profile.email, password: profile.password, day: "26", month: "3", year: "2002", fullName: profile.instaName, username: profile.instaName });
      setNewProfile({ district: "", instaName: "", email: "", password: "" });
      setAddOpen(false);
      toast.success("Instagram profile added as Pending");
      utils.instaProfileUsers.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    function receive(event: MessageEvent<CreatorReply>) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.source !== "mediahub-instagram-id-creator") return;
      const reply = event.data;
      if (reply.state === "filled") {
        setSubmitting(false);
        toast.success("Instagram sign-up form filled.");
      } else if (reply.state === "otp-required") {
        setOtpResult("idle");
        setOtp("");
        setOtpOpen(true);
      } else if (reply.state === "otp-submitted" || reply.state === "complete") {
        setOtpSubmitting(false);
        setOtpResult("success");
      } else if (reply.state === "error") {
        setSubmitting(false);
        setOtpSubmitting(false);
        toast.error(reply.message || "The Chrome extension could not complete that step.");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function update<K extends keyof CreatorForm>(key: K, value: CreatorForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function fillInChrome(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    window.postMessage({
      source: "mediahub-instagram-id-creator",
      action: "fill-signup",
      payload: form,
    }, window.location.origin);
    window.setTimeout(() => setSubmitting((current) => {
      if (current) toast.error("Chrome did not respond. Install and enable the MediaHub Instagram ID Creator extension, then try again.");
      return false;
    // Instagram can render slowly on a cold tab. The extension waits for real
    // fields, so don't present a false bridge failure while that is happening.
    }), 18_000);
  }

  function sendToChrome(action: "submit-otp", payload?: { otp: string }) {
    window.postMessage({
      source: "mediahub-instagram-id-creator",
      action,
      payload,
    }, window.location.origin);
  }

  function submitOtp(event: FormEvent) {
    event.preventDefault();
    if (!otp.trim()) return;
    setOtpSubmitting(true);
    setOtpResult("idle");
    sendToChrome("submit-otp", { otp: otp.trim() });
    window.setTimeout(() => setOtpSubmitting((current) => {
      if (current) toast.error("Chrome did not confirm the verification step. Check the Instagram tab and try again.");
      return false;
    }), 12_000);
  }

  const complete = Object.values(form).every(Boolean);

  function selectProfile(id: string | null) {
    if (!id) return;
    setSelectedProfileId(id);
    const profile = profiles.find((row) => row.id === id);
    if (!profile) return;
    setForm({
      email: profile.email,
      password: profile.password,
      day: "26",
      month: "3",
      year: "2002",
      fullName: profile.instaName,
      username: profile.instaName,
    });
  }

  function searchProfile() {
    const pendingMatches = matchingProfiles.filter((profile) => profile.status === "pending");
    if (!profileSearch.trim()) {
      toast.error("Enter an Instagram name to search.");
      return;
    }
    if (pendingMatches.length === 1) {
      selectProfile(pendingMatches[0].id);
      toast.success(`Selected ${pendingMatches[0].instaName}.`);
      return;
    }
    if (pendingMatches.length === 0) {
      toast.error("No pending Instagram profile matches that name.");
      return;
    }
    toast.message(`${pendingMatches.length} pending profiles match. Refine the Instagram name or select one below.`);
  }

  function updateNewProfile<K extends keyof NewProfile>(key: K, value: NewProfile[K]) {
    setNewProfile((current) => ({ ...current, [key]: value }));
  }

  function syncSheet() {
    if (!activeBrandId) {
      toast.error("Choose a brand with a connected Google Drive account before syncing.");
      return;
    }
    syncSheetMutation.mutate({ brandId: activeBrandId });
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 py-2">
      <div>
        <div className="flex items-center gap-2 text-primary"><UserRoundPlus className="h-5 w-5" /><span className="text-sm font-medium">Instagram account setup</span></div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Insta ID Creator</h1>
        <p className="mt-1 text-sm text-muted-foreground">Fill the details here, then let the local Chrome extension open and fill Instagram&apos;s sign-up page.</p>
      </div>

      <Card>
        <CardHeader className="gap-4 pb-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="text-base">Imported profile rows ({profiles.length})</CardTitle>
            <CardDescription>Password values remain masked. A Done row stays visible but cannot be selected for a new account.</CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
            <div className="w-full space-y-2 sm:w-96">
              <Label htmlFor="profile-search">Search Instagram name</Label>
              <div className="flex gap-2">
                <Input id="profile-search" value={profileSearch} onChange={(event) => setProfileSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); searchProfile(); } }} placeholder="e.g. Badalta_Moradabad" disabled={profilesQuery.isLoading} />
                <Button type="button" variant="outline" onClick={searchProfile} disabled={profilesQuery.isLoading}><Search className="mr-1.5 h-4 w-4" />Search</Button>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={syncSheet} disabled={syncSheetMutation.isPending || profilesQuery.isLoading}><RefreshCw className={syncSheetMutation.isPending ? "mr-1.5 h-4 w-4 animate-spin" : "mr-1.5 h-4 w-4"} />{syncSheetMutation.isPending ? "Syncing…" : "Sync to Google Sheet"}</Button>
            <Button type="button" variant="outline" onClick={() => setAddOpen(true)}><Plus className="mr-1.5 h-4 w-4" />Add profile</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 xl:hidden">
            {matchingProfiles.map((profile) => (
              <div key={profile.id} className="rounded-lg border p-4" data-state={profile.id === selectedProfileId ? "selected" : undefined}>
                <div className="flex items-start justify-between gap-3">
                  <div><p className="font-medium">{profile.instaName}</p><p className="text-sm text-muted-foreground">ID {profile.sourceRowNumber} · {profile.district || "No district"}</p></div>
                  {profile.status === "done" ? <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">Done</span> : <Button size="sm" className="bg-blue-600 text-white hover:bg-blue-700" onClick={() => selectProfile(profile.id)}>{profile.id === selectedProfileId ? "Selected" : "Select"}</Button>}
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-muted-foreground">Email</dt><dd className="break-all">{profile.email}</dd></div>
                  <div><dt className="text-muted-foreground">Password</dt><dd aria-label="Password protected">••••••••</dd></div>
                  <div><dt className="text-muted-foreground">Status</dt><dd className="mt-1"><Select value={profile.status} onValueChange={(status) => { if (status === "pending" || status === "done") statusMutation.mutate({ id: profile.id, status }); }} disabled={statusMutation.isPending}><SelectTrigger className={profile.status === "done" ? "h-8 w-28 border-emerald-200 bg-emerald-50 text-emerald-700" : "h-8 w-28 border-amber-200 bg-amber-50 text-amber-800"}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="done">Done</SelectItem></SelectContent></Select></dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="hidden max-h-[32rem] overflow-auto rounded-md border xl:block">
            <Table>
              <TableHeader className="sticky top-0 bg-background shadow-sm">
                <TableRow>
                  <TableHead>Choose</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>District</TableHead>
                  <TableHead>Instagram name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Password</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matchingProfiles.map((profile) => (
                  <TableRow key={profile.id} data-state={profile.id === selectedProfileId ? "selected" : undefined}>
                    <TableCell>
                      {profile.status === "done" ? (
                        <span className="inline-flex h-8 items-center rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">Done</span>
                      ) : (
                        <Button
                          size="sm"
                          className={profile.id === selectedProfileId ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/70"}
                          variant={profile.id === selectedProfileId ? "default" : "outline"}
                          onClick={() => selectProfile(profile.id)}
                        >
                          {profile.id === selectedProfileId ? "Selected" : "Select"}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>{profile.sourceRowNumber}</TableCell>
                    <TableCell>{profile.district || "—"}</TableCell>
                    <TableCell className="font-medium">{profile.instaName}</TableCell>
                    <TableCell>{profile.email}</TableCell>
                    <TableCell aria-label="Password protected">••••••••</TableCell>
                    <TableCell>
                      <Select
                        value={profile.status}
                        onValueChange={(status) => {
                          if (status === "pending" || status === "done") statusMutation.mutate({ id: profile.id, status });
                        }}
                        disabled={statusMutation.isPending}
                      >
                        <SelectTrigger className={profile.status === "done"
                          ? "h-8 w-28 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : "h-8 w-28 border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent><SelectItem value="pending">Pending</SelectItem><SelectItem value="done">Done</SelectItem></SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Instagram profile</DialogTitle>
            <DialogDescription>The new profile starts as Pending. Its password is encrypted locally and only used after you select this row for the Chrome fill action.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="new-district">District</Label><Input id="new-district" value={newProfile.district} onChange={(event) => updateNewProfile("district", event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="new-insta-name">Instagram name</Label><Input id="new-insta-name" value={newProfile.instaName} onChange={(event) => updateNewProfile("instaName", event.target.value)} required /></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="new-email">Email</Label><Input id="new-email" type="email" value={newProfile.email} onChange={(event) => updateNewProfile("email", event.target.value)} required /></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="new-password">Password</Label><Input id="new-password" type="password" value={newProfile.password} onChange={(event) => updateNewProfile("password", event.target.value)} required /></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="button" onClick={() => createMutation.mutate(newProfile)} disabled={createMutation.isPending || !newProfile.instaName || !newProfile.email || !newProfile.password}>{createMutation.isPending ? "Adding…" : "Add profile"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={otpOpen} onOpenChange={setOtpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{otpResult === "success" ? "Verification submitted" : "Enter Instagram OTP"}</DialogTitle>
            <DialogDescription>
              {otpResult === "success"
                ? "Instagram received the verification code. Confirm the account is created in Chrome, then change this profile's status to Done yourself."
                : "Enter the code Instagram sent to your email or phone. MediaHub never reads your inbox or receives the code automatically."}
            </DialogDescription>
          </DialogHeader>
          {otpResult === "success" ? (
            <DialogFooter><Button type="button" onClick={() => setOtpOpen(false)}>Complete</Button></DialogFooter>
          ) : (
            <form onSubmit={submitOtp} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="instagram-otp">Verification code</Label><Input id="instagram-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} required /></div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOtpOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={otpSubmitting || !otp.trim()}>{otpSubmitting ? "Verifying…" : "Verify OTP"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <form onSubmit={fillInChrome} className="space-y-5">
        <Card>
          <CardContent className="grid gap-5 p-6 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="creator-email">Mobile number or email address</Label><div className="relative"><Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="creator-email" className="pl-9" type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} required /></div></div>
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="creator-password">Password</Label><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="creator-password" className="pl-9" type="password" autoComplete="new-password" value={form.password} onChange={(event) => update("password", event.target.value)} required /></div></div>
            <div className="space-y-2 sm:col-span-2"><Label>Date of birth</Label><div className="grid grid-cols-3 gap-3"><Select value={form.day} onValueChange={(value) => update("day", value ?? "")} required><SelectTrigger aria-label="Day"><SelectValue placeholder="Day" /></SelectTrigger><SelectContent>{Array.from({ length: 31 }, (_, index) => String(index + 1)).map((day) => <SelectItem key={day} value={day}>{day}</SelectItem>)}</SelectContent></Select><Select value={form.month} onValueChange={(value) => update("month", value ?? "")} required><SelectTrigger aria-label="Month"><SelectValue placeholder="Month" /></SelectTrigger><SelectContent>{months.map((month, index) => <SelectItem key={month} value={String(index + 1)}>{month}</SelectItem>)}</SelectContent></Select><Select value={form.year} onValueChange={(value) => update("year", value ?? "")} required><SelectTrigger aria-label="Year"><SelectValue placeholder="Year" /></SelectTrigger><SelectContent>{Array.from({ length: 100 }, (_, index) => String(new Date().getFullYear() - 13 - index)).map((year) => <SelectItem key={year} value={year}>{year}</SelectItem>)}</SelectContent></Select></div></div>
            <div className="space-y-2"><Label htmlFor="creator-name">Full name</Label><div className="relative"><UserRound className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input id="creator-name" className="pl-9" autoComplete="name" value={form.fullName} onChange={(event) => update("fullName", event.target.value)} required /></div></div>
            <div className="space-y-2"><Label htmlFor="creator-username">Username</Label><Input id="creator-username" autoComplete="username" value={form.username} onChange={(event) => update("username", event.target.value)} required /></div>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground"><CalendarDays className="h-4 w-4" /> One click opens Instagram and fills this selected profile. Review and submit the Instagram form yourself.</span>
          <Button type="submit" disabled={!complete || submitting}>{submitting ? "Opening Instagram…" : "Open & fill Instagram"}</Button>
        </div>
      </form>
    </div>
  );
}
