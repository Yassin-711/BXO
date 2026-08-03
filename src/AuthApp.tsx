import React, { FormEvent, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, ArrowLeft, Check, Eye, EyeOff, Loader2, LockKeyhole, Plus, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import Analyzer from './App';

type Role = 'admin' | 'user';
type SessionUser = { id: number; username: string; role: Role };
type ManagedUser = SessionUser & { isActive: boolean; createdAt: string; lastLoginAt: string | null; deletedAt?: string | null };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200">
        <ShieldCheck className="text-white w-6 h-6" />
      </div>
      <span className="font-bold text-2xl tracking-tight">BXO<span className="text-indigo-600">.</span></span>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder = 'Password', required = true }: { value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} minLength={8} required={required} className="auth-input pr-12" />
      <button type="button" onClick={() => setVisible(!visible)} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-indigo-600">
        {visible ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
      </button>
    </div>
  );
}

function AccessScreen({ setupRequired, onAuthenticated }: { setupRequired: boolean; onAuthenticated: (user: SessionUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api<{ user: SessionUser }>(setupRequired ? '/setup' : '/login', {
        method: 'POST',
        body: JSON.stringify(setupRequired ? { username, password, setupToken } : { username, password, rememberMe }),
      });
      onAuthenticated(result.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to continue');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#fafafa] text-slate-900 grid lg:grid-cols-[1.1fr_0.9fr]">
      <section className="hidden lg:flex relative overflow-hidden bg-slate-950 text-white p-16 flex-col justify-between">
        <div className="absolute inset-0 auth-grid opacity-30" />
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-indigo-600/30 blur-3xl rounded-full" />
        <div className="relative"><Brand /></div>
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="relative max-w-xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-sm text-indigo-200 mb-7">
            <LockKeyhole className="w-4 h-4" /> Private workspace
          </div>
          <h1 className="text-6xl font-black tracking-tight leading-[1.05] mb-6">Secure access to smarter CV decisions.</h1>
          <p className="text-lg text-slate-400 leading-relaxed">Your BXO analysis workspace, protected for the OGT Alexandria team.</p>
        </motion.div>
        <p className="relative text-sm text-slate-500">BXO AI · Internal system</p>
      </section>

      <section className="flex items-center justify-center p-6 md:p-12">
        <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md">
          <div className="lg:hidden mb-12"><Brand /></div>
          <div className="mb-9">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">{setupRequired ? 'First-time setup' : 'Welcome back'}</span>
            <h2 className="text-4xl font-black tracking-tight mt-3">{setupRequired ? 'Create your admin' : 'Sign in to BXO'}</h2>
            <p className="text-slate-500 mt-3">{setupRequired ? 'Use your private one-time token to initialize the workspace.' : 'Enter your internal account credentials to continue.'}</p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {setupRequired && <input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} placeholder="One-time setup token" required className="auth-input" />}
            <input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="Username" pattern="[a-z0-9._\-]+" minLength={3} required className="auth-input" autoComplete="username" />
            <PasswordInput value={password} onChange={setPassword} />
            {!setupRequired && (
              <label className="flex items-center gap-3 py-2 text-sm text-slate-600 cursor-pointer select-none">
                <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="w-4 h-4 accent-indigo-600" />
                Remember me for 90 days
              </label>
            )}
            {error && <div className="p-4 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm flex gap-3"><AlertCircle className="w-5 h-5 shrink-0" />{error}</div>}
            <button disabled={loading} className="w-full h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-200 transition-all disabled:opacity-60">
              {loading && <Loader2 className="w-5 h-5 animate-spin" />}{setupRequired ? 'Initialize workspace' : 'Sign in'}
            </button>
          </form>
        </motion.div>
      </section>
    </main>
  );
}

function UserForm({ user, onClose, onSaved }: { user?: ManagedUser; onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      await api(user ? `/users/${user.id}` : '/users', { method: user ? 'PATCH' : 'POST', body: JSON.stringify({ username, password: password || undefined, role, isActive }) });
      onSaved();
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Unable to save account'); }
    finally { setLoading(false); }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm p-6 flex items-center justify-center" onMouseDown={onClose}>
      <motion.form initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }} onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-lg bg-white rounded-3xl p-8 shadow-2xl">
        <h3 className="text-2xl font-black mb-2">{user ? 'Edit account' : 'Add account'}</h3>
        <p className="text-sm text-slate-500 mb-7">{user ? 'Update access, role, or credentials.' : 'Create a new internal BXO account.'}</p>
        <div className="space-y-4">
          <input className="auth-input" value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} placeholder="Username" required pattern="[a-z0-9._\-]+" minLength={3} />
          <PasswordInput value={password} onChange={setPassword} placeholder={user ? 'New password (leave blank to keep)' : 'Password'} required={!user} />
          <div className="grid grid-cols-2 gap-4">
            <select className="auth-input" value={role} onChange={(event) => setRole(event.target.value as Role)}><option value="user">User</option><option value="admin">Admin</option></select>
            <select className="auth-input" value={isActive ? 'active' : 'disabled'} onChange={(event) => setIsActive(event.target.value === 'active')}><option value="active">Active</option><option value="disabled">Disabled</option></select>
          </div>
          {error && <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">{error}</div>}
          <div className="flex gap-3 pt-3"><button type="button" onClick={onClose} className="flex-1 h-12 rounded-xl bg-slate-100 font-bold text-slate-600">Cancel</button><button disabled={loading} className="flex-1 h-12 rounded-xl bg-indigo-600 text-white font-bold flex items-center justify-center gap-2">{loading && <Loader2 className="w-4 h-4 animate-spin" />}Save account</button></div>
        </div>
      </motion.form>
    </motion.div>
  );
}

