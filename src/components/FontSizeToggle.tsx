'use client';
import { useState, useEffect } from 'react';

type FS = 'sm' | 'md' | 'lg';

export default function FontSizeToggle() {
  const [fs, setFs] = useState<FS>('md');

  useEffect(() => {
    setFs((localStorage.getItem('fs') ?? 'md') as FS);
  }, []);

  function apply(v: FS) {
    setFs(v);
    localStorage.setItem('fs', v);
    if (v === 'md') document.documentElement.removeAttribute('data-fs');
    else document.documentElement.setAttribute('data-fs', v);
  }

  const sizes: [FS, number, string][] = [['sm', 11, 'A'], ['md', 13, 'A'], ['lg', 16, 'A']];

  return (
    <div className="flex items-center bg-[#141C2C] rounded-lg border border-[#1E2D42] p-0.5 gap-px">
      {sizes.map(([v, sz, label]) => (
        <button
          key={v}
          onClick={() => apply(v)}
          style={{ fontSize: sz }}
          className={`px-1.5 py-0.5 rounded leading-none font-medium transition-colors ${
            fs === v
              ? 'bg-[#4F8EF7]/20 text-[#4F8EF7]'
              : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
