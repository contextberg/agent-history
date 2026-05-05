import { useState } from 'react';

interface Props {
  label: string;
  getValue: () => string;
}

export function CopyButton({ label, getValue }: Props) {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    await navigator.clipboard.writeText(getValue());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleClick}
      className="relative overflow-hidden px-3.5 py-2 rounded-lg text-[11px] font-bold tracking-wide uppercase transition-all duration-300 flex items-center gap-2"
      style={
        copied
          ? {
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              color: '#059669',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }
          : {
              backgroundColor: 'var(--bg-badge)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
            }
      }
    >
      {copied ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  );
}
