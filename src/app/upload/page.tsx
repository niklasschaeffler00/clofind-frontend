'use client';
/* eslint-disable @next/next/no-img-element */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

/* ---------------- Types ---------------- */

type Hit = {
  product_id: number;
  score: number;
  label: string;
  title: string | null;
  price: number;
  currency: string | null;
  merchant: string | null;
  deeplink: string | null;
  image_url: string | null;
};
type SearchResponse = { results?: Hit[] };

/* ---------------- Helpers ---------------- */

function toPixelCrop(c: Crop, img: HTMLImageElement): PixelCrop {
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  const renderedW = img.width || img.getBoundingClientRect().width || naturalW;
  const renderedH = img.height || img.getBoundingClientRect().height || naturalH;
  const scaleX = naturalW / renderedW;
  const scaleY = naturalH / renderedH;
  const isPct = c.unit === '%';
  const rx = c.x ?? 0, ry = c.y ?? 0, rw = c.width ?? 0, rh = c.height ?? 0;
  const x = Math.round(isPct ? (rx / 100) * naturalW : rx * scaleX);
  const y = Math.round(isPct ? (ry / 100) * naturalH : ry * scaleY);
  const w = Math.round(isPct ? (rw / 100) * naturalW : rw * scaleX);
  const h = Math.round(isPct ? (rh / 100) * naturalH : rh * scaleY);
  return { unit: 'px', x: Math.max(0, x), y: Math.max(0, y), width: Math.max(1, w), height: Math.max(1, h) };
}

function pixelToPercentCropWithSize(px: PixelCrop, naturalW: number, naturalH: number): Crop {
  return {
    unit: '%',
    x: (px.x / naturalW) * 100,
    y: (px.y / naturalH) * 100,
    width: (px.width / naturalW) * 100,
    height: (px.height / naturalH) * 100,
  };
}

async function getCroppedBlob(img: HTMLImageElement, crop: PixelCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context not available');

  // Typsichere Erweiterung ohne "any"
  type SmoothCtx = CanvasRenderingContext2D & {
    imageSmoothingEnabled?: boolean;
    imageSmoothingQuality?: 'low' | 'medium' | 'high';
  };
  const sctx = ctx as SmoothCtx;

  if (typeof sctx.imageSmoothingEnabled !== 'undefined') {
    sctx.imageSmoothingEnabled = true;
  }
  if (typeof sctx.imageSmoothingQuality !== 'undefined') {
    sctx.imageSmoothingQuality = 'high';
  }

  ctx.drawImage(
    img,
    crop.x, crop.y, crop.width, crop.height,
    0, 0, canvas.width, canvas.height
  );

  return await new Promise<Blob>((res) =>
    canvas.toBlob((b) => res(b as Blob), 'image/jpeg', 0.92)
  );
}


const fmtPrice = (value?: number, currency = 'EUR', locale = 'de-DE') =>
  typeof value === 'number'
    ? new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)
    : '';

/* ---------------- Tiny Toaster ---------------- */

function useToaster() {
  const [msg, setMsg] = useState<string | null>(null);
  const [type, setType] = useState<'ok' | 'err' | 'info'>('info');
  const timerRef = useRef<number | undefined>(undefined);
  const show = useCallback((m: string, t: 'ok' | 'err' | 'info' = 'info', ms = 2200) => {
    setMsg(m); setType(t);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setMsg(null), ms);
  }, []);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  return { msg, type, show };
}
function Toast({ msg, type }: { msg: string; type: 'ok' | 'err' | 'info' }) {
  const colors = type === 'ok' ? 'bg-emerald-600' : type === 'err' ? 'bg-red-600' : 'bg-gray-900';
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[60] -translate-x-1/2">
      <div className={`${colors} text-white px-4 py-2 rounded-lg shadow`}>{msg}</div>
    </div>
  );
}

/* ---------------- Page ---------------- */

