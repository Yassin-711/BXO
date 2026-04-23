import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ExternalLink,
  Award,
  BookOpen,
  Languages,
  Cpu,
  ArrowRight,
  ShieldCheck
} from 'lucide-react';

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

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setError(null);
    } else {
      setError('Please upload a valid PDF file.');
      setFile(null);
    }
  };

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
          const errorMessage = data.error || `Server error: ${response.status}`;
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
    <div className="min-h-screen bg-[#fafafa] text-slate-900 font-sans selection:bg-indigo-100">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <ShieldCheck className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight">BXO<span className="text-indigo-600">.</span></span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-500">
            <a href="#" className="hover:text-indigo-600 transition-colors">How it works</a>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12 md:py-20">
        <div className="grid lg:grid-cols-2 gap-16 items-start">
          {/* Left Column: Info */}
          <div className="space-y-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
                Intelligent <span className="text-indigo-600">CV analysis</span> tool for{' '}
                <span className="text-indigo-600">OGT AIESEC</span> in{' '}
                <span className="text-indigo-600">Alexandria</span>
              </h1>
              <p className="text-lg text-slate-600 leading-relaxed max-w-md">
                Upload a PDF resume to extract key insights, calculate a BXO Score, and sync directly to your Google ecosystem.
              </p>
            </motion.div>

            <div className="space-y-4">
              {[
                { icon: Cpu, text: "Lightweight Extraction", sub: "Offline rule-based scoring" },
                { icon: Award, text: "BXO Scoring System", sub: "Proprietary ranking algorithm" },
                { icon: CheckCircle2, text: "Google Workspace Sync", sub: "Drive & Sheets integration" }
              ].map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2 + i * 0.1 }}
                  className="flex items-start gap-4 p-4 rounded-2xl hover:bg-white hover:shadow-sm transition-all border border-transparent hover:border-slate-100"
                >
                  <div className="p-2.5 bg-indigo-50 rounded-xl text-indigo-600">
                    <item.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{item.text}</h3>
                    <p className="text-sm text-slate-500">{item.sub}</p>
                  </div>
                </motion.div>
              ))}
            </div>

            <p className="text-sm text-slate-500 pt-2">
              made by Yassin Elhawash LCVP BXO
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
                  className="bg-white rounded-3xl p-8 shadow-xl shadow-indigo-100/50 border border-slate-100"
                >
                  <div className="mb-8 text-center">
                    <h2 className="text-2xl font-bold mb-2">Upload Resume</h2>
                    <p className="text-slate-500 text-sm">PDF format only, max 10MB</p>
                  </div>

                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`
                      relative group cursor-pointer
                      border-2 border-dashed rounded-2xl p-12
                      flex flex-col items-center justify-center gap-4
                      transition-all duration-300
                      ${file ? 'border-indigo-500 bg-indigo-50/30' : 'border-slate-200 hover:border-indigo-400 hover:bg-slate-50'}
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
                      w-16 h-16 rounded-full flex items-center justify-center transition-transform duration-300
                      ${file ? 'bg-indigo-600 text-white scale-110' : 'bg-slate-100 text-slate-400 group-hover:scale-110'}
                    `}>
                      {file ? <FileText className="w-8 h-8" /> : <Upload className="w-8 h-8" />}
                    </div>

                    <div className="text-center">
                      <p className="font-medium text-slate-900">
                        {file ? file.name : "Click to browse or drag and drop"}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "Support for standard PDF resumes"}
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
                      w-full mt-8 py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all
                      ${!file || isAnalyzing
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200 active:scale-[0.98]'}
                    `}
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin" />
                        Analyzing CV...
                      </>
                    ) : (
                      <>
                        Analyze CV
                        <ArrowRight className="w-5 h-5" />
                      </>
                    )}
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="result-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-3xl p-8 shadow-xl shadow-indigo-100/50 border border-slate-100"
                >
                  <div className="flex items-center justify-between mb-8">
                    <div>
                      <h2 className="text-3xl font-bold text-slate-900">{result.name}</h2>
                      <p className="text-indigo-600 font-medium">{result.majors}</p>
                    </div>
                    <div className="text-right">
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
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 space-y-3">
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
                                className="h-full rounded-full bg-indigo-500 transition-all"
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
                    <div className="grid grid-cols-2 gap-4">
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

                    <div className="flex gap-4 pt-4">
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
      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-slate-200">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 opacity-50">
            <div className="w-6 h-6 bg-slate-900 rounded flex items-center justify-center">
              <ShieldCheck className="text-white w-4 h-4" />
            </div>
            <span className="font-bold text-lg tracking-tight">BXO</span>
          </div>
          <p className="text-slate-400 text-sm">
            © 2026 BXO AI. All rights reserved.
          </p>
          <div className="flex gap-8 text-sm font-medium text-slate-400">
            <a href="#" className="hover:text-indigo-600">Twitter</a>
            <a href="#" className="hover:text-indigo-600">GitHub</a>
            <a href="#" className="hover:text-indigo-600">LinkedIn</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