function AdminPanel({ currentUser, onBack }: { currentUser: SessionUser; onBack: () => void }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null);
  const [error, setError] = useState('');

  async function loadUsers() {
    try { const result = await api<{ users: ManagedUser[] }>('/users'); setUsers(result.users); setError(''); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load accounts'); }
  }
  useEffect(() => { void loadUsers(); }, []);

  async function remove(user: ManagedUser) {
    if (!window.confirm(`Disable and archive “${user.username}”?`)) return;
    try { await api(`/users/${user.id}`, { method: 'DELETE' }); await loadUsers(); }
    catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete account'); }
  }

  return (
    <div className="min-h-screen bg-[#fafafa] text-slate-900">
      <header className="bg-white border-b border-slate-200"><div className="max-w-6xl mx-auto h-20 px-6 flex items-center justify-between"><Brand /><button onClick={onBack} className="flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-indigo-600"><ArrowLeft className="w-4 h-4" />Back to analyzer</button></div></header>
      <main className="max-w-6xl mx-auto px-6 py-12">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-5 mb-9"><div><span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">Administration</span><h1 className="text-4xl font-black tracking-tight mt-2">Account management</h1><p className="text-slate-500 mt-2">Create and control access to the internal workspace.</p></div><button onClick={() => setEditing('new')} className="h-12 px-5 rounded-xl bg-indigo-600 text-white font-bold flex items-center gap-2 shadow-lg shadow-indigo-200"><Plus className="w-5 h-5" />Add account</button></div>
        {error && <div className="mb-6 p-4 rounded-xl bg-red-50 text-red-600">{error}</div>}
        <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto"><table className="w-full text-left"><thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500"><tr><th className="px-6 py-4">Account</th><th className="px-6 py-4">Role</th><th className="px-6 py-4">Status</th><th className="px-6 py-4">Created</th><th className="px-6 py-4">Last login</th><th className="px-6 py-4 text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{users.map((user) => <tr key={user.id} className="hover:bg-slate-50/60"><td className="px-6 py-5"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center"><UserCog className="w-5 h-5" /></div><div><div className="font-bold">{user.username}</div>{user.id === currentUser.id && <span className="text-xs text-indigo-600">You</span>}</div></div></td><td className="px-6 py-5 capitalize font-medium">{user.role}</td><td className="px-6 py-5"><span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${user.isActive && !user.deletedAt ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}><span className="w-1.5 h-1.5 rounded-full bg-current" />{user.isActive && !user.deletedAt ? 'Active' : 'Disabled'}</span></td><td className="px-6 py-5 text-sm text-slate-500">{new Date(user.createdAt).toLocaleDateString()}</td><td className="px-6 py-5 text-sm text-slate-500">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td><td className="px-6 py-5"><div className="flex justify-end gap-2"><button onClick={() => setEditing(user)} className="px-3 py-2 rounded-lg bg-slate-100 text-sm font-bold text-slate-600">Edit</button><button onClick={() => remove(user)} disabled={user.id === currentUser.id || Boolean(user.deletedAt)} className="p-2 rounded-lg bg-red-50 text-red-500 disabled:opacity-30"><Trash2 className="w-4 h-4" /></button></div></td></tr>)}</tbody></table></div>
          {!users.length && <div className="p-16 text-center text-slate-400"><Users className="w-10 h-10 mx-auto mb-3" />No accounts found</div>}
        </div>
      </main>
      <AnimatePresence>{editing && <UserForm user={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void loadUsers(); }} />}</AnimatePresence>
    </div>
  );
}

export default function AuthApp() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [checking, setChecking] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    Promise.allSettled([api<{ user: SessionUser }>('/me'), api<{ setupRequired: boolean }>('/setup/status')]).then(([me, setup]) => {
      if (me.status === 'fulfilled') setUser(me.value.user);
      if (setup.status === 'fulfilled') setSetupRequired(setup.value.setupRequired);
      setChecking(false);
    });
  }, []);

  async function logout() { await api('/logout', { method: 'POST' }); setUser(null); setAdminOpen(false); }

  if (checking) return <div className="min-h-screen bg-[#fafafa] flex items-center justify-center"><Loader2 className="w-8 h-8 text-indigo-600 animate-spin" /></div>;
  if (!user) return <AccessScreen setupRequired={setupRequired} onAuthenticated={(authenticatedUser) => { setUser(authenticatedUser); setSetupRequired(false); }} />;
  if (adminOpen && user.role === 'admin') return <AdminPanel currentUser={user} onBack={() => setAdminOpen(false)} />;
  return <Analyzer user={user} onLogout={logout} onOpenAdmin={() => setAdminOpen(true)} />;
}
