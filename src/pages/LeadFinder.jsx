import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Search, Globe, Phone, Mail, Star, MapPin, XCircle, Building2, Download, CheckCircle2, Sparkles, Copy } from 'lucide-react';
import { toast } from 'sonner';

// Everything on this page runs on Base44 CORE integrations (InvokeLLM) and
// entity CRUD — no backend functions, no secrets, no external accounts. That
// is deliberate: core integrations work on EVERY Base44 plan.

const MAX_LEADS_PER_SEARCH = 25;

// Stable dedup key for AI-found leads (no Google place_id here): the
// normalized business name + city. Good enough to stop the same shop being
// inserted twice across repeat searches.
function leadKey(name, city) {
  return `${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}__${String(city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export default function LeadFinder() {
  const [niche, setNiche] = useState('');
  const [city, setCity] = useState('');
  const [maxResults, setMaxResults] = useState(15);
  const [filterNiche, setFilterNiche] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const queryClient = useQueryClient();

  const [findStatus, setFindStatus] = useState(null); // null | 'running' | 'complete' | 'failed'
  const [findError, setFindError] = useState(null);
  const [findResults, setFindResults] = useState(null); // { inserted, skipped }

  // Outreach writer state
  const [outreachLead, setOutreachLead] = useState(null); // prospect being written for
  const [outreachText, setOutreachText] = useState('');
  const [outreachLoading, setOutreachLoading] = useState(false);

  const { data: prospects = [] } = useQuery({
    queryKey: ['prospects'],
    queryFn: () => base44.entities.Prospect.list('-scraped_at', 5000),
  });

  const handleFind = async () => {
    if (!niche.trim() || !city.trim()) return;
    setFindStatus('running');
    setFindError(null);
    setFindResults(null);
    try {
      const want = Math.min(Math.max(Number(maxResults) || 15, 1), MAX_LEADS_PER_SEARCH);
      const res = await base44.integrations.Core.InvokeLLM({
        prompt: [
          `Find ${want} real, currently-operating local businesses in the "${niche.trim()}" niche in ${city.trim()}.`,
          `Use web search to find actual businesses — real names, real phone numbers, real websites. Do not invent businesses.`,
          `Prefer small and mid-sized local businesses (the kind that buy marketing services), not national chains.`,
          `For each business return: name, phone (with country code if visible), website URL (empty string if none found), street address, and if visible a Google rating (number) and review count (number).`,
          `Only include a business if you found at least a name and a phone number or website.`,
        ].join('\n'),
        add_context_from_internet: true,
        response_json_schema: {
          type: 'object',
          properties: {
            businesses: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  phone: { type: 'string' },
                  website: { type: 'string' },
                  address: { type: 'string' },
                  rating: { type: 'number' },
                  review_count: { type: 'number' },
                },
                required: ['name'],
              },
            },
          },
          required: ['businesses'],
        },
      });

      const found = Array.isArray(res?.businesses) ? res.businesses : [];
      const existingKeys = new Set(prospects.map((p) => p.place_id));
      const nowIso = new Date().toISOString();
      const rows = [];
      let skipped = 0;
      for (const b of found) {
        if (!b?.name) { skipped++; continue; }
        const key = `ai-${leadKey(b.name, city.trim())}`;
        if (existingKeys.has(key)) { skipped++; continue; }
        existingKeys.add(key);
        rows.push({
          place_id: key,
          name: b.name,
          phone: b.phone || '',
          email: '',
          website: b.website || '',
          address: b.address || '',
          rating: typeof b.rating === 'number' ? b.rating : null,
          review_count: typeof b.review_count === 'number' ? b.review_count : null,
          has_website: !!(b.website && b.website.trim()),
          niche: niche.trim(),
          city: city.trim(),
          scraped_at: nowIso,
          qualified: false,
        });
      }
      if (rows.length > 0) await base44.entities.Prospect.bulkCreate(rows);
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
      setFindResults({ inserted: rows.length, skipped });
      setFindStatus('complete');
      toast.success(`Search complete! ${rows.length} leads added.`);
    } catch (e) {
      setFindError(e.message);
      setFindStatus('failed');
      toast.error(`Search failed: ${e.message}`);
    }
  };

  // Write (or rewrite) a personalized first-touch message for one lead.
  const handleWriteOutreach = async (p) => {
    setOutreachLead(p);
    setOutreachText(p.outreach_message || '');
    if (p.outreach_message) return; // already written — open for editing/copy
    setOutreachLoading(true);
    try {
      const res = await base44.integrations.Core.InvokeLLM({
        prompt: [
          `Write a short, personalized cold outreach message to this local business:`,
          `Business: ${p.name}`,
          `Niche: ${p.niche || 'local business'}`,
          `City: ${p.city || ''}`,
          p.website ? `Website: ${p.website}` : `They appear to have no website.`,
          p.rating != null ? `Google rating: ${p.rating} (${p.review_count || 0} reviews)` : '',
          ``,
          `The sender runs a small local marketing agency and wants to open a conversation, not hard-sell.`,
          `Rules: max 4 sentences. Mention ONE specific thing about their business (their reviews, their site, or the fact they have no site). Plain language, no buzzwords, no exclamation marks, no "I hope this finds you well". End with a low-pressure question. Do not use em dashes. Return ONLY the message text.`,
        ].filter(Boolean).join('\n'),
        response_json_schema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      });
      const msg = (res?.message || '').trim();
      setOutreachText(msg);
      if (msg) {
        await base44.entities.Prospect.update(p.id, { outreach_message: msg });
        queryClient.invalidateQueries({ queryKey: ['prospects'] });
      }
    } catch (e) {
      toast.error(`Couldn't write outreach: ${e.message}`);
    } finally {
      setOutreachLoading(false);
    }
  };

  const saveOutreachEdit = async () => {
    if (!outreachLead) return;
    try {
      await base44.entities.Prospect.update(outreachLead.id, { outreach_message: outreachText });
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
      toast.success('Outreach saved.');
    } catch (e) {
      toast.error(`Couldn't save: ${e.message}`);
    }
  };

  const copyOutreach = async () => {
    try {
      await navigator.clipboard.writeText(outreachText);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Copy failed — select the text and copy manually.');
    }
  };

  const isFinding = findStatus === 'running';
  const location = useLocation();
  const navLinks = [
    { to: '/', label: 'AI Lead Finder', icon: <Sparkles className="w-4 h-4" /> },
  ];

  const niches = Array.from(new Set(prospects.map(p => p.niche).filter(Boolean))).sort();
  const filtered = filterNiche
    ? prospects.filter(p => p.niche === filterNiche)
    : prospects;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const displayed = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function toggleQualified(p) {
    try {
      await base44.entities.Prospect.update(p.id, { qualified: !p.qualified });
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
    } catch (e) {
      toast.error(`Couldn't update lead: ${e.message}`);
    }
  }

  const exportCSV = (rows, filename) => {
    const headers = ['Name', 'Phone', 'Email', 'Website', 'Address', 'Rating', 'Reviews', 'Niche', 'City', 'Has Website', 'Qualified'];
    const lines = [headers.join(','), ...rows.map(p => [
      `"${(p.name || '').replace(/"/g, '""')}"`,
      `"${p.phone || ''}"`,
      `"${p.email || ''}"`,
      `"${p.website || ''}"`,
      `"${(p.address || '').replace(/"/g, '""')}"`,
      p.rating ?? '',
      p.review_count ?? '',
      `"${p.niche || ''}"`,
      `"${p.city || ''}"`,
      p.has_website ? 'Yes' : 'No',
      p.qualified ? 'Yes' : 'No',
    ].join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen" style={{ background: '#070d1a' }}>

      {/* Top Nav */}
      <nav style={{ background: '#0d1526', borderBottom: '1px solid #1e2d4a' }} className="px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: '#ea580c' }}>
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="text-white font-bold text-lg">AI Lead Finder</span>
        </div>
        <div className="flex items-center gap-1">
          {navLinks.map(l => (
            <Link
              key={l.to}
              to={l.to}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                location.pathname === l.to
                  ? 'text-white'
                  : 'text-gray-400 hover:text-white hover:bg-white/10'
              }`}
              style={location.pathname === l.to ? { background: 'rgba(234,88,12,0.25)', color: '#fb923c' } : {}}
            >
              {l.icon}{l.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6 space-y-6">

        {/* Hero Search Card */}
        <div
          className="rounded-2xl p-8 text-center relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg, #1a0a02 0%, #2d1206 50%, #1a0a02 100%)', border: '1px solid #7c2d12' }}
        >
          <div className="absolute top-4 left-8 w-24 h-24 rounded-full opacity-10" style={{ background: '#ea580c', filter: 'blur(20px)' }} />
          <div className="absolute bottom-4 right-12 w-32 h-32 rounded-full opacity-10" style={{ background: '#f97316', filter: 'blur(24px)' }} />

          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium mb-4" style={{ background: 'rgba(234,88,12,0.2)', color: '#fb923c', border: '1px solid rgba(234,88,12,0.3)' }}>
              ✦ AI-Powered Business Search
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Find your next clients</h1>
            <p className="mb-6" style={{ color: '#94a3b8' }}>Type an industry and a city. AI searches the web and drops real businesses into your table.</p>

            <div className="flex flex-col sm:flex-row gap-3 max-w-2xl mx-auto">
              <div className="flex-1 flex items-center gap-2 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #7c2d12' }}>
                <Building2 className="w-4 h-4 shrink-0" style={{ color: '#fb923c' }} />
                <input
                  className="bg-transparent flex-1 outline-none text-sm text-white placeholder-slate-500"
                  placeholder="Industry (e.g. Plumbing, Dental…)"
                  value={niche}
                  onChange={e => setNiche(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleFind()}
                />
              </div>
              <div className="flex-1 flex items-center gap-2 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #7c2d12' }}>
                <MapPin className="w-4 h-4 shrink-0" style={{ color: '#fb923c' }} />
                <input
                  className="bg-transparent flex-1 outline-none text-sm text-white placeholder-slate-500"
                  placeholder="Location (e.g. Miami, FL)"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleFind()}
                />
              </div>
              <div className="flex items-center gap-2 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #7c2d12', minWidth: '90px' }}>
                <input
                  type="number"
                  min={1}
                  max={MAX_LEADS_PER_SEARCH}
                  className="bg-transparent w-full outline-none text-sm text-white placeholder-slate-500 text-center"
                  placeholder="Max"
                  value={maxResults}
                  onChange={e => setMaxResults(e.target.value)}
                />
              </div>
              <button
                onClick={handleFind}
                disabled={isFinding || !niche.trim() || !city.trim()}
                className="flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: isFinding ? '#c2410c' : '#ea580c' }}
              >
                {isFinding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                {isFinding ? 'Searching…' : 'Find Leads'}
              </button>
            </div>
          </div>
        </div>

        {/* Status Banner */}
        {findStatus && (
          <div className={`rounded-xl px-5 py-4 text-sm flex items-start gap-3 ${
            findStatus === 'failed'   ? 'bg-red-950 border border-red-800 text-red-300' :
            findStatus === 'complete' ? 'bg-emerald-950 border border-emerald-800 text-emerald-300' :
            'border text-orange-300'
          }`} style={findStatus === 'running' ? { background: 'rgba(234,88,12,0.1)', borderColor: 'rgba(234,88,12,0.3)' } : {}}>
            {findStatus === 'running' && <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0" />}
            {findStatus === 'complete' && findResults && (
              <div>
                <strong>{findResults.inserted}</strong> leads added · <strong>{findResults.skipped}</strong> skipped (duplicates)
              </div>
            )}
            {findStatus === 'running' && <span>AI is searching the web for businesses — usually 20-60 seconds…</span>}
            {findStatus === 'failed' && <span className="flex items-center gap-2"><XCircle className="w-4 h-4 shrink-0" /> Error: {findError}</span>}
          </div>
        )}

        {/* Prospects Table */}
        <div className="rounded-2xl overflow-hidden" style={{ background: '#0d1526', border: '1px solid #1e2d4a' }}>
          <div className="flex items-center justify-between px-5 py-4 gap-3" style={{ borderBottom: '1px solid #1e2d4a' }}>
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <h2 className="text-white font-semibold shrink-0">Prospects</h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold shrink-0" style={{ background: 'rgba(234,88,12,0.2)', color: '#fb923c', border: '1px solid rgba(234,88,12,0.3)' }}>
                {filtered.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => { setFilterNiche(''); setPage(1); }}
                  className="px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors"
                  style={
                    filterNiche === ''
                      ? { background: 'rgba(234,88,12,0.25)', color: '#fb923c', border: '1px solid rgba(234,88,12,0.5)' }
                      : { background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid #1e2d4a' }
                  }
                >
                  All
                </button>
                {niches.map(n => (
                  <button
                    key={n}
                    onClick={() => { setFilterNiche(n); setPage(1); }}
                    className="px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors"
                    style={
                      filterNiche === n
                        ? { background: 'rgba(234,88,12,0.25)', color: '#fb923c', border: '1px solid rgba(234,88,12,0.5)' }
                        : { background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid #1e2d4a' }
                    }
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => exportCSV(displayed, `leads-page${page}.csv`)}
                disabled={displayed.length === 0}
                title="Export this page to CSV"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                style={{ background: 'rgba(234,88,12,0.2)', border: '1px solid rgba(234,88,12,0.4)', color: '#fb923c' }}
              >
                <Download className="w-3.5 h-3.5" /> Export CSV
              </button>
              <button
                onClick={() => exportCSV(filtered, `leads-all.csv`)}
                disabled={filtered.length === 0}
                title="Export ALL leads to CSV"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', color: '#34d399' }}
              >
                <Download className="w-3.5 h-3.5" /> Export All
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', color: '#4a6fa5' }} className="text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-3 w-10">
                    <CheckCircle2 className="w-3.5 h-3.5 inline" />
                  </th>
                  <th className="text-left px-5 py-3">Business</th>
                  <th className="text-left px-5 py-3">Contact</th>
                  <th className="text-left px-5 py-3">Address</th>
                  <th className="text-left px-5 py-3">Rating</th>
                  <th className="text-left px-5 py-3">Niche / City</th>
                  <th className="text-left px-5 py-3">Website</th>
                  <th className="text-left px-5 py-3">Outreach</th>
                </tr>
              </thead>
              <tbody>
                {displayed.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-12 text-center" style={{ color: '#4a6fa5' }}>
                      No prospects yet. Run a search above.
                    </td>
                  </tr>
                )}
                {displayed.map((p) => (
                  <tr
                    key={p.id}
                    style={{
                      borderTop: '1px solid #1a2640',
                      background: p.qualified ? 'rgba(34, 197, 94, 0.06)' : undefined,
                    }}
                    className="hover:bg-white/5 transition-colors"
                  >
                    <td className="px-5 py-3 align-middle">
                      <input
                        type="checkbox"
                        checked={!!p.qualified}
                        onChange={() => toggleQualified(p)}
                        title={p.qualified ? "Mark as not yet contacted" : "Mark as already contacted"}
                        className="w-4 h-4 rounded cursor-pointer accent-orange-500"
                      />
                    </td>
                    <td className="px-5 py-3 font-medium text-white max-w-[180px] truncate">{p.name}</td>
                    <td className="px-5 py-3" style={{ color: '#94a3b8' }}>
                      <div className="flex flex-col gap-0.5">
                        {p.phone && <span className="flex items-center gap-1.5"><Phone className="w-3 h-3" style={{ color: '#f97316' }} />{p.phone}</span>}
                        {p.email && <span className="flex items-center gap-1.5"><Mail className="w-3 h-3" style={{ color: '#f97316' }} />{p.email}</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3 max-w-[200px]" style={{ color: '#64748b' }}>
                      {p.address && <span className="flex items-start gap-1.5"><MapPin className="w-3 h-3 mt-0.5 shrink-0" style={{ color: '#f97316' }} />{p.address}</span>}
                    </td>
                    <td className="px-5 py-3">
                      {p.rating != null && (
                        <span className="flex items-center gap-1 font-medium" style={{ color: '#fbbf24' }}>
                          <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                          {p.rating} <span className="font-normal" style={{ color: '#4a6fa5' }}>({p.review_count})</span>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-white">{p.niche}</span>
                        <span className="text-xs" style={{ color: '#4a6fa5' }}>{p.city}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {p.has_website ? (
                        <a href={p.website} target="_blank" rel="noopener noreferrer"
                           className="flex items-center gap-1.5 hover:underline" style={{ color: '#f97316' }}>
                          <Globe className="w-3 h-3" /> Visit
                        </a>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs" style={{ background: 'rgba(255,255,255,0.05)', color: '#4a6fa5', border: '1px solid #1e2d4a' }}>No site</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <button
                        onClick={() => handleWriteOutreach(p)}
                        title={p.outreach_message ? "View / edit outreach message" : "Write outreach with AI"}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
                        style={p.outreach_message
                          ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', color: '#34d399' }
                          : { background: 'rgba(234,88,12,0.2)', border: '1px solid rgba(234,88,12,0.4)', color: '#fb923c' }}
                      >
                        <Sparkles className="w-3 h-3" />
                        {p.outreach_message ? 'View' : 'Write'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid #1e2d4a' }}>
              <span className="text-sm" style={{ color: '#4a6fa5' }}>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 text-sm rounded-lg transition-colors disabled:opacity-30"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #7c2d12', color: '#94a3b8' }}
                >Prev</button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 text-sm rounded-lg transition-colors disabled:opacity-30"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #7c2d12', color: '#94a3b8' }}
                >Next</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Outreach dialog */}
      <Dialog open={!!outreachLead} onOpenChange={(open) => { if (!open) setOutreachLead(null); }}>
        <DialogContent className="sm:max-w-lg" style={{ background: '#0d1526', border: '1px solid #1e2d4a', color: 'white' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" style={{ color: '#fb923c' }} />
              Outreach for {outreachLead?.name}
            </DialogTitle>
          </DialogHeader>
          {outreachLoading ? (
            <div className="flex items-center gap-3 py-8 justify-center" style={{ color: '#94a3b8' }}>
              <Loader2 className="w-5 h-5 animate-spin" />
              AI is writing a personalized message…
            </div>
          ) : (
            <>
              <textarea
                value={outreachText}
                onChange={(e) => setOutreachText(e.target.value)}
                rows={6}
                className="w-full rounded-xl p-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2d4a', color: 'white' }}
              />
              <p className="text-xs" style={{ color: '#4a6fa5' }}>
                Read it, tweak one line to make it yours, then copy and send. Edits save to this lead.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={saveOutreachEdit}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2d4a', color: '#94a3b8' }}
                >
                  Save
                </button>
                <button
                  onClick={copyOutreach}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
                  style={{ background: '#ea580c' }}
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
