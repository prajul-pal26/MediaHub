'use client';
import {useState} from 'react';
import {trpc} from '@/lib/trpc/client';
export function FacebookCustomProfiles({brandId,authed,disabled,selectedUrl,onSelect}:{brandId:string;authed:boolean;disabled:boolean;selectedUrl:string;onSelect:(url:string)=>void}) {
 const [name,setName]=useState('');const [url,setUrl]=useState('');const [search,setSearch]=useState('');
 const utils=trpc.useUtils();
 const query=trpc.fbProfileLibrary.custom.useQuery({brandId},{enabled:authed&&!!brandId,retry:false});
 const add=trpc.fbProfileLibrary.add.useMutation({onSuccess:()=>{setName('');setUrl('');void utils.fbProfileLibrary.custom.invalidate({brandId});}});
 return <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
  <div className="space-y-3 border-b border-zinc-100 p-4"><h2 className="text-lg font-semibold">Instagram users</h2>
   <input aria-label="Search added profiles" placeholder="Search name or Facebook profile" value={search} onChange={e=>setSearch(e.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm"/>
   <form onSubmit={e=>{e.preventDefault();add.mutate({brandId,name,profileUrl:url});}} className="flex gap-2">
    <input aria-label="New profile name" placeholder="Name" required maxLength={200} value={name} onChange={e=>setName(e.target.value)} className="min-w-0 w-1/3 rounded-lg border px-3 py-2 text-sm"/>
    <input aria-label="New Facebook profile" placeholder="Facebook profile URL" required value={url} onChange={e=>setUrl(e.target.value)} className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"/>
    <button disabled={!authed||!brandId||disabled||add.isPending} className="rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white disabled:opacity-40">Add</button>
   </form>{add.error&&<p role="alert" className="text-sm text-red-600">{add.error.message}</p>}
  </div>
  <div className="min-h-64 flex-1 overflow-y-auto"><table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 bg-zinc-50"><tr><th className="w-[44%] p-3">Name</th><th className="p-3">Facebook profile</th></tr></thead><tbody>
  {query.data?.filter(p=>`${p.name} ${p.url}`.toLowerCase().includes(search.toLowerCase())).map(p=><tr key={p.url} className={p.url===selectedUrl?'bg-indigo-50':'border-t border-zinc-100'}><td className="p-3 align-top"><button disabled={disabled} onClick={()=>onSelect(p.url)} className="text-left font-medium">{p.name}</button></td><td className="p-3 align-top"><button disabled={disabled} onClick={()=>onSelect(p.url)} className="block w-full break-all text-left text-indigo-600">{p.url}</button></td></tr>)}
  </tbody></table>{query.isLoading?<p className="p-4 text-sm">Loading profiles…</p>:query.error?<p role="alert" className="p-4 text-sm text-red-600">{query.error.message}</p>:!query.data?.length&&<p className="p-4 text-sm text-zinc-500">Add a profile above, or fetch its posts or reels below to save it here.</p>}</div>
 </section>;
}
