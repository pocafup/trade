import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '持仓追踪',
  description: '个人股票组合追踪',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: '持仓追踪',
    statusBarStyle: 'black',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#080B14',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <head>
        {/* Restore font size preference before first paint to avoid flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var v=localStorage.getItem('fs');if(v&&v!=='md')document.documentElement.setAttribute('data-fs',v)}catch(e){}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
