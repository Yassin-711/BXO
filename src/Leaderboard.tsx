import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, CalendarDays, Crown, Flame, Loader2, Medal, RefreshCw, Shield, Sparkles, Trophy, Users, Zap } from 'lucide-react';
import Brand from './Brand';
import ThemeToggle from './ThemeToggle';

type Role = 'lcvp' | 'middle_manager' | 'member';
type Person = { id: number; username: string; role?: Role; isActive: boolean; uploads: number; lastUploadAt: string | null };
type Team = { id: number; teamName: string; managerUsername: string; isActive: boolean; uploads: number; lastUploadAt: string | null };
type TeamMember = Person & { teamId: number; teamName: string };
type LeaderboardData = { people: Person[]; teams: Team[]; teamMembers: TeamMember[]; range: { from: string; to: string } | null };

const medals = ['from-amber-300 via-yellow-500 to-orange-500', 'from-slate-200 via-slate-400 to-slate-500', 'from-orange-300 via-amber-600 to-orange-800'];
const glows = ['shadow-amber-400/25', 'shadow-cyan-400/20', 'shadow-fuchsia-500/20'];
const roleLabels: Record<Role, string> = { lcvp: 'LCVP', middle_manager: 'Middle Manager', member: 'Member' };

async function getData(from?: string, to?: string): Promise<LeaderboardData> {
  const query = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';
  const response = await fetch(`/api/leaderboards${query}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to load leaderboard');
  return data;
}

function Podium({ rows, label, subtitle }: { rows: Array<Person | Team>; label: (row: Person | Team) => string; subtitle?: (row: Person | Team) => string | null }) {
  return <div className="grid sm:grid-cols-3 gap-3 mb-7">
    {rows.slice(0, 3).map((row, index) => <motion.div key={row.id} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .08 }} className={`relative overflow-hidden rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl ${glows[index]}`}>
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${medals[index]}`} />
      <div className="flex items-center justify-between"><div className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${medals[index]} text-slate-950 flex items-center justify-center shadow-lg`}><Medal className="w-6 h-6" /></div><span className="text-4xl font-black text-white/10">#{index + 1}</span></div>
      <h3 className="mt-5 truncate text-lg font-black text-white">{label(row)}</h3>
      {subtitle?.(row) && <p className="mt-1 truncate text-xs font-semibold text-violet-300">{subtitle(row)}</p>}
      <div className="mt-2 flex items-end gap-2"><strong className="text-4xl font-black text-white">{row.uploads}</strong><span className="pb-1 text-xs uppercase tracking-[.18em] text-cyan-300">uploads</span></div>
    </motion.div>)}
  </div>;
}

function RankTable({ rows, label, subtitle, showRole = false }: { rows: Array<Person | Team>; label: (row: Person | Team) => string; subtitle?: (row: Person | Team) => string | null; showRole?: boolean }) {
  return <div className="overflow-x-auto rounded-3xl border border-white/10 bg-slate-950/55 backdrop-blur-xl">
    <table className="w-full min-w-[650px] text-left"><thead><tr className="text-[11px] uppercase tracking-[.18em] text-slate-500"><th className="px-5 py-4">Rank</th><th className="px-5 py-4">Competitor</th>{showRole && <th className="px-5 py-4">Role</th>}<th className="px-5 py-4">Uploads</th><th className="px-5 py-4">Last upload</th><th className="px-5 py-4">Status</th></tr></thead>
      <tbody className="divide-y divide-white/5">{rows.map((row, index) => <tr key={`${row.id}-${index}`} className="group hover:bg-indigo-500/5 transition-colors"><td className="px-5 py-4"><span className={`inline-flex w-9 h-9 items-center justify-center rounded-xl font-black ${index < 3 ? `bg-gradient-to-br ${medals[index]} text-slate-950` : 'bg-white/5 text-slate-400'}`}>{index + 1}</span></td><td className="px-5 py-4"><div className="font-bold text-white">{label(row)}</div>{subtitle?.(row) && <div className="text-xs text-slate-500">{subtitle(row)}</div>}</td>{showRole && <td className="px-5 py-4 text-sm text-violet-300">{roleLabels[(row as Person).role!]}</td>}<td className="px-5 py-4"><span className="inline-flex items-center gap-2 font-black text-cyan-300"><Zap className="w-4 h-4" />{row.uploads}</span></td><td className="px-5 py-4 text-sm text-slate-400">{row.lastUploadAt ? new Date(row.lastUploadAt).toLocaleString() : 'No uploads yet'}</td><td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${row.isActive ? 'bg-emerald-400/10 text-emerald-300' : 'bg-slate-500/10 text-slate-500'}`}>{row.isActive ? 'Active' : 'Disabled'}</span></td></tr>)}</tbody>
    </table>
  </div>;
}

