'use client';
import { useState, FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BarChart3, Lock, Eye, EyeOff } from 'lucide-react';

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.push(params.get('from') || '/');
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error || '登录失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#080B14] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <BarChart3 size={22} className="text-[#4F8EF7]" />
          <span className="font-semibold text-base tracking-tight">持仓追踪</span>
        </div>

        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-5">
            <Lock size={13} className="text-[#6B7E9C]" />
            <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider">登录</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">用户名</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                autoComplete="username" required
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]"
                placeholder="admin" />
            </div>
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">密码</label>
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password" required
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]"
                  placeholder="••••••••" />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
                  {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-xs text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-xl px-3 py-2">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading}
              className="w-full py-2.5 bg-[#4F8EF7] hover:bg-[#6EA3FF] active:bg-[#3A7AE8] disabled:opacity-50 text-white font-medium rounded-xl transition-colors text-sm mt-2">
              {loading ? '登录中…' : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
