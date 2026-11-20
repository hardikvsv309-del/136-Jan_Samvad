import React, { useCallback, useEffect, useState } from 'react';
import { APIProvider } from '@vis.gl/react-google-maps';
import { Menu, X } from 'lucide-react';
import { AdminDashboardView } from './components/admin/AdminDashboardView.tsx';
import { HomeView } from './components/citizen/HomeView.tsx';
import { OurWorkView } from './components/citizen/OurWorkView.tsx';
import { PublicIssuesView } from './components/citizen/PublicIssuesView.tsx';
import { ReportProblemView } from './components/citizen/ReportProblemView.tsx';
import { TrackComplaintView } from './components/citizen/TrackComplaintView.tsx';
import { Vision2030View } from './components/citizen/Vision2030View.tsx';
import { TRANSLATIONS } from './i18n/translations.ts';
import {
  Language,
  ProblemCategory,
  PublicStats,
  PublicUpdateItem,
  PublicWorkItem,
} from './types/index.ts';

type ActiveTab = 'home' | 'report' | 'track' | 'issues' | 'work' | 'vision' | 'admin';

const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

export default function App() {
  const [language, setLanguage] = useState<Language>('gu');
  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [trackCodeTarget, setTrackCodeTarget] = useState<string | undefined>(undefined);
  const [presetReportVillage, setPresetReportVillage] = useState<string | undefined>(undefined);
  const [presetReportCategory, setPresetReportCategory] = useState<ProblemCategory | undefined>(
    undefined
  );
  const [presetIssuesVillage, setPresetIssuesVillage] = useState<string | undefined>(undefined);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);

  const [stats, setStats] = useState<PublicStats | null>(null);
  const [updates, setUpdates] = useState<PublicUpdateItem[]>([]);
  const [works, setWorks] = useState<PublicWorkItem[]>([]);
  const [liveEvent, setLiveEvent] = useState<{
    type: string;
    payload: Record<string, unknown>;
  } | null>(null);

  const t = TRANSLATIONS[language];

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const onQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  const loadPublicData = useCallback(async () => {
    try {
      const [statsRes, updatesRes, workRes] = await Promise.all([
        fetch('/api/public/stats'),
        fetch('/api/public/updates'),
        fetch('/api/public/work'),
      ]);
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }
      if (updatesRes.ok) {
        const uData = await updatesRes.json();
        setUpdates(uData.updates || []);
      }
      if (workRes.ok) {
        const wData = await workRes.json();
        setWorks(wData.works || []);
      }
    } catch (error) {
      console.error('Failed to load public portal data:', error);
    }
  }, []);

  useEffect(() => {
    loadPublicData();
  }, [loadPublicData]);

  // Real-time WebSocket client for live complaint updates & public stats refresh
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;

    const connect = () => {
      if (!isMounted) return;
      socket = new WebSocket(wsUrl);
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.type && parsed.type !== 'connected') {
            setLiveEvent(parsed);
            loadPublicData();
          }
        } catch {
          // Ignore malformed WS message
        }
      };
      socket.onclose = () => {
        if (isMounted) {
          reconnectTimer = setTimeout(connect, 4000);
        }
      };
    };

    connect();
    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [loadPublicData]);

  const navigateTo = (tab: ActiveTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleTrackCode = (code: string) => {
    setTrackCodeTarget(code);
    navigateTo('track');
  };

  const handleReportWithPreset = (opts: { village?: string; category?: ProblemCategory }) => {
    setPresetReportVillage(opts.village);
    setPresetReportCategory(opts.category);
    navigateTo('report');
  };

  const handleViewVillageIssues = (villageId: string) => {
    setPresetIssuesVillage(villageId);
    navigateTo('issues');
  };

  const jumpToAboutContact = () => {
    setActiveTab('home');
    setMobileMenuOpen(false);
    setTimeout(() => {
      document.getElementById('about-contact')?.scrollIntoView({ behavior: 'smooth' });
    }, 80);
  };

  return (
    <APIProvider
      apiKey={MAPS_API_KEY}
      libraries={['marker']}
      language={language}
      region="IN"
    >
      <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
        {mapsQuotaExceeded && (
          <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
            <span>
              Google Maps Platform quota reached. If you are the app owner, visit{' '}
              <a
                href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold text-amber-950 hover:text-amber-800"
              >
                maps developer site
              </a>{' '}
              for instructions to update your account.
            </span>
          </div>
        )}

        {/* Strict 3-Zone Top Bar Contract */}
        <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200 no-print">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
            {/* Zone 1: Single-line Brand Wordmark */}
            <button
              type="button"
              onClick={() => navigateTo('home')}
              className="font-display text-lg sm:text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t.brandTitle}
            </button>

            {/* Zone 2: 5 concise single-line nav links */}
            <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600">
              {(
                [
                  { id: 'track', label: t.navTrack },
                  { id: 'issues', label: t.navIssues },
                  { id: 'work', label: t.navWork },
                  { id: 'vision', label: t.navVision },
                  { id: 'admin', label: t.navAdmin },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    activeTab === item.id
                      ? 'border-amber-600 text-slate-900 font-semibold'
                      : 'border-transparent hover:text-slate-900 hover:border-slate-300'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            {/* Zone 3: 1 Primary CTA + Mobile Menu trigger */}
            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => navigateTo('report')}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {t.navReportCta}
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen((prev) => !prev)}
                className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 cursor-pointer"
                aria-label="Toggle Menu"
              >
                {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Mobile Navigation Drawer */}
          {mobileMenuOpen && (
            <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-3 space-y-1">
              {(
                [
                  { id: 'home', label: t.navHome },
                  { id: 'report', label: t.navReportCta },
                  { id: 'track', label: t.navTrack },
                  { id: 'issues', label: t.navIssues },
                  { id: 'work', label: t.navWork },
                  { id: 'vision', label: t.navVision },
                  { id: 'admin', label: t.navAdmin },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium ${
                    activeTab === item.id
                      ? 'bg-amber-50 text-amber-800 font-semibold'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                onClick={jumpToAboutContact}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {t.aboutHeading} · {t.contactHeading}
              </button>
            </div>
          )}
        </header>

        {/* Sub-header Utility Toolbar: Language Switcher (Gujarati Primary + Hindi + English) */}
        <div className="bg-slate-100 border-b border-slate-200 no-print">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <button
                type="button"
                onClick={() => navigateTo('home')}
                className="hover:text-slate-900 font-medium cursor-pointer"
              >
                {t.navHome}
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={jumpToAboutContact}
                className="hover:text-slate-900 font-medium cursor-pointer"
              >
                {t.aboutHeading}
              </button>
            </div>

            <div className="flex items-center gap-1 p-0.5 bg-white border border-slate-200 rounded-lg">
              {(
                [
                  { code: 'gu', label: 'ગુજરાતી' },
                  { code: 'hi', label: 'हिन्दी' },
                  { code: 'en', label: 'English' },
                ] as const
              ).map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => setLanguage(lang.code)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    language === lang.code
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Main Viewport */}
        <main className="flex-1">
          {activeTab === 'home' && (
            <HomeView
              language={language}
              stats={stats}
              updates={updates}
              onNavigate={(tab) => navigateTo(tab)}
              onReportWithPreset={handleReportWithPreset}
              onViewVillageIssues={handleViewVillageIssues}
              onTrackCode={handleTrackCode}
            />
          )}
          {activeTab === 'report' && (
            <ReportProblemView
              language={language}
              initialVillage={presetReportVillage}
              initialCategory={presetReportCategory}
              onTrackCode={handleTrackCode}
              onSubmitted={loadPublicData}
            />
          )}
          {activeTab === 'track' && (
            <TrackComplaintView
              language={language}
              initialCode={trackCodeTarget}
              liveEvent={liveEvent}
            />
          )}
          {activeTab === 'issues' && (
            <PublicIssuesView
              language={language}
              stats={stats}
              initialVillage={presetIssuesVillage}
              liveEvent={liveEvent}
              onTrackCode={handleTrackCode}
            />
          )}
          {activeTab === 'work' && (
            <OurWorkView
              language={language}
              works={works}
              onTrackCode={handleTrackCode}
            />
          )}
          {activeTab === 'vision' && (
            <Vision2030View
              language={language}
              onReportClick={() => navigateTo('report')}
            />
          )}
          {activeTab === 'admin' && (
            <AdminDashboardView
              language={language}
              onDataMutated={loadPublicData}
            />
          )}
        </main>

        {/* Quiet Civic Footer */}
        <footer className="bg-white border-t border-slate-200 no-print">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-500">
            <div className="space-y-1">
              <div className="font-display font-bold text-sm text-slate-900">
                {t.brandTitle}
              </div>
              <div>{t.footerPrivacyNote}</div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => navigateTo('report')}
                className="hover:text-slate-900 cursor-pointer"
              >
                {t.navReportCta}
              </button>
              <button
                type="button"
                onClick={() => navigateTo('track')}
                className="hover:text-slate-900 cursor-pointer"
              >
                {t.navTrack}
              </button>
              <button
                type="button"
                onClick={() => navigateTo('issues')}
                className="hover:text-slate-900 cursor-pointer"
              >
                {t.navIssues}
              </button>
              <button
                type="button"
                onClick={() => navigateTo('work')}
                className="hover:text-slate-900 cursor-pointer"
              >
                {t.navWork}
              </button>
              <button
                type="button"
                onClick={() => navigateTo('vision')}
                className="hover:text-slate-900 cursor-pointer"
              >
                {t.navVision}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </APIProvider>
  );
}
