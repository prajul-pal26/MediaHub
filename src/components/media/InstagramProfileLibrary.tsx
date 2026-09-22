"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";

/** Reusable local Instagram workspaces, equivalent to Facebook's saved profile panel. */
export function InstagramProfileLibrary({
  authed,
  selectedUsername,
  disabled,
  onSelect,
}: {
  authed: boolean;
  selectedUsername: string;
  disabled: boolean;
  onSelect: (username: string) => void;
}) {
  const [search, setSearch] = useState("");
  const query = trpc.instaComments.savedProfiles.useQuery(
    { limit: 250 },
    { enabled: authed, refetchOnWindowFocus: false, retry: false },
  );
  const rows = useMemo(
    () => (query.data ?? []).filter((row) => row.username.includes(search.trim().toLowerCase())),
    [query.data, search],
  );

  return (
    <aside className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm" aria-label="Saved Instagram profiles">
      <div className="space-y-2 border-b border-zinc-100 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Saved Instagram profiles</h2>
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">{query.data?.length ?? 0}</span>
        </div>
        <p className="text-xs text-zinc-500">Profiles appear here as soon as their post and Reel links are saved locally.</p>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search saved Instagram profiles"
          placeholder="Search Instagram profile"
          className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm"
        />
      </div>
      {!authed ? <p className="p-4 text-sm">Enter Studio to view saved profiles.</p>
        : query.isLoading ? <p role="status" className="p-4 text-sm">Loading saved profiles…</p>
          : query.error ? <div role="alert" className="p-4 text-sm"><p>{query.error.message}</p><button type="button" onClick={() => query.refetch()} className="mt-2 text-indigo-600 underline">Retry list</button></div>
            : <div className="max-h-80 overflow-auto">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 bg-zinc-50 text-zinc-600"><tr><th className="w-[28%] p-2 font-semibold">Profile</th><th className="w-[15%] p-2 font-semibold">Links</th><th className="w-[17%] p-2 font-semibold">Posts / Reels</th><th className="w-[18%] p-2 font-semibold">Comments</th><th className="w-[22%] p-2 font-semibold">Workspace</th></tr></thead>
                <tbody>{rows.map((row) => <tr key={row.username} className={row.username === selectedUsername ? "bg-indigo-50" : "border-t border-zinc-100"}>
                  <td className="p-2 align-top"><button type="button" disabled={disabled} onClick={() => onSelect(row.username)} className="break-all text-left font-medium text-indigo-700 hover:underline disabled:cursor-default">@{row.username}</button></td>
                  <td className="p-2 align-top tabular-nums">{row.mediaCount}</td>
                  <td className="p-2 align-top tabular-nums">{row.postCount} / {row.reelCount}</td>
                  <td className="p-2 align-top tabular-nums">{row.scrapedComments} / {row.reportedComments}</td>
                  <td className="p-2 align-top"><span className="block capitalize">{row.latestRunStatus ?? "links saved"}</span><span className={row.driveSyncedAt ? "text-emerald-700" : "text-zinc-400"}>{row.driveSyncedAt ? "Drive synced" : "Local workspace"}</span></td>
                </tr>)}</tbody>
              </table>
              {!rows.length && <p className="p-4 text-sm text-zinc-500">No saved Instagram links yet. Run a profile link discovery first.</p>}
            </div>}
    </aside>
  );
}
