import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  BookOpen,
  Languages,
  Cpu,
  ArrowRight,
  LogOut,
  Users,
  Sparkles,
  LockKeyhole,
  Network
} from 'lucide-react';
import Brand from './Brand';
import ThemeToggle from './ThemeToggle';

interface ScoreBreakdownRow {
  criterionId: string;
  maxPoints: number;
  earned: number;
  evidence: string;
}

const BREAKDOWN_LABELS: Record<string, string> = {
  education: 'Education',
  experience: 'Experience',
  skills: 'Skills & tools',
  languages: 'Languages',
  certsProjects: 'Certs & projects',
};

interface AnalysisResult {
  name: string;
  majors: string;
  languages: string;
  skills: string;
  vitaeScore: number;
  reasoning?: string;
  breakdown?: ScoreBreakdownRow[];
  driveLink: string;
  driveStatus?: string;
  driveMessage?: string;
  sheetStatus?: string;
  success: boolean;
}

type AppRole = 'lcvp' | 'middle_manager' | 'member';

const APP_ROLE_LABELS: Record<AppRole, string> = { lcvp: 'LCVP', middle_manager: 'Middle Manager', member: 'Member' };

export default function App({ user, onLogout, onOpenAdmin, onOpenTeam }: { user: { username: string; role: AppRole }; onLogout: () => void; onOpenAdmin: () => void; onOpenTeam: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectFile = (selectedFile?: File) => {
    if (selectedFile && selectedFile.type === 'application/pdf' && selectedFile.size <= 4 * 1024 * 1024) {
      setFile(selectedFile);
      setError(null);
    } else if (selectedFile && selectedFile.size > 4 * 1024 * 1024) {
      setError('Please upload a PDF smaller than 4MB.');
      setFile(null);
    } else {
      setError('Please upload a valid PDF file.');
      setFile(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => selectFile(e.target.files?.[0]);

  const handleUpload = async () => {
    if (!file) return;

    setIsAnalyzing(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append('cv', file);

    const targetUrl = '/api/analyze';
    console.log(`Fetching: ${targetUrl}`);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        body: formData,
      });

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.indexOf("application/json") !== -1) {
        const data = await response.json();
        if (!response.ok) {
          let errorMessage = data.error || `Server error: ${response.status}`;
          if (
            errorMessage.includes("OPENROUTER_API_KEY") ||
            errorMessage.toLowerCase().includes("openrouter")
          ) {
            errorMessage =
              "OpenRouter API key is missing or invalid. Set OPENROUTER_API_KEY in your environment (e.g. Render → Environment).";
          }
          throw new Error(errorMessage);
        }
        setResult(data);
      } else {
        const text = await response.text();
        console.error("Non-JSON response received. Status:", response.status);
        
        // Check for platform-level auth/cookie redirects
        if (text.includes("Action required to load your app") || 
            text.includes("Cookie check") || 
            text.includes("redirectToReturnUrl") ||
            text.includes("authInSeparateWindowButton")) {
          throw new Error("Your browser is blocking a required security cookie (common in Safari/iOS iframes). Please click the 'Open in new tab' button in the top right of the preview to use the application.");
        } else if (response.status === 401 || text.toLowerCase().includes("unauthorized")) {
          throw new Error("Authentication error (401). Please ensure you are logged in and your session is active.");
        } else if (response.status === 403 || text.toLowerCase().includes("forbidden")) {
          throw new Error("Permission denied (403). The server rejected the request.");
        } else if (response.status === 404) {
          throw new Error("API endpoint not found (404). Please check the server configuration.");
        } else if (text.startsWith("<!DOCTYPE html>") || text.startsWith("<html>")) {
          // If it's HTML but not the cookie check, it might be the SPA fallback
          throw new Error(`The server returned an HTML page instead of a JSON response (Status ${response.status}). This often happens if the API route is not correctly configured or if the server is restarting.`);
        }
        
        throw new Error(`Unexpected response from server: ${text.substring(0, 100)}...`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-[#fafafa] dark:bg-[#070916] app-mesh text-slate-900 dark:text-slate-100 font-sans selection:bg-indigo-100 overflow-hidden transition-colors duration-300">
      {/* Header */}
      <header className="border-b border-white/70 bg-white/75 backdrop-blur-xl sticky top-0 z-20 shadow-[0_1px_20px_rgba(15,23,42,.04)]">
        <div className="max-w-6xl mx-auto px-6 h-[72px] flex items-center justify-between">
          <Brand compact />
          <nav className="flex items-center gap-2 text-sm font-medium text-slate-500">
            <span className="hidden sm:inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100/80 text-slate-600"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span>{user.username}</span><span className="text-[10px] uppercase tracking-wider text-indigo-600">{APP_ROLE_LABELS[user.role]}</span></span>
            <ThemeToggle />
            {user.role === 'lcvp' && <button onClick={onOpenAdmin} className="p-2.5 rounded-xl border border-transparent hover:border-indigo-100 hover:bg-indigo-50 hover:text-indigo-600 transition-all" title="Account management"><Users className="w-5 h-5" /></button>}
            {user.role === 'middle_manager' && <button onClick={onOpenTeam} className="p-2.5 rounded-xl border border-transparent hover:border-indigo-100 hover:bg-indigo-50 hover:text-indigo-600 transition-all" title="My team"><Network className="w-5 h-5" /></button>}
            <button onClick={onLogout} className="p-2.5 rounded-xl border border-transparent hover:border-red-100 hover:bg-red-50 hover:text-red-500 transition-all" title="Sign out"><LogOut className="w-5 h-5" /></button>
          </nav>
        </div>
      </header>

      <main className="relative max-w-6xl mx-auto px-6 py-12 md:py-20 lg:py-24">
        <div className="grid lg:grid-cols-[1.05fr_.95fr] gap-12 lg:gap-20 items-start">
          {/* Left Column: Info */}
          <div className="space-y-9 lg:sticky lg:top-28">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-white border border-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-[.16em] shadow-sm mb-6">
                <Sparkles className="w-4 h-4" /> Intelligent talent screening
              </div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-[4.25rem] font-black tracking-[-0.055em] leading-[.98] mb-7 text-slate-950 dark:text-white">
                Better CV decisions,{' '}
                <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-blue-600 bg-clip-text text-transparent">beautifully simple.</span>
              </h1>
              <p className="text-lg text-slate-600 leading-relaxed max-w-lg">
                Turn every resume into structured insight, a transparent BXO Score, and a ready-to-review candidate profile for OGT AIESEC Alexandria.
              </p>
            </motion.div>

            <p className="text-xs font-semibold uppercase tracking-[.14em] text-slate-400">
              Crafted by Yassin Elhawash · LCVP BXO
            </p>
          </div>

          {/* Right Column: Upload & Results */}
          <div className="relative">
            <AnimatePresence mode="wait">
              {!result ? (
                <motion.div
                  key="upload-card"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="relative bg-white/90 backdrop-blur-xl rounded-[2rem] p-6 sm:p-8 shadow-[0_28px_80px_rgba(79,70,229,.14)] border border-white ring-1 ring-slate-200/70 overflow-hidden"
                >
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-blue-500" />
                  <div className="mb-8 text-center">
                    <div className="mx-auto mb-4 w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center"><Upload className="w-6 h-6" /></div>
                    <h2 className="text-2xl font-black tracking-tight mb-2">Analyze a resume</h2>
                    <p className="text-slate-500 text-sm">Upload one PDF and get a structured score in moments.</p>
                  </div>

                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(event) => { event.preventDefault(); setIsDragging(false); selectFile(event.dataTransfer.files?.[0]); }}
                    className={`
                      relative group cursor-pointer
                      border-2 border-dashed rounded-3xl p-10 sm:p-12
                      flex flex-col items-center justify-center gap-4
                      transition-all duration-300
                      ${file || isDragging ? 'border-indigo-500 bg-indigo-50/70 scale-[1.01]' : 'border-slate-200 bg-slate-50/60 hover:border-indigo-400 hover:bg-indigo-50/40'}
                    `}
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      className="hidden"
                      accept=".pdf"
                    />

                    <div className={`
                      w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-300 shadow-sm
                      ${file ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white scale-105 shadow-lg shadow-indigo-200' : 'bg-white text-slate-400 group-hover:scale-105 group-hover:text-indigo-600'}
                    `}>
                      {file ? <FileText className="w-8 h-8" /> : <Upload className="w-8 h-8" />}
                    </div>

                    <div className="text-center">
                      <p className="font-medium text-slate-900">
                        {file ? file.name : isDragging ? "Drop your PDF here" : "Drag and drop your resume"}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Ready to analyze` : "or click to browse · PDF up to 4MB"}
                      </p>
                    </div>
                  </div>

                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 p-4 bg-red-50 rounded-xl flex flex-col gap-2 text-red-600 text-sm border border-red-100"
                    >
                      <div className="flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        <span className="font-bold">Analysis Error</span>
                      </div>
                      <p className="pl-8 leading-relaxed">
                        {error.includes("503") || error.includes("UNAVAILABLE") || error.includes("high demand")
                          ? "The AI model is currently busy due to high demand. We've tried retrying, but it's still unavailable. Please wait a minute and try again."
                          : error}
                      </p>
                      {error.includes("blocking a required security cookie") && (
                        <div className="pl-8 mt-2">
                          <button
                            onClick={() => window.open(window.location.href, '_blank')}
                            className="px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-lg font-bold transition-colors flex items-center gap-2"
                          >
                            <ExternalLink className="w-4 h-4" />
                            Open in New Tab
                          </button>
                        </div>
                      )}
                    </motion.div>
                  )}

                  <button
                    disabled={!file || isAnalyzing}
                    onClick={handleUpload}
                    className={`
                      w-full mt-8 py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300
                      ${!file || isAnalyzing
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        : 'bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:shadow-xl hover:shadow-indigo-200 hover:-translate-y-0.5 shadow-lg shadow-indigo-200 active:scale-[0.98]'}
                    `}
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin" />
                        Analyzing with AI...
                      </>
                    ) : (
                      <>
                        Analyze CV
                        <ArrowRight className="w-5 h-5" />
                      </>
                    )}
                  </button>
                  <div className="mt-5 flex items-center justify-center gap-2 text-xs text-slate-400"><LockKeyhole className="w-3.5 h-3.5" />Your file is processed securely</div>
                </motion.div>
              ) : (
                <motion.div
                  key="result-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="relative bg-white/95 backdrop-blur-xl rounded-[2rem] p-6 sm:p-8 shadow-[0_28px_80px_rgba(79,70,229,.14)] border border-white ring-1 ring-slate-200/70 overflow-hidden"
                >
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-blue-500" />
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5 mb-8">
                    <div className="min-w-0">
                      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 break-words">{result.name}</h2>
                      <p className="text-indigo-600 font-medium">{result.majors}</p>
                    </div>
                    <div className="text-left sm:text-right rounded-2xl bg-slate-50 px-4 py-3 border border-slate-100 shrink-0">
                      <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">BXO Score</div>
                      <div className={`text-4xl font-black ${result.vitaeScore > 80 ? 'text-emerald-500' : result.vitaeScore > 50 ? 'text-amber-500' : 'text-slate-900'}`}>
                        {result.vitaeScore}
                      </div>
                      <div className="text-[10px] text-slate-400 font-medium mt-1 max-w-[140px] ml-auto leading-tight">
                        Weighted rubric (server-verified sum)
                      </div>
                    </div>
                  </div>

                  {result.breakdown && result.breakdown.length > 0 && (
                    <div className="rounded-3xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-5 space-y-4 shadow-inner shadow-slate-100">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Score breakdown</div>
                      <ul className="space-y-3">
                        {result.breakdown.map((row) => (
                          <li key={row.criterionId} className="text-sm">
                            <div className="flex justify-between gap-2 font-medium text-slate-800">
                              <span>{BREAKDOWN_LABELS[row.criterionId] ?? row.criterionId}</span>
                              <span className="tabular-nums text-indigo-600">
                                {row.earned}/{row.maxPoints}
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all"
                                style={{ width: `${row.maxPoints ? Math.min(100, (row.earned / row.maxPoints) * 100) : 0}%` }}
                              />
                            </div>
                            <p className="mt-1 text-xs text-slate-500 leading-snug line-clamp-2" title={row.evidence}>
                              {row.evidence}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="space-y-6">
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="p-4 bg-slate-50 rounded-2xl">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                          <Languages className="w-4 h-4" />
                          <span className="text-xs font-bold uppercase tracking-wider">Languages</span>
                        </div>
                        <p className="text-sm font-medium text-slate-700">{result.languages}</p>
                      </div>
                      <div className="p-4 bg-slate-50 rounded-2xl">
                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                          <BookOpen className="w-4 h-4" />
                          <span className="text-xs font-bold uppercase tracking-wider">Field</span>
                        </div>
                        <p className="text-sm font-medium text-slate-700">{result.majors}</p>
                      </div>
                    </div>

                    <div className="p-4 bg-slate-50 rounded-2xl">
                      <div className="flex items-center gap-2 text-slate-400 mb-2">
                        <Cpu className="w-4 h-4" />
                        <span className="text-xs font-bold uppercase tracking-wider">Skills & Expertise</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {result.skills.split(',').map((skill, i) => (
                          <span key={i} className="px-3 py-1 bg-white border border-slate-200 rounded-full text-xs font-medium text-slate-600">
                            {skill.trim()}
                          </span>
                        ))}
                      </div>
                    </div>

                    {result.reasoning && (
                      <div className="p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100">
                        <p className="text-sm text-indigo-900 leading-relaxed italic">
                          "{result.reasoning}"
                        </p>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-4 pt-4">
                      {result.driveStatus === 'success' ? (
                        <a
                          href={result.driveLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-4 bg-slate-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-slate-800 transition-all"
                        >
                          View in Drive
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      ) : (
                        <div className="flex-1 py-4 px-3 bg-slate-100 text-slate-500 rounded-2xl font-bold flex flex-col items-center justify-center gap-2 text-xs text-center">
                          <span className="font-bold text-sm text-slate-600">Drive upload did not complete</span>
                          <p className="text-[11px] font-normal leading-snug text-slate-500">
                            {result.driveMessage ??
                              (result.driveStatus === 'missing_credentials'
                                ? 'Add Google service account env vars.'
                                : result.driveStatus === 'missing_folder_id'
                                  ? 'Set GOOGLE_DRIVE_FOLDER_ID.'
                                  : 'Error during upload')}
                          </p>
                        </div>
                      )}
                      <button
                        onClick={reset}
                        className="px-8 py-4 bg-slate-100 text-slate-600 rounded-2xl font-bold hover:bg-slate-200 transition-all"
                      >
                        New Analysis
                      </button>
                    </div>
                  </div>

                  <div className={`mt-8 pt-6 border-t border-slate-100 flex items-center justify-center gap-2 text-sm font-medium ${result.sheetStatus === 'success' ? 'text-emerald-600' : 'text-slate-400'}`}>
                    {result.sheetStatus === 'success' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Saved to Google Sheets
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4" />
                        Sheets Sync: {result.sheetStatus?.replace('_', ' ')}
                      </>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto px-6 py-10 border-t border-slate-200/70">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="opacity-70"><Brand compact /></div>
          <p className="text-slate-400 text-sm">
            © 2026 BXO CV Analyzer. Internal use only.
          </p>
          <div className="text-sm font-medium text-slate-400">OGT AIESEC Alexandria</div>
        </div>
      </footer>
    </div>
  );
}
