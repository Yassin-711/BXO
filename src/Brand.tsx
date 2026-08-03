import { motion } from 'motion/react';

export function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-8 h-8 rounded-[10px]', md: 'w-10 h-10 rounded-xl', lg: 'w-12 h-12 rounded-2xl' };
  return (
    <motion.div whileHover={{ scale: 1.06, rotate: -2 }} className={`brand-mark relative shrink-0 flex items-center justify-center ${sizes[size]}`}>
      <svg viewBox="0 0 32 32" className="relative z-10 w-[58%] h-[58%] text-white" fill="none" aria-hidden="true">
        <path d="M16 3.5 26 7v7.6c0 6.2-4.1 11.5-10 13.9C10.1 26.1 6 20.8 6 14.6V7l10-3.5Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="m12.2 15.8 2.5 2.5 5.4-5.7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="brand-shine" />
    </motion.div>
  );
}

export default function Brand({ inverse = false, compact = false }: { inverse?: boolean; compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-2.5' : 'gap-3'}`} aria-label="BXO CV Analyzer">
      <BrandMark size={compact ? 'sm' : 'md'} />
      <span className={`${compact ? 'text-xl' : 'text-2xl'} font-black tracking-[-0.04em] ${inverse ? 'text-white' : 'text-slate-950 dark:text-white'}`}>
        BXO<span className="text-indigo-500">.</span>
      </span>
    </div>
  );
}
