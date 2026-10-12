'use client';

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc/client';

export function FacebookProfileLibrary({brandId, authed, selectedUrl, disabled, onSelect, onUpdate}: {
  brandId: string; authed: boolean; selectedUrl: string; disabled: boolean; onSelect: (url:string)=>void; onUpdate: (urls: string[])=>void;
}) {
  const [search,setSearch]=useState(''); const [selected,setSelected]=useState<string[]>([]);
  const query=trpc.fbProfileLibrary.list.useQuery({brandId},{enabled:authed&&!!brandId,refetchOnWindowFocus:false,retry:false});
  const rows=useMemo(()=>query.data?.profiles.filter(p=>`${p.name} ${p.facebookProfile}`.toLowerCase().includes(search.toLowerCase()))??[],[query.data,search]);
  return <aside className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm" aria-label="MLA Facebook profiles">
    <div className="border-b border-zinc-100 p-4 space-y-2">
      <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">MLA</h2><button type="button" disabled={disabled || !selected.length} onClick={()=>onUpdate(selected)} className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-40">Update selected ({selected.length})</button></div>
      <input value={search} onChange={e=>setSearch(e.target.value)} aria-label="Search MLA profiles" placeholder="Search name or Facebook profile" className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" />
      {disabled && <p className="text-xs text-amber-700">Wait for the current fetch and save to finish before changing profile.</p>}
    </div>
    {!authed ? <p className="p-4 text-sm">Enter Studio to view the profile list.</p> : !brandId ? <p className="p-4 text-sm">Choose a connected Google Drive brand to view profiles.</p> : query.isLoading ? <p role="status" className="p-4 text-sm">Loading profiles…</p> : query.error ? <div role="alert" className="p-4 text-sm"><p>{query.error.message}</p><button type="button" onClick={()=>query.refetch()} className="mt-2 text-indigo-600 underline">Retry list</button></div> :
      <div className="min-h-64 flex-1 overflow-y-auto overflow-x-hidden">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="sticky top-0 bg-zinc-50 text-zinc-600"><tr><th className="w-7 p-2"><input aria-label="Select all visible MLAs" type="checkbox" checked={!!rows.length && rows.filter(p=>p.url).every(p=>selected.includes(p.url!))} onChange={e=>setSelected(e.target.checked ? [...new Set([...selected,...rows.flatMap(p=>p.url?[p.url]:[])])] : selected.filter(url=>!rows.some(p=>p.url===url)))} /></th><th className="w-[25%] p-2 font-semibold">MLA name</th><th className="w-[31%] p-2 font-semibold">Facebook profile</th><th className="w-[9%] p-2 font-semibold">Posts</th><th className="w-[9%] p-2 font-semibold">Reels</th><th className="w-[17%] p-2 font-semibold">Update</th></tr></thead>
          <tbody>{rows.map(p=><tr key={p.row} className={p.url===selectedUrl?'bg-indigo-50':'border-t border-zinc-100'}>
            <td className="p-2 align-top">{p.url&&<input aria-label={`Select ${p.name}`} type="checkbox" checked={selected.includes(p.url)} onChange={e=>setSelected(current=>e.target.checked?[...new Set([...current,p.url!])]:current.filter(url=>url!==p.url))}/>}</td>
            <td className="p-2 align-top"><button type="button" disabled={disabled||!p.url} onClick={()=>p.url&&onSelect(p.url)} className="text-left font-medium text-zinc-900 hover:text-indigo-600 disabled:cursor-default" aria-label={`Load saved data for ${p.name}`}>{p.name || 'Unnamed MLA'}</button></td>
            <td className="min-w-0 p-2 align-top">{p.url?<button type="button" disabled={disabled} onClick={()=>onSelect(p.url!)} className="block w-full min-w-0 break-all text-left text-indigo-600 hover:underline disabled:cursor-default">{p.facebookProfile}</button>:<span className="block break-all text-zinc-400">{p.facebookProfile || 'No Facebook profile'}</span>}</td><td className="p-2 align-top tabular-nums">{p.photosCount}</td><td className="p-2 align-top tabular-nums">{p.reelsCount}</td><td className="p-2 align-top">{p.url&&<button type="button" disabled={disabled} onClick={()=>onUpdate([p.url!])} className="rounded bg-indigo-50 px-2 py-1 text-indigo-700 disabled:opacity-40">Update</button>}</td>
          </tr>)}</tbody>
        </table>
        {!rows.length&&<p className="p-4 text-sm text-zinc-500">{query.data?.profiles.length?'No matching profiles.':'No profile list has been imported for this brand.'}</p>}
      </div>}
  </aside>;
}