export default function Leaderboard({ user, onBack }: { user: { role: Role }; onBack: () => void }) {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [tab, setTab] = useState<'function' | 'teams' | 'members'>('function');
  const [teamId, setTeamId] = useState<number | null>(null);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');

  async function load(rangeFrom?: string, rangeTo?: string) { setLoading(true); setError(''); try { const result = await getData(rangeFrom, rangeTo); setData(result); setTeamId((current) => current ?? result.teams[0]?.id ?? null); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load leaderboard'); } finally { setLoading(false); } }
  useEffect(() => { void load(); }, []);
  const memberRows = useMemo(() => data?.teamMembers.filter((row) => row.teamId === teamId) ?? [], [data, teamId]);
  const activeRows: Array<Person | Team> = tab === 'function' ? data?.people ?? [] : tab === 'teams' ? data?.teams ?? [] : memberRows;
  const label = (row: Person | Team) => tab === 'members' ? (row as TeamMember).username : 'teamName' in row ? row.teamName : row.username;
  const subtitle = (row: Person | Team) => tab === 'members' ? (row as TeamMember).teamName : 'managerUsername' in row ? `Led by ${row.managerUsername}` : null;

  async function reset() { if (!window.confirm('Reset every leaderboard score to zero? This cannot be undone.')) return; const response = await fetch('/api/leaderboards/uploads', { method: 'DELETE' }); const result = await response.json().catch(() => ({})); if (!response.ok) return setError(result.error || 'Reset failed'); await load(from || undefined, to || undefined); }

  return <div className="min-h-screen leaderboard-arena text-slate-100">
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#070916]/80 backdrop-blur-xl"><div className="max-w-7xl mx-auto min-h-20 px-4 sm:px-6 flex items-center justify-between gap-3"><Brand compact /><div className="flex items-center gap-2"><ThemeToggle /><button onClick={onBack} className="leaderboard-icon"><ArrowLeft className="w-5 h-5" /><span className="hidden sm:inline">Analyzer</span></button></div></div></header>
    <main className="max-w-7xl mx-auto px-4 sm:px-6 py-9 sm:py-14">
      <section className="relative overflow-hidden rounded-[2rem] border border-indigo-400/20 bg-gradient-to-br from-indigo-950/90 via-slate-950/90 to-fuchsia-950/60 p-6 sm:p-10 mb-7 shadow-2xl shadow-indigo-950/60">
        <div className="absolute -right-12 -top-20 w-72 h-72 rounded-full bg-fuchsia-500/20 blur-3xl" /><div className="absolute left-1/3 -bottom-28 w-80 h-80 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="relative flex flex-col lg:flex-row lg:items-end justify-between gap-7"><div><span className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[.24em] text-cyan-300"><Sparkles className="w-4 h-4" /> BXO competition arena</span><h1 className="mt-3 text-4xl sm:text-6xl font-black tracking-[-.05em]">CV Upload <span className="neon-text">Leaderboard</span></h1><p className="mt-4 max-w-2xl text-slate-400">Every completed CV workflow earns one point. Climb the ranks, power your team, and claim the crown.</p></div><div className="flex items-center gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/5 px-5 py-4"><Flame className="w-8 h-8 text-orange-400" /><div><div className="text-xs uppercase tracking-wider text-amber-200/60">Live challenge</div><div className="font-black text-amber-100">All scores start fresh</div></div></div></div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-slate-950/60 p-4 sm:p-5 mb-7 backdrop-blur-xl"><div className="flex flex-col xl:flex-row gap-4 xl:items-center justify-between"><div className="grid grid-cols-3 gap-2">{([{ id: 'function', icon: Trophy, text: 'Whole function' }, { id: 'teams', icon: Shield, text: 'Team battle' }, { id: 'members', icon: Users, text: 'Inside teams' }] as const).map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`leaderboard-tab ${tab === item.id ? 'leaderboard-tab-active' : ''}`}><item.icon className="w-4 h-4" /><span>{item.text}</span></button>)}</div><div className="flex flex-wrap items-end gap-2"><label className="date-field"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label><label className="date-field"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label><button disabled={!from || !to} onClick={() => void load(from, to)} className="leaderboard-action"><CalendarDays className="w-4 h-4" />Apply</button>{data?.range && <button onClick={() => { setFrom(''); setTo(''); void load(); }} className="leaderboard-action"><RefreshCw className="w-4 h-4" />All time</button>}{user.role === 'lcvp' && <button onClick={() => void reset()} className="leaderboard-reset">Reset scores</button>}</div></div></section>

      {tab === 'members' && <div className="mb-6 flex items-center gap-3"><span className="text-sm font-bold text-slate-400">Choose team</span><select value={teamId ?? ''} onChange={(event) => setTeamId(Number(event.target.value))} className="rounded-xl border border-violet-400/20 bg-slate-900 px-4 py-3 font-bold text-white outline-none focus:ring-2 focus:ring-violet-500">{data?.teams.map((team) => <option key={team.id} value={team.id}>{team.teamName}</option>)}</select></div>}
      {error && <div className="mb-6 rounded-2xl border border-red-400/20 bg-red-500/10 p-4 text-red-300">{error}</div>}
      {loading ? <div className="py-28 flex justify-center"><Loader2 className="w-9 h-9 animate-spin text-cyan-300" /></div> : <><Podium rows={activeRows} label={label} subtitle={subtitle} /><RankTable rows={activeRows} label={label} subtitle={subtitle} showRole={tab === 'function'} />{!activeRows.length && <div className="py-20 text-center text-slate-500"><Crown className="w-12 h-12 mx-auto mb-4" />No competitors in this arena yet.</div>}</>}
    </main>
  </div>;
}
