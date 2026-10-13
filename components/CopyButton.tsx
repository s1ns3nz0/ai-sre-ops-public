'use client';
import { useState } from 'react';

export function CopyButton({ text, label = 'Copy YAML', className = 'inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm hover:border-ink/40' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className={className}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
      {copied ? 'Copied' : label}
    </button>
  );
}