export default function UploadPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Bildquelle
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);

  // NATURAL size
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

  // Zuschneiden (nur Modal)
  const modalImgRef = useRef<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop | undefined>();
  const [modalOpen, setModalOpen] = useState(false);

  // Suche / Ergebnis
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Hit[]>([]);

  // Sort / Pagination
  type SortKey = 'relevance' | 'priceAsc' | 'priceDesc' | 'scoreDesc' | 'scoreAsc';
  const [sortBy, setSortBy] = useState<SortKey>('relevance');
  const [visibleCount, setVisibleCount] = useState(12);

  // Filter
  type LabelBucket = 'Exact' | 'Sehr ähnlich' | 'Alternative';
  const [labelFilter, setLabelFilter] = useState<Record<LabelBucket, boolean>>({
    Exact: true, 'Sehr ähnlich': true, Alternative: true,
  });
  const [priceMin, setPriceMin] = useState<string>('');
  const [priceMax, setPriceMax] = useState<string>('');
  const [merchantSearch, setMerchantSearch] = useState<string>('');

  // Persistente Preview + letzter Crop
  const [cropPreviewUrl, setCropPreviewUrl] = useState<string | null>(null);
  const [lastCropBlob, setLastCropBlob] = useState<Blob | null>(null);
  const [cropPx, setCropPx] = useState<PixelCrop | null>(null);

  const toast = useToaster();

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (cropPreviewUrl) URL.revokeObjectURL(cropPreviewUrl);
    };
  }, [originalUrl, cropPreviewUrl]);

  /* --------- Upload --------- */

  async function handleFiles(files: FileList | null) {
    const f = files?.[0] ?? null;
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.show('Bitte ein Bild auswählen.', 'err'); return; }

    if (originalUrl) URL.revokeObjectURL(originalUrl);
    if (cropPreviewUrl) URL.revokeObjectURL(cropPreviewUrl);

    const url = URL.createObjectURL(f);
    setFile(f);
    setOriginalUrl(url);
    setResults([]);
    setVisibleCount(12);
    setSortBy('relevance');
    setError(null);
    setCrop(undefined);      // Crop erst nach onLoad setzen
    setLastCropBlob(null);
    setCropPreviewUrl(null);
    setCropPx(null);
    setNaturalSize(null);
    setLabelFilter({ Exact: true, 'Sehr ähnlich': true, Alternative: true });
    setPriceMin(''); setPriceMax(''); setMerchantSearch('');
    setModalOpen(true);
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); handleFiles(e.dataTransfer.files); };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); };

  /* --------- Helpers: URL sicherstellen --------- */

  const ensureImageUrl = useCallback(() => {
    if (!file) return;
    // wenn ObjectURL evtl. „tot“ ist → neue erzeugen
    const newUrl = URL.createObjectURL(file);
    setOriginalUrl((old) => {
      if (old && old.startsWith('blob:')) {
        try { URL.revokeObjectURL(old); } catch {}
      }
      return newUrl;
    });
  }, [file]);

  /* --------- Suche --------- */

  const runSearchByUpload = useCallback(async (blobOrFile: Blob | File): Promise<SearchResponse> => {
    const form = new FormData();
    form.set('file', blobOrFile);
    form.set('topk', String(40));

    const base = process.env.NEXT_PUBLIC_API_BASE ?? process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!base) throw new Error('Konfiguration fehlt: NEXT_PUBLIC_API_BASE oder NEXT_PUBLIC_BACKEND_URL nicht gesetzt.');

    const ctrl = new AbortController();
    const to = window.setTimeout(() => ctrl.abort(), 60_000);

    try {
      const paths = ['/search/by-upload', '/search/image'];
      let lastText = '';
      for (const p of paths) {
        let r: Response;
        try {
          r = await fetch(`${base}${p}`, { method: 'POST', body: form, signal: ctrl.signal });
        } catch {
          throw new Error('Netzwerkfehler – bitte überprüfe deine Verbindung und versuche es erneut.');
        }
        if (r.ok) return r.json();
        lastText = await r.text().catch(() => '');
        if (r.status === 503) throw new Error('Bildsuche kurz nicht verfügbar – bitte später erneut versuchen.');
        if (r.status !== 404) throw new Error(`${r.status} ${r.statusText} – ${lastText}`);
      }
      throw new Error(`Kein Upload-Endpoint gefunden (404). Letzte Antwort: ${lastText}`);
    } finally {
      window.clearTimeout(to);
    }
  }, []);

  const confirmAndSearch = useCallback(async () => {
    const imgEl = modalImgRef.current!;
    if (!file || !imgEl || !crop) return;
    try {
      setLoading(true);
      setError(null);
      setResults([]);
      setVisibleCount(12);

      const px = toPixelCrop(crop, imgEl);
      setCropPx(px);

      const cropBlob = await getCroppedBlob(imgEl, px);
      const cropUrl = URL.createObjectURL(cropBlob);

      if (cropPreviewUrl) URL.revokeObjectURL(cropPreviewUrl);
      setCropPreviewUrl(cropUrl);
      setLastCropBlob(cropBlob);

      toast.show('Suche gestartet …', 'info', 1400);

      const data = await runSearchByUpload(cropBlob);
      const hits = Array.isArray(data.results) ? data.results : [];
      setResults(hits);
      setModalOpen(false);
      if (!hits.length) toast.show('Keine Treffer gefunden.', 'info');
      else toast.show(`${hits.length} Treffer gefunden.`, 'ok');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg); toast.show(msg, 'err', 2600);
    } finally {
      setLoading(false);
    }
  }, [file, crop, cropPreviewUrl, runSearchByUpload, toast]);

  async function resubmitWithSameCrop() {
    if (!file) return;
    try {
      setLoading(true);
      setError(null);
      toast.show('Suche läuft …', 'info', 1200);
      const payload: Blob | File = lastCropBlob ?? file;
      const data = await runSearchByUpload(payload);
      setResults(Array.isArray(data.results) ? data.results : []);
      setVisibleCount(12);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.show(msg, 'err');
    } finally {
      setLoading(false);
    }
  }

  /* --------- Shortcuts --------- */

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setModalOpen(false);
      if (ev.key === 'Enter') void confirmAndSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, confirmAndSearch]);

  /* --------- Dedupe + Sort + Filter + Pagination --------- */

  const dedupedResults = useMemo(() => {
    const seen = new Set<string>();
    return results.filter((h) => {
      const id = `${h.product_id}-${h.deeplink ?? ''}-${h.image_url ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [results]);

  const sortedResults = useMemo(() => {
    const arr = [...dedupedResults];
    switch (sortBy) {
      case 'priceAsc': arr.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)); break;
      case 'priceDesc': arr.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity)); break;
      case 'scoreDesc': arr.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)); break;
      case 'scoreAsc': arr.sort((a, b) => (a.score ?? 0) - (b.score ?? 0)); break;
      default: break;
    }
    return arr;
  }, [dedupedResults, sortBy]);

  const normalizeBucket = (lbl?: string): 'Exact' | 'Sehr ähnlich' | 'Alternative' =>
    lbl === 'Exact' ? 'Exact' : lbl === 'Sehr ähnlich' ? 'Sehr ähnlich' : 'Alternative';

  const filteredResults = useMemo(() => {
    const min = priceMin !== '' ? parseFloat(priceMin) : undefined;
    const max = priceMax !== '' ? parseFloat(priceMax) : undefined;
    const merchantQ = merchantSearch.trim().toLowerCase();

    return sortedResults.filter((r) => {
      const bucket = labelFilter[normalizeBucket(r.label)] === true;
      const okMin = min === undefined ? true : (r.price ?? Infinity) >= min;
      const okMax = max === undefined ? true : (r.price ?? -Infinity) <= max;
      const okMerchant = merchantQ === '' ? true : (r.merchant ?? '').toLowerCase().includes(merchantQ);
      return bucket && okMin && okMax && okMerchant;
    });
  }, [sortedResults, labelFilter, priceMin, priceMax, merchantSearch]);

  const visibleResults = filteredResults.slice(0, visibleCount);
  const canLoadMore = visibleCount < filteredResults.length;

  const allLabelsSelected = Object.values(labelFilter).every(Boolean);
  const selectedLabels = Object.entries(labelFilter).filter(([, v]) => v).map(([k]) => k).join(', ');
  const activeBadgeLabels = !allLabelsSelected ? `Ähnlichkeit: ${selectedLabels}` : null;
  const activeBadgePrice = priceMin !== '' || priceMax !== '' ? `Preis: ${priceMin || '0'}–${priceMax || '∞'}` : null;
  const activeBadgeMerchant = merchantSearch.trim() ? `Händler: ${merchantSearch.trim()}` : null;
  const anyActiveBadges = Boolean(activeBadgeLabels || activeBadgePrice || activeBadgeMerchant);

  const clearLabels = () => setLabelFilter({ Exact: true, 'Sehr ähnlich': true, Alternative: true });
  const clearPrice = () => { setPriceMin(''); setPriceMax(''); };
  const clearMerchant = () => setMerchantSearch('');
  const clearAllBadges = () => { clearLabels(); clearPrice(); clearMerchant(); };

  /* ---------------- Render ---------------- */

  const hasImage = Boolean(originalUrl);

  return (
    <>
      {toast.msg && <Toast msg={toast.msg} type={toast.type} />}

      {/* NAVBAR */}
      <header className="sticky top-0 z-40 border-b bg-white/80 backdrop-blur">
        <div className="container mx-auto flex h-16 w-full max-w-screen-2xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
            <span>👕</span>
            <span>CloFind</span>
          </Link>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-900"
          >
            Bildsuche
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFiles(e.target.files)}
          />
        </div>
      </header>

      {/* Start-Ansicht */}
      {!hasImage && (
        <main className="container mx-auto min-h-[calc(100vh-64px)] w-full max-w-screen-2xl px-6 py-12 flex flex-col items-center">
          <section className="w-full max-w-2xl text-center">
            <h1 className="text-[32px] sm:text-[44px] font-extrabold leading-tight text-black">
              Finde die Kleidung, <span className="bg-orange-200/60 px-1">die du suchst.</span>
            </h1>
            <p className="mt-3 text-[15px] text-gray-600">
              Lade ein Foto hoch, wähle den Bereich und entdecke ähnliche Produkte.
            </p>

            <div
              className="mt-8 w-full rounded-2xl border border-dashed border-gray-300 bg-white/70 p-8 shadow-sm hover:shadow transition"
              onDragOver={onDragOver}
              onDrop={onDrop}
            >
              <div className="flex flex-col items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border bg-gray-50">📷</div>
                <div className="text-lg font-medium">Bildsuche</div>
                <p className="text-sm text-gray-500">Bild hierher ziehen oder klicken, um zu wählen</p>

                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-black px-5 py-2.5 text-white text-sm shadow hover:bg-gray-900 active:scale-[0.99]"
                >
                  Bild auswählen
                </button>
              </div>
            </div>

            {error && (
              <div className="mx-auto mt-6 w-full max-w-md rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </section>
        </main>
      )}

      {/* Ergebnis-Ansicht */}
      {hasImage && (
        <main className="container mx-auto grid w-full max-w-screen-2xl grid-cols-1 gap-8 px-6 py-8 md:grid-cols-[320px_1fr] lg:grid-cols-[360px_1fr]">
          {/* LEFT SIDEBAR */}
          <aside className="md:sticky md:top-16">
            <div className="rounded-2xl border bg-white/90 p-4 shadow-sm">
              <div className="text-sm font-medium text-gray-900">Gewählter Bereich</div>

              <div className="mt-3">
                {cropPreviewUrl ? (
                  <div
                    className="w-full rounded-lg border bg-white overflow-hidden"
                    style={{ aspectRatio: cropPx ? `${cropPx.width} / ${cropPx.height}` : '1 / 1' }}
                  >
                    <img
                      src={cropPreviewUrl}
                      alt="Gewählter Bereich"
                      className="h-full w-full object-contain"
                      width={cropPx?.width ?? undefined}
                      height={cropPx?.height ?? undefined}
                      decoding="async"
                      loading="eager"
                    />
                  </div>
                ) : (
                  <div className="h-48 w-full rounded-lg border bg-gray-100" />
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      // Sicherstellen, dass wir eine gültige URL haben
                      if (!originalUrl) ensureImageUrl();
                      setCrop(undefined); // wird im onLoad gesetzt
                      setModalOpen(true);
                    }}
                    className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50"
                  >
                    Ausschnitt ändern
                  </button>
                  <button
                    onClick={resubmitWithSameCrop}
                    disabled={loading}
                    className="rounded-xl bg-black px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                  >
                    Erneut suchen
                  </button>
                </div>
              </div>
            </div>

            {/* Filter-Panel */}
            <div className="mt-6 rounded-2xl border bg-white/90 p-4 shadow-sm">
              <div className="text-sm font-medium text-gray-900">Filter</div>

              <div className="mt-3 space-y-2">
                {(['Exact', 'Sehr ähnlich', 'Alternative'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={labelFilter[k]}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setLabelFilter((prev) => ({ ...prev, [k]: e.target.checked }))
                      }
                    />
                    {k}
                  </label>
                ))}
              </div>

              <div className="mt-4">
                <div className="text-xs font-medium text-gray-700">Preis</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="min"
                    value={priceMin}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPriceMin(e.target.value)}
                    className="w-24 rounded-lg border px-2 py-1 text-sm"
                  />
                  <span className="text-gray-500">–</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="max"
                    value={priceMax}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPriceMax(e.target.value)}
                    className="w-24 rounded-lg border px-2 py-1 text-sm"
                  />
                </div>
              </div>

              <div className="mt-4">
                <div className="text-xs font-medium text-gray-700">Händler</div>
                <input
                  type="text"
                  placeholder="z. B. Zalando"
                  value={merchantSearch}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMerchantSearch(e.target.value)}
                  className="mt-2 w-full rounded-lg border px-3 py-1.5 text-sm"
                />
              </div>

              <div className="mt-4">
                <button
                  onClick={() => { setLabelFilter({ Exact: true, 'Sehr ähnlich': true, Alternative: true }); setPriceMin(''); setPriceMax(''); setMerchantSearch(''); }}
                  className="rounded-xl border px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Filter zurücksetzen
                </button>
              </div>
            </div>
          </aside>

          {/* RIGHT CONTENT */}
          <section>
            {/* Toolbar */}
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">
                Ergebnisse{' '}
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({filteredResults.length} von {dedupedResults.length})
                </span>
              </h2>

              <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex flex-wrap gap-2">
                  {activeBadgeLabels && (
                    <button
                      onClick={clearLabels}
                      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                      title="Ähnlichkeit zurücksetzen"
                    >
                      {activeBadgeLabels}
                      <span className="font-semibold">×</span>
                    </button>
                  )}
                  {activeBadgePrice && (
                    <button
                      onClick={clearPrice}
                      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                      title="Preis-Filter entfernen"
                    >
                      {activeBadgePrice}
                      <span className="font-semibold">×</span>
                    </button>
                  )}
                  {activeBadgeMerchant && (
                    <button
                      onClick={clearMerchant}
                      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                      title="Händler-Filter entfernen"
                    >
                      {activeBadgeMerchant}
                      <span className="font-semibold">×</span>
                    </button>
                  )}
                  {anyActiveBadges && (
                    <button
                      onClick={clearAllBadges}
                      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                      title="Alle Filter entfernen"
                    >
                      Alle löschen
                      <span className="font-semibold">×</span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="sort" className="text-sm text-gray-600">Sortieren:</label>
                  <select
                    id="sort"
                    value={sortBy}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSortBy(e.target.value as SortKey)}
                    className="rounded-xl border px-3 py-1.5 text-sm"
                  >
                    <option value="relevance">Relevanz</option>
                    <option value="priceAsc">Preis: aufsteigend</option>
                    <option value="priceDesc">Preis: absteigend</option>
                    <option value="scoreDesc">Ähnlichkeit: hoch → niedrig</option>
                    <option value="scoreAsc">Ähnlichkeit: niedrig → hoch</option>
                  </select>
                </div>
              </div>
            </div>

            {loading ? (
              <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <li key={i} className="rounded-2xl border bg-white p-4">
                    <div className="aspect-[4/3] w-full rounded-lg bg-gray-200 animate-pulse" />
                    <div className="mt-3 h-4 w-2/3 rounded bg-gray-200 animate-pulse" />
                    <div className="mt-2 h-3 w-1/2 rounded bg-gray-200 animate-pulse" />
                    <div className="mt-2 h-3 w-1/3 rounded bg-gray-200 animate-pulse" />
                  </li>
                ))}
              </ul>
            ) : visibleResults.length ? (
              <>
                <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleResults.map((r, i) => (
                    <li
                      key={`${r.product_id ?? 'p'}-${r.deeplink ?? r.image_url ?? i}`}
                      className="group rounded-2xl border bg-white p-4 shadow-sm transition hover:shadow-md"
                    >
                      <div className="aspect-[4/3] w-full overflow-hidden rounded-lg bg-gray-100">
                        {r.image_url ? (
                          <img
                            src={r.image_url}
                            alt={r.title ?? `Produkt ${r.product_id}`}
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : null}
                      </div>

                      <div className="mt-3">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-[15px] font-medium text-gray-900 line-clamp-2">
                            {r.title ?? `Produkt ${r.product_id}`}
                          </h3>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              r.label === 'Exact'
                                ? 'bg-emerald-100 text-emerald-700'
                                : r.label === 'Sehr ähnlich'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {r.label}
                          </span>
                        </div>

                        <div className="mt-1 text-sm text-gray-700">
                          {r.merchant ? `${r.merchant} • ` : ''}
                          {fmtPrice(r.price, r.currency ?? 'EUR')}
                        </div>
                        <div className="mt-2 text-xs text-gray-500">
                          Score: {Number.isFinite(r.score) ? r.score.toFixed(3) : '-'}
                        </div>

                        {r.deeplink && (
                          <a
                            href={r.deeplink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-block text-sm text-blue-600 underline"
                          >
                            Zum Shop
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>

                {canLoadMore && (
                  <div className="mt-6 flex justify-center">
                    <button
                      onClick={() => setVisibleCount((n) => n + 12)}
                      className="rounded-xl border px-5 py-2 text-sm font-medium hover:bg-gray-50"
                    >
                      Mehr laden
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-xl border bg-white p-6 text-center text-gray-600">
                Keine Ergebnisse. Passe Filter oder Ausschnitt an.
              </div>
            )}

            {error && (
              <div className="mx-auto mt-6 w-full max-w-md rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </section>
        </main>
      )}

      {/* Zuschneiden im Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setModalOpen(false)} />
          <div className="absolute left-1/2 top-1/2 w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white shadow-2xl">
            <div className="border-b px-6 py-4 text-center">
              <h3 className="text-lg font-semibold text-gray-900">Bild zuschneiden</h3>
              <p className="mt-1 text-sm text-gray-500">
                Ziehe die runden Griffe. <kbd className="rounded bg-gray-100 px-1">Esc</kbd> schließt,
                <kbd className="rounded bg-gray-100 px-1">Enter</kbd> startet die Suche.
              </p>
            </div>

            <div className="px-6 py-5">
              {originalUrl ? (
                <div className="relative mx-auto h-[70vh] w-full overflow-auto rounded-xl border bg-gray-50 flex items-center justify-center">
                  <ReactCrop
                    crop={crop}
                    onChange={(c: Crop) => setCrop(c)}
                    keepSelection
                    minWidth={10}
                    minHeight={10}
                  >
                    <img
                      ref={modalImgRef}
                      src={originalUrl}
                      alt="Crop"
                      className="block w-auto max-w-full h-auto max-h-[68vh] object-contain"
                      decoding="async"
                      loading="eager"
                      onLoad={(e) => {
                        const img = e.currentTarget;
                        if (!naturalSize) setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                        if (!crop) {
                          if (cropPx) {
                            setCrop(pixelToPercentCropWithSize(cropPx, img.naturalWidth, img.naturalHeight));
                          } else {
                            setCrop({ unit: '%', x: 12, y: 12, width: 76, height: 76 });
                          }
                        }
                      }}
                      onError={() => {
                        // Falls die ObjectURL ungültig wurde → sofort neu erzeugen
                        ensureImageUrl();
                      }}
                    />
                  </ReactCrop>
                </div>
              ) : (
                <div className="text-sm text-gray-500 text-center">Bitte ein Bild wählen.</div>
              )}
            </div>

            <div className="flex items-center justify-center gap-3 border-t px-6 py-4">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-xl border px-5 py-2.5 text-base font-medium hover:bg-gray-50"
              >
                Abbrechen
              </button>
              <button
                onClick={confirmAndSearch}
                disabled={loading || !file}
                className="rounded-xl bg-black px-6 py-3 text-base font-semibold text-white shadow hover:bg-gray-900 disabled:opacity-60"
              >
                {loading ? 'Suchen…' : '✔︎ Zuschneiden & Suchen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
