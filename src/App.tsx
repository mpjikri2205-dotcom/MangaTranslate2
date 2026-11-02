import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';
import { motion, AnimatePresence } from 'motion/react';
import Tesseract from 'tesseract.js';

const Type = {
  ARRAY: 'ARRAY' as const,
  OBJECT: 'OBJECT' as const,
  STRING: 'STRING' as const,
  NUMBER: 'NUMBER' as const,
  INTEGER: 'INTEGER' as const,
  BOOLEAN: 'BOOLEAN' as const
};
import { 
  Upload, 
  Languages, 
  Download, 
  Trash2, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  Settings,
  X,
  Grid,
  List,
  CheckSquare,
  Square,
  Edit3,
  Plus,
  Save,
  Zap,
  RotateCcw,
  Layers,
  Ungroup,
  Key,
  Archive,
  FileText,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  ZoomIn,
  ZoomOut,
  Move,
  PanelRightClose,
  PanelRightOpen,
  Eraser,
  Scan
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { AIParams } from './services/aiProviders';
import { Batch, MangaPage, TextBlock } from './types';
import { renderPage, PageCacheEntry } from './lib/renderPage';
import { PAGE_SCHEMA, buildPagePrompt, buildContext, normalizeBlocks, correctionsPrompt, recordCorrections, loadCorrections, clearCorrections } from './lib/aiPrompt';
import { ACTIONS, EDIT_ONLY, loadKeymap, saveKeymap, comboOf, prettyCombo } from './lib/shortcuts';
import { apiFetch } from './lib/apiClient';
import { isNative } from './lib/platform';
import { saveBlobNative } from './lib/nativeFile';

/** Saat kotak teks digeser/diubah ukurannya, simpan dulu area teks ASLI agar area hapus tidak ikut bergeser. */
const withSrc = (b: TextBlock, u: Partial<TextBlock>): TextBlock => {
  const moves = 'x' in u || 'y' in u || 'width' in u || 'height' in u;
  const base = moves && b.srcX === undefined && !b.isCleanOnly && b.type !== 'manual'
    ? { ...b, srcX: b.x, srcY: b.y, srcW: b.width, srcH: b.height }
    : b;
  return { ...base, ...u };
};
const clampNum = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const cleanAndParseJSON = (text: string): any[] => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Try to extract JSON array using regex if standard parsing fails
    const match = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerE) {
        console.error("Failed to parse extracted JSON block:", innerE);
      }
    }
    
    // Check if it's enclosed in markdown backticks
    const markdownMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (markdownMatch) {
      try {
        return JSON.parse(markdownMatch[1].trim());
      } catch (innerE) {
        console.error("Failed to parse markdown-cleaned JSON:", innerE);
      }
    }
    
    throw e; // Re-throw the original error if extraction fails
  }
};

const sanitizeFontFamily = (family: any, fallback: string = '"Comic Neue", cursive'): string => {
  if (!family || typeof family !== 'string') return fallback;
  const lower = family.toLowerCase();
  if (lower.includes('comic')) return '"Comic Neue", cursive';
  if (lower.includes('banger')) return '"Bangers", cursive';
  if (lower.includes('architect') || lower.includes('daughter') || lower.includes('handwrite')) return '"Architects Daughter", cursive';
  if (lower.includes('fredoka') || lower.includes('round')) return '"Fredoka", sans-serif';
  if (lower.includes('inter') || lower.includes('sans')) return '"Inter", sans-serif';
  if (lower.includes('serif')) return 'serif';
  return fallback;
};

export default function App() {
  const [apiKeys, setApiKeys] = useState({
    gemini: '',
    openai: '',
    anthropic: '',
    custom: ''
  });

  React.useEffect(() => {
    const savedKeys = localStorage.getItem('manga_translator_api_keys');
    if (savedKeys) {
      try {
        setApiKeys(JSON.parse(savedKeys));
      } catch (e) {
        console.error('Failed to parse saved API keys', e);
      }
    }
  }, []);


  const saveApiKeys = () => {
    localStorage.setItem('manga_translator_api_keys', JSON.stringify(apiKeys));
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.8 },
      colors: ['#10b981', '#3b82f6', '#000000']
    });
  };

  const translationRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pageAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const blobCache = useRef<Map<string, Uint8Array>>(new Map());

  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  
  const activeBatch = batches.find(b => b.id === activeBatchId);
  const pages = activeBatch?.pages || [];

  const updatePagesInBatch = useCallback((batchId: string, updater: MangaPage[] | ((prev: MangaPage[]) => MangaPage[])) => {
    setBatches(prevBatches => {
      const index = prevBatches.findIndex(b => b.id === batchId);
      if (index === -1) return prevBatches;
      
      const newBatches = [...prevBatches];
      const newPages = typeof updater === 'function' ? updater(newBatches[index].pages) : updater;
      newBatches[index] = { ...newBatches[index], pages: newPages };
      return newBatches;
    });
  }, []);

  const setPages = useCallback((updater: MangaPage[] | ((prev: MangaPage[]) => MangaPage[])) => {
    if (!activeBatchId) return;
    updatePagesInBatch(activeBatchId, updater);
  }, [activeBatchId, updatePagesInBatch]);

  const pagesRef = useRef<MangaPage[]>(pages);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  const stopTranslation = useCallback(() => {
    translationRef.current = false;
    setIsTranslating(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Abort all individual page translators
    pageAbortControllersRef.current.forEach((controller) => {
      try {
        controller.abort();
      } catch (e) {
        console.error('Error aborting page controller in stopTranslation:', e);
      }
    });
    pageAbortControllersRef.current.clear();

    // Reset status of all processing and queued batches back to idle and clean their pages
    setBatches(prev => prev.map(b => {
      if (b.status === 'processing' || b.status === 'queued') {
        return {
          ...b,
          status: 'idle',
          pages: b.pages.map(p => p.status === 'translating' ? { ...p, status: 'pending', error: undefined } : p)
        };
      }
      return b;
    }));
  }, []);

  const stopPageTranslation = useCallback((pageId: string) => {
    setBatches(prev => prev.map(b => {
      if (b.pages.some(p => p.id === pageId)) {
        return {
          ...b,
          pages: b.pages.map(p => p.id === pageId ? { ...p, status: 'pending', error: undefined } : p)
        };
      }
      return b;
    }));
    
    // Abort ONLY this specific page's controller
    const controller = pageAbortControllersRef.current.get(pageId);
    if (controller) {
      try {
        controller.abort();
      } catch (e) {
        console.error('Error aborting specific page controller:', e);
      }
      pageAbortControllersRef.current.delete(pageId);
    }
  }, []);

  const updateBatch = useCallback((batchId: string, updates: Partial<Batch>) => {
    setBatches(prev => prev.map(b => b.id === batchId ? { ...b, ...updates } : b));
  }, []);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [isPageDrawerOpen, setIsPageDrawerOpen] = useState(true);

  useEffect(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, [currentIndex, activeBatchId]);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationStyle, setTranslationStyle] = useState<'natural' | 'literal'>('natural');
  const [aiEngine, setAiEngine] = useState<'flash' | 'pro' | 'lite' | 'auto'>('flash');
  const [translationEnabled, setTranslationEnabled] = useState(true);
  
  const [sourceLanguage, setSourceLanguage] = useState<'auto' | 'ja' | 'ko' | 'zh' | 'en'>(() => {
    return (localStorage.getItem('manga_translator_source_language') as any) || 'auto';
  });

  const [translateScope, setTranslateScope] = useState<'all' | 'balloon'>(() => {
    return (localStorage.getItem('manga_translator_translate_scope') as any) || 'all';
  });

  const saveTranslateScope = (scope: 'all' | 'balloon') => {
    setTranslateScope(scope);
    localStorage.setItem('manga_translator_translate_scope', scope);
  };

  const [pdfSettings, setPdfSettings] = useState(() => {
    const saved = localStorage.getItem('manga_translator_pdf_settings');
    const defaultSettings = {
      compressed: true,
      maxDimension: 1100,
      jpegQuality: 0.72
    };
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return {
            ...defaultSettings,
            ...parsed
          };
        }
      } catch (e) {
        console.error('Failed to parse saved PDF settings', e);
      }
    }
    return defaultSettings;
  });

  const [pdfQueue, setPdfQueue] = useState<{ targetPages?: MangaPage[], batchId: string }[]>([]);
  const [isPdfProcessing, setIsPdfProcessing] = useState(false);

  const [completedPdfs, setCompletedPdfs] = useState<{ id: string; name: string; url: string; size: string; timestamp: number }[]>([]);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isExportingZip, setIsExportingZip] = useState(false);

  // Hidden/Secure direct server-supported download handler to bypass iframe/WebView restrictions
  const triggerServerSideDownload = async (fileBlob: Blob, filename: string) => {
    try {
      // Android (APK): tulis ke penyimpanan lalu buka lembar Bagikan/Simpan
      if (isNative()) return await saveBlobNative(fileBlob, filename);
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          resolve(res.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(fileBlob);
      });

      // Break big base64 into 500KB chunks to bypass proxy HTTP body limits
      const chunkSize = 500000;
      const totalChunks = Math.ceil(base64.length / chunkSize);

      const startRes = await apiFetch('/api/download-chunk/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mimeType: fileBlob.type || 'application/octet-stream',
          filename
        })
      });

      if (!startRes.ok) throw new Error(`HTTP error starting chunk upload: ${startRes.status}`);
      const { uploadId } = await startRes.json();

      // Upload each chunk sequentially
      for (let i = 0; i < totalChunks; i++) {
        const chunkBase64 = base64.slice(i * chunkSize, (i + 1) * chunkSize);
        const uploadRes = await apiFetch('/api/download-chunk/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadId,
            chunkIndex: i,
            chunkBase64
          })
        });
        if (!uploadRes.ok) throw new Error(`HTTP error uploading chunk ${i}: ${uploadRes.status}`);
      }

      // Complete chunk session and get final token/url
      const completeRes = await apiFetch('/api/download-chunk/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId })
      });

      if (!completeRes.ok) throw new Error(`HTTP error completing chunk upload: ${completeRes.status}`);
      const { downloadUrl } = await completeRes.json();

      // Download using hidden iframe (100% reliable inside WebView and iframe sandboxes)
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = downloadUrl;
      document.body.appendChild(iframe);
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 8000);
      
      return downloadUrl;
    } catch (err) {
      console.error('Trigger secure download failed, falling back to Blob URL:', err);
      // Fallback
      const blobUrl = URL.createObjectURL(fileBlob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const saveSourceLanguage = (lang: 'auto' | 'ja' | 'ko' | 'zh' | 'en') => {
    setSourceLanguage(lang);
    localStorage.setItem('manga_translator_source_language', lang);
  };

  const savePdfSettings = (newPdfSettings: typeof pdfSettings) => {
    setPdfSettings(newPdfSettings);
    localStorage.setItem('manga_translator_pdf_settings', JSON.stringify(newPdfSettings));
  };

  const addBatchToPdfQueue = (batchId: string, targetPages?: MangaPage[]) => {
    setPdfQueue(prev => [...prev, { batchId, targetPages }]);
  };

  React.useEffect(() => {
    if (pdfQueue.length === 0 || isPdfProcessing) return;

    const runQueue = async () => {
      setIsPdfProcessing(true);
      const nextItem = pdfQueue[0];
      try {
        await generatePDF(nextItem.targetPages, nextItem.batchId);
      } catch (err) {
        console.error("Queue PDF generation error:", err);
      } finally {
        setPdfQueue(prev => prev.slice(1));
        setIsPdfProcessing(false);
      }
    };
    runQueue();
  }, [pdfQueue, isPdfProcessing]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(typeof window !== 'undefined' ? window.innerWidth >= 1024 : true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMobileActionsOpen, setIsMobileActionsOpen] = useState(false);
  const [viewScrollMode, setViewScrollMode] = useState<'fit' | 'scroll'>('fit');
  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
  const [ocrSettings, setOcrSettings] = useState({
    confidenceThreshold: 70,
    detectionSensitivity: 80
  });

  const [systemKeys, setSystemKeys] = useState<{ [key: string]: boolean }>({
    gemini: false,
    openai: false,
    anthropic: false,
    custom: false
  });

  useEffect(() => {
    apiFetch('/api/env-check')
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          setSystemKeys(data);
        }
      })
      .catch(err => console.error('Failed to retrieve system API keys:', err));
  }, []);

  React.useEffect(() => {
    const savedOcr = localStorage.getItem('manga_translator_ocr_settings');
    if (savedOcr) {
      try {
        const parsed = JSON.parse(savedOcr);
        if (parsed && typeof parsed === 'object') {
          setOcrSettings(prev => ({
            ...prev,
            ...parsed
          }));
        }
      } catch (e) {
        console.error('Failed to parse saved OCR settings', e);
      }
    }
  }, []);

  const saveOcrSettings = (newSettings: typeof ocrSettings) => {
    localStorage.setItem('manga_translator_ocr_settings', JSON.stringify(newSettings));
  };
  const [apiSettings, setApiSettings] = useState(() => {
    const saved = localStorage.getItem('manga_translator_api_settings');
    const defaultSettings = {
      provider: 'gemini' as 'gemini' | 'openai' | 'anthropic' | 'custom' | 'local',
      model: 'gemini-3.1-flash-lite',
      keyMode: 'system' as 'system' | 'custom',
      customBaseURL: '',
      customModel: ''
    };
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return {
            ...defaultSettings,
            ...parsed,
            provider: parsed.provider || defaultSettings.provider,
            model: parsed.model || defaultSettings.model
          };
        }
      } catch (e) {
        console.error('Failed to parse saved API settings', e);
      }
    }
    return defaultSettings;
  });

  React.useEffect(() => {
    localStorage.setItem('manga_translator_api_settings', JSON.stringify(apiSettings));
  }, [apiSettings]);

  const getModelsForProvider = (provider: string) => {
    switch (provider) {
      case 'gemini': return ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'];
      case 'openai': return ['gpt-4o', 'gpt-4o-mini', 'o1-preview'];
      case 'anthropic': return ['claude-3-5-sonnet-latest', 'claude-3-opus-latest', 'claude-3-haiku-latest'];
      case 'local': return ['Offline Teks & Jenis (On-Device)'];
      default: return [];
    }
  };
  const [fontSettings, setFontSettings] = useState(() => {
    const defaultFontSettings = {
      sizeMultiplier: 1.0,
      weight: 'bold',
      fontFamily: '"Comic Neue", cursive',
      showSettings: false,
      outline: false,
      useAiFont: true,
      bgOpacity: 1.0,
      boxPadding: 0,
      autoExpandBlocks: false
    };
    const saved = localStorage.getItem('manga_translator_font_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return {
            ...defaultFontSettings,
            ...parsed
          };
        }
      } catch (e) {
        console.error('Failed to parse saved font settings', e);
      }
    }
    return defaultFontSettings;
  });

  React.useEffect(() => {
    localStorage.setItem('manga_translator_font_settings', JSON.stringify(fontSettings));
  }, [fontSettings]);
  const [performanceSettings, setPerformanceSettings] = useState({
    gpuAcceleration: true,
    lowLatency: false,
    autoCleanText: true
  });
  const [showTranslatedText, setShowTranslatedText] = useState(true);
  const zipCancellationRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editShowOriginal, setEditShowOriginal] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [currentImgSize, setCurrentImgSize] = useState<{ w: number; h: number } | null>(null);
  const [drawingBox, setDrawingBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [drawTool, setDrawTool] = useState<'select' | 'text' | 'eraser'>('select');
  const [keymap, setKeymap] = useState<Record<string, string>>(() => loadKeymap());
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [correctionCount, setCorrectionCount] = useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrentImgSize(null);
  }, [currentIndex, activeBatchId]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const newBatches: Batch[] = [];

    for (const file of acceptedFiles) {
      const isZip = file.type === 'application/zip' || 
                   file.name.endsWith('.zip') || 
                   file.name.endsWith('.cbz');
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      
      const batchId = Math.random().toString(36).substr(2, 9);
      const batchName = file.name.replace(/\.[^/.]+$/, "");
      
      if (isZip) {
        try {
          const batchPages: MangaPage[] = [];
          const zip = new JSZip();
          const content = await zip.loadAsync(file);
          const entries = Object.entries(content.files).filter(([name, entry]) => 
            !entry.dir && /\.(jpe?g|png|webp)$/i.test(name)
          );
          
          if (entries.length === 0) {
            alert(`Tidak ada file gambar (JPG, PNG, WEBP) yang ditemukan di dalam archive "${file.name}".`);
          } else {
            entries.sort((nameA, nameB) => nameA[0].localeCompare(nameB[0], undefined, { numeric: true }));

            for (const [name, entry] of entries) {
              const extension = name.split('.').pop()?.toLowerCase();
              const mimeType = extension === 'png' ? 'image/png' : (extension === 'webp' ? 'image/webp' : 'image/jpeg');
              const uint8array = await entry.async('uint8array');
              const pageId = Math.random().toString(36).substr(2, 9);
              
              blobCache.current.set(pageId, uint8array);

              const blob = new Blob([uint8array], { type: mimeType });
              batchPages.push({
                id: pageId,
                originalUrl: URL.createObjectURL(blob),
                name: name,
                mimeType: mimeType,
                status: 'pending',
                selected: false
              });
            }

            newBatches.push({
              id: batchId,
              name: batchName,
              pages: batchPages,
              status: 'idle',
              progress: 0,
              type: 'zip',
              zipFileName: batchName
            });
          }
        } catch (zipErr: any) {
          console.warn(`File archive ZIP/CBZ (${file.name}) tidak dapat dibaca:`, zipErr);
          const errMsg = zipErr?.message?.includes("end of central directory") || zipErr?.message?.includes("Corrupted zip")
            ? `File archive "${file.name}" tidak dapat dibaca sebagai ZIP. Kemungkinan file terunduh tidak sempurna, berformat RAR/7z/CBR yang diubah namanya, atau file terproteksi. Silakan ekstrak file terlebih dahulu atau unggah file berformat ZIP valid.`
            : `Gagal membaca file archive "${file.name}": ${zipErr?.message || zipErr}`;
          alert(errMsg);
        }
      } else if (isPdf) {
        const batchPages: MangaPage[] = [];
        try {
          const pdfjs = (window as any).pdfjsLib;
          if (!pdfjs) {
            throw new Error('Pustaka PDF.js tidak terdeteksi. Silakan segarkan halaman.');
          }

          const fileReader = new FileReader();
          const pdfData = await new Promise<ArrayBuffer>((resolveReader, rejectReader) => {
            fileReader.onload = () => resolveReader(fileReader.result as ArrayBuffer);
            fileReader.onerror = () => rejectReader(fileReader.error);
            fileReader.readAsArrayBuffer(file);
          });

          const loadingTask = pdfjs.getDocument({ data: pdfData });
          const pdf = await loadingTask.promise;
          const numPages = pdf.numPages;

          for (let i = 1; i <= numPages; i++) {
            const pageObj = await pdf.getPage(i);
            // Render on highly accurate 2.0 scale for crisp text detection / OCR
            const viewport = pageObj.getViewport({ scale: 2.0 });
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            if (ctx) {
              await pageObj.render({ canvasContext: ctx, viewport: viewport }).promise;
              
              const blob = await new Promise<Blob | null>((resolveBlob) => {
                canvas.toBlob((b) => resolveBlob(b), 'image/jpeg', 0.9);
              });

              if (blob) {
                const buffer = await blob.arrayBuffer();
                const pageId = Math.random().toString(36).substr(2, 9);
                blobCache.current.set(pageId, new Uint8Array(buffer));

                batchPages.push({
                  id: pageId,
                  originalUrl: URL.createObjectURL(blob),
                  name: `Halaman ${i}`,
                  mimeType: 'image/jpeg',
                  status: 'pending',
                  selected: false
                });
              }
            }
          }

          if (batchPages.length > 0) {
            newBatches.push({
              id: batchId,
              name: batchName,
              pages: batchPages,
              status: 'idle',
              progress: 0,
              type: 'zip',
              zipFileName: batchName
            });
          }
        } catch (error: any) {
          console.error("Gagal membaca dokumen PDF:", error);
          alert(`Gagal memuat file PDF: ${error.message || error}`);
        }
      } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name)) {
        // Collect individual images into one "Uploaded Images" batch if not already handled
        const imageBatch = newBatches.find(b => b.type === 'images');
        const pageId = Math.random().toString(36).substr(2, 9);
        
        const buffer = await file.arrayBuffer();
        blobCache.current.set(pageId, new Uint8Array(buffer));

        const page: MangaPage = {
          id: pageId,
          originalUrl: URL.createObjectURL(file),
          name: file.name,
          mimeType: file.type || 'image/jpeg',
          status: 'pending',
          selected: false
        };

        if (imageBatch) {
          imageBatch.pages.push(page);
        } else {
          newBatches.push({
            id: batchId,
            name: "Uploaded Images",
            pages: [page],
            status: 'idle',
            progress: 0,
            type: 'images'
          });
        }
      }
    }

    setBatches(prev => {
      let updated = [...prev];
      
      // Process images batches by appending pages to the existing state-level 'images' batch if it exists
      const newImagesBatch = newBatches.find(b => b.type === 'images');
      const otherNewBatches = newBatches.filter(b => b.type !== 'images');
      
      if (newImagesBatch) {
        const existingImagesBatch = updated.find(b => b.type === 'images');
        if (existingImagesBatch) {
          existingImagesBatch.pages = [...existingImagesBatch.pages, ...newImagesBatch.pages];
        } else {
          updated.push(newImagesBatch);
        }
      }
      
      updated = [...updated, ...otherNewBatches];

      if (!activeBatchId && updated.length > 0) {
        setActiveBatchId(updated[0].id);
      }
      return updated;
    });
  }, [activeBatchId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp'],
      'application/zip': ['.zip', '.cbz'],
      'application/pdf': ['.pdf']
    },
    multiple: true
  } as any);

  const centralDropzone = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp'],
      'application/zip': ['.zip', '.cbz'],
      'application/pdf': ['.pdf']
    },
    multiple: true
  } as any);

  useEffect(() => {
    let dragCounter = 0;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dragCounter++;
        setIsWindowDragging(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        dragCounter--;
        if (dragCounter <= 0) {
          setIsWindowDragging(false);
        }
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsWindowDragging(false);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          onDrop(files);
        }
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [onDrop]);

  const removeBatch = (id: string) => {
    setBatches(prev => {
      const filtered = prev.filter(b => b.id !== id);
      if (activeBatchId === id) {
        setActiveBatchId(filtered.length > 0 ? filtered[0].id : null);
      }
      return filtered;
    });
  };

  const removePage = (id: string) => {
    setPages(prev => {
      const filtered = prev.filter(p => p.id !== id);
      if (currentIndex >= filtered.length && filtered.length > 0) {
        setCurrentIndex(filtered.length - 1);
      }
      return filtered;
    });
  };

  const callTranslateWithRetry = async (
    provider: string,
    model: string,
    contents: any,
    config?: any,
    customKey?: string,
    onRateLimitRetry?: (delayMs: number, attempt: number, maxRetries: number, isStartingServer?: boolean) => void,
    signal?: AbortSignal
  ): Promise<any> => {
    let targetProvider = provider;
    let targetModel = model;
    let targetKey = customKey;

    if (provider === 'local') {
      targetProvider = 'gemini';
      targetModel = 'gemini-3.1-flash-lite';
      targetKey = '';
    }

    const maxRetries = 5;
    let attempt = 0;
    let currentModel = targetModel;
    let hasAttemptedFallback = false;

    const execute = async (): Promise<any> => {
      try {
        const response = await apiFetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: signal || abortControllerRef.current?.signal,
          body: JSON.stringify({
            provider: targetProvider,
            model: currentModel,
            contents,
            config: (targetProvider === 'openai' || targetProvider === 'custom') ? { ...config, responseMimeType: undefined } : config,
            customKey: targetKey,
            customBaseURL: apiSettings.customBaseURL
          })
        });

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text();
          let bodySnippet = text.substring(0, 300).trim();
          if (text.includes('<title>')) {
            const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
              bodySnippet = `Page: ${titleMatch[1].trim()}`;
            }
          }
          throw new Error(`Server returned non-JSON response (HTTP ${response.status}). ${bodySnippet || 'Body is empty'}`);
        }

        const data = await response.json();

        if (!response.ok) {
          const errorMsg = data.error || `HTTP error! status: ${response.status}`;
          let errorDetails = '';
          if (data.details) {
            errorDetails = typeof data.details === 'object' ? JSON.stringify(data.details) : String(data.details);
          }
          const fullMessage = `[${response.status}] ${errorMsg} ${errorDetails}`;
          const err: any = new Error(fullMessage);
          err.status = response.status;
          err.retrySeconds = data.retrySeconds;
          throw err;
        }

        return data;
      } catch (error: any) {
        const errorStr = error.message || JSON.stringify(error);
        const isAbort = error.name === 'AbortError' || 
                        errorStr.toLowerCase().includes('abort') || 
                        errorStr.toLowerCase().includes('cancel') ||
                        errorStr.includes('signal is aborted');
                        
        if (isAbort) {
          const abortErr = new Error('Translation stopped');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const isRateLimit = error?.status === 429 || errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED') || error?.status === 'RESOURCE_EXHAUSTED';
        const isQuotaExceeded = errorStr.includes('quota') || errorStr.includes('Quota exceeded') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('exceeded your current quota');
        const isStartingServer = errorStr.includes('non-JSON response') || errorStr.includes('Starting Server');
        const isTransient = isRateLimit || isStartingServer || errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('experiencing high demand') || errorStr.includes('overloaded') || errorStr.includes('Service Unavailable') || errorStr.includes('temporary');

        const isDailyQuota = errorStr.includes('GenerateRequestsPerDay') && !errorStr.includes('retry in');

        // Parse "Please retry in X.Xs" or similar format
        let retrySeconds = error?.retrySeconds || 0;
        if (!retrySeconds) {
          const matchSeconds = errorStr.match(/retry in\s+([0-9.]+)\s*s/i);
          if (matchSeconds && matchSeconds[1]) {
            retrySeconds = parseFloat(matchSeconds[1]);
          } else {
            const matchDelay = errorStr.match(/"retryDelay"\s*:\s*"(\d+)\s*s?"/i);
            if (matchDelay && matchDelay[1]) {
              retrySeconds = parseFloat(matchDelay[1]);
            }
          }
        }

        if (targetProvider === 'gemini' && (isQuotaExceeded || isRateLimit) && !hasAttemptedFallback) {
          hasAttemptedFallback = true;
          const nextModel = currentModel === 'gemini-3.5-flash' || currentModel === 'gemini-3.1-pro-preview' 
            ? 'gemini-3.1-flash-lite' 
            : 'gemini-3.1-flash-lite';
          console.warn(`[AI Model Fallback] Rate limit on model ${currentModel}. Automatically falling back to ${nextModel}...`);
          currentModel = nextModel;
          attempt = 0; // Reset attempts for fallback model
          return execute();
        }

        const isAcceptableWait = retrySeconds === 0 || retrySeconds <= 45;

        if (isTransient && isAcceptableWait && !isDailyQuota && attempt < maxRetries && translationRef.current) {
          attempt++;

          const delay = retrySeconds > 0
            ? Math.min(retrySeconds * 1000 + 1000, 45000) // retry time + 1s buffer (max 45s)
            : Math.min(Math.pow(2, attempt) * 2000 + Math.random() * 1000, 30000); // progressive backoff

          console.warn(`[AI Route Retry] Rate limit hit for model ${currentModel}. Waiting ${Math.round(delay / 1000)}s (Attempt ${attempt}/${maxRetries})...`);

          if (onRateLimitRetry) {
            onRateLimitRetry(delay, attempt, maxRetries, isStartingServer);
          }

          await new Promise(resolve => setTimeout(resolve, delay));
          if (!translationRef.current) throw new Error('Translation stopped');
          return execute();
        }
        throw error;
      }
    };

    return execute();
  };

  const translatePage = async (
    page: MangaPage, 
    batchId?: string, 
    mode: 'full' | 'ocr_only' | 'translate_only' = 'full',
    force: boolean = false
  ): Promise<boolean> => {
    const targetBatchId = batchId || activeBatchId;
    if (!targetBatchId) return false;

    const pageUpdater = (updater: (prev: MangaPage[]) => MangaPage[]) => updatePagesInBatch(targetBatchId, updater);

    if (page.status === 'completed' && mode !== 'translate_only' && !force) return true;
    if (page.status === 'translating') return false;

    // Reactivate global translation state flags
    translationRef.current = true;
    setIsTranslating(true);

    if (!translationEnabled) {
      pageUpdater(prev => prev.map(p => p.id === page.id ? { ...p, status: 'completed' } : p));
      return true;
    }

    // Set up page-specific abort controller
    const pageController = new AbortController();
    pageAbortControllersRef.current.set(page.id, pageController);

    pageUpdater(prev => prev.map(p => p.id === page.id ? { 
      ...p, 
      status: 'translating', 
      error: undefined,
      ...(force ? { isCleaned: false, isTranslated: false, translatedUrl: undefined } : {})
    } : p));

    const executeTranslation = async (): Promise<TextBlock[]> => {
      if (!translationRef.current) throw new Error('Translation stopped');

      const runLocalTranslation = async (): Promise<TextBlock[]> => {
        const sig = pageController.signal;

        async function translateWithFreeEngine(text: string): Promise<string> {
          const trimmed = text.trim();
          if (!trimmed) return '';
          try {
            const res = await apiFetch('/api/free-translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: sig,
              body: JSON.stringify({
                text: trimmed,
                from: sourceLanguage === 'auto' ? 'auto' : sourceLanguage,
                to: 'id'
              })
            });
            if (res.ok) {
              const data = await res.json();
              if (data.translatedText) {
                return data.translatedText;
              }
            }
          } catch (e) {
            console.warn(`[Free Translate Web API Fallback] Failed for text "${trimmed}":`, e);
          }
          return translateTextLocal(trimmed);
        }

        const LOCAL_DICT: Record<string, string> = {
          "おい": "Oi!",
          "おい！": "Oi!",
          "おーい": "Hei!",
          "お前": "Kau...",
          "なんでもない": "Bukan apa-apa.",
          "なん基本": "Bukan apa-apa.",
          "何これ": "Apa ini?",
          "なにこれ": "Apa ini?",
          "これは何": "Apa ini?",
          "…夢か": "...Apakah ini mimpi?",
          "夢か": "Apakah ini mimpi?",
          "大学行く支度しないと源司がくるな": "Aku harus bersiap pergi ke kampus sebelum Genji datang.",
          "母乳を捧げるってなんだよオレ、男なのに…": "Apa maksudnya menyusui... Padahal aku ini laki-laki...",
          "おい！何をしているんだ？": "Hei! Apa yang sedang kau lakukan?",
          "そんなの、嘘だろ…": "Itu tidak mungkin, kan...?",
          "早く逃げないと、大変なことになる！": "Kita harus cepat bersiap-siap!",
          "助けて": "Tolong!",
          "ありがとう": "Terima kasih!",
          "すみません": "Permisi / Maaf",
          "バカ": "Bodoh!",
          "ちょっと": "Tunggu sebentar",
          "行くぞ": "Ayo pergi!",
          "だめ": "Jangan / Tidak boleh",
          "これ": "Ini",
          "それ": "Itu",
          "私": "Aku",
          "俺": "Aku",
          "僕": "Aku"
        };

        const translateTextLocal = (text: string): string => {
          const cleanText = text.trim().replace(/[！？。、… \n\t]/g, '');
          
          if (!cleanText) return '';
          
          // Check exact clean match in dictionary keys
          for (const key of Object.keys(LOCAL_DICT)) {
            const cleanKey = key.replace(/[！？。、… \n\t]/g, '');
            if (cleanText === cleanKey) {
              return LOCAL_DICT[key];
            }
          }

          // Check partial/inclusion match
          for (const key of Object.keys(LOCAL_DICT)) {
            const cleanKey = key.replace(/[！？。、… \n\t]/g, '');
            if (cleanText.includes(cleanKey) || cleanKey.includes(cleanText)) {
              return LOCAL_DICT[key];
            }
          }

          // Default word-level replace for English/Indonesian fallbacks
          let trans = text.trim();
          const wordsMap: Record<string, string> = {
            "hello": "halo",
            "what": "apa",
            "why": "kenapa",
            "no": "tidak",
            "yes": "ya",
            "wait": "tunggu",
            "help": "tolong",
            "stop": "berhenti",
            "thanks": "terima kasih"
          };
          Object.keys(wordsMap).forEach(w => {
            const rx = new RegExp(`\\b${w}\\b`, 'gi');
            trans = trans.replace(rx, wordsMap[w]);
          });
          return trans;
        };

        const existingBlocks = page.textBlocks || [];
        if (existingBlocks.length > 0 && !force && mode === 'translate_only') {
          const processed = await Promise.all(
            existingBlocks.map(async (block) => {
              if (block.translatedText && block.translatedText !== 'New Text' && block.translatedText !== 'Teks Baru' && !force) {
                return block;
              }
              const transText = await translateWithFreeEngine(block.originalText || '');
              return {
                ...block,
                translatedText: transText
              };
            })
          );
          return processed;
        }

        // On-Device Speech Balloon Connected Component Detector (100% offline & client-side!)
        const detectSpeechBalloonsLocally = (imgElement: HTMLImageElement): { x: number, y: number, w: number, h: number }[] => {
          const canvas = document.createElement('canvas');
          const targetW = 300;
          const targetH = Math.round(300 * (imgElement.naturalHeight / imgElement.naturalWidth || 1.3));
          canvas.width = targetW;
          canvas.height = targetH;

          const ctx = canvas.getContext('2d');
          if (!ctx) return [];
          ctx.drawImage(imgElement, 0, 0, targetW, targetH);
          const imgData = ctx.getImageData(0, 0, targetW, targetH);
          const data = imgData.data;

          // Find threshold of lightness dynamically (supports yellowed newsprint papers too!)
          let maxLuma = 0;
          const totalPixels = targetW * targetH;
          for (let i = 0; i < data.length; i += 40) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            if (luma > maxLuma) maxLuma = luma;
          }
          const threshold = Math.max(215, maxLuma - 20);

          const grid = new Uint8Array(totalPixels);
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            grid[i/4] = luma >= threshold ? 1 : 0;
          }

          const visited = new Uint8Array(totalPixels);
          const boxes: { x1: number, y1: number, x2: number, y2: number, size: number }[] = [];

          // Scan coordinates with a fast scanning step
          const scanStep = 2;
          for (let y = 10; y < targetH - 10; y += scanStep) {
            for (let x = 10; x < targetW - 10; x += scanStep) {
              const idx = y * targetW + x;
              if (grid[idx] === 1 && !visited[idx]) {
                // BFS Flood Fill to cluster white pixels
                let minX = x;
                let maxX = x;
                let minY = y;
                let maxY = y;
                let size = 0;

                const queue: number[] = [idx];
                visited[idx] = 1;

                while (queue.length > 0 && size < 10000) {
                  const curr = queue.shift()!;
                  const cx = curr % targetW;
                  const cy = Math.floor(curr / targetW);
                  size++;

                  if (cx < minX) minX = cx;
                  if (cx > maxX) maxX = cx;
                  if (cy < minY) minY = cy;
                  if (cy > maxY) maxY = cy;

                  const neighbors = [
                    curr - 1,
                    curr + 1,
                    curr - targetW,
                    curr + targetW
                  ];

                  for (const nId of neighbors) {
                    if (nId >= 0 && nId < totalPixels) {
                      const nx = nId % targetW;
                      const ny = Math.floor(nId / targetW);
                      if (nx >= 2 && nx < targetW - 2 && ny >= 2 && ny < targetH - 2) {
                        if (grid[nId] === 1 && !visited[nId]) {
                          visited[nId] = 1;
                          queue.push(nId);
                        }
                      }
                    }
                  }
                }

                const width = maxX - minX;
                const height = maxY - minY;

                // Speech bubbles are inside panels and rarely touch the outer edges of the page/canvas
                const touchesEdge = (minX <= 4 || maxX >= targetW - 4 || minY <= 4 || maxY >= targetH - 4);
                const aspect = width / height;
                const density = size / (width * height);

                const minBubbleW = Math.round(targetW * 0.05);
                const minBubbleH = Math.round(targetH * 0.05);
                const maxBubbleW = Math.round(targetW * 0.35);
                const maxBubbleH = Math.round(targetH * 0.35);

                if (!touchesEdge && aspect >= 0.35 && aspect <= 2.8 && density >= 0.45) {
                  if (width >= minBubbleW && height >= minBubbleH && width <= maxBubbleW && height <= maxBubbleH) {
                    boxes.push({ x1: minX, y1: minY, x2: maxX, y2: maxY, size });
                  }
                }
              }
            }
          }

          const merged: { x: number, y: number, w: number, h: number }[] = [];
          for (const box of boxes) {
            const rx1 = (box.x1 / targetW) * 1000;
            const rx2 = (box.x2 / targetW) * 1000;
            const ry1 = (box.y1 / targetH) * 1000;
            const ry2 = (box.y2 / targetH) * 1000;

            let overlap = false;
            for (let mIdx = 0; mIdx < merged.length; mIdx++) {
              const m = merged[mIdx];
              const mx1 = m.x;
              const mx2 = m.x + m.w;
              const my1 = m.y;
              const my2 = m.y + m.h;

              const ix1 = Math.max(rx1, mx1);
              const ix2 = Math.min(rx2, mx2);
              const iy1 = Math.max(ry1, my1);
              const iy2 = Math.min(ry2, my2);

              if (ix1 < ix2 && iy1 < iy2) {
                const overlapArea = (ix2 - ix1) * (iy2 - iy1);
                const mArea = m.w * m.h;
                const bArea = (rx2 - rx1) * (ry2 - ry1);
                
                if (overlapArea / Math.min(mArea, bArea) > 0.3) {
                  const nx1 = Math.min(rx1, mx1);
                  const ny1 = Math.min(ry1, my1);
                  const nx2 = Math.max(rx2, mx2);
                  const ny2 = Math.max(ry2, my2);
                  
                  m.x = nx1;
                  m.y = ny1;
                  m.w = nx2 - nx1;
                  m.h = ny2 - ny1;
                  overlap = true;
                  break;
                }
              }
            }
            if (!overlap) {
              merged.push({
                x: rx1,
                y: ry1,
                w: rx2 - rx1,
                h: ry2 - ry1
              });
            }
          }

          return merged.filter(m => m.w >= 25 && m.h >= 20 && m.w <= 950 && m.h <= 950);
        };

        const detectBalloons = (): Promise<TextBlock[]> => {
          return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = page.originalUrl;
            img.onload = async () => {
              try {
                const balloons = detectSpeechBalloonsLocally(img);
                
                const mappedBlocks: TextBlock[] = [];
                for (const b of balloons) {
                  if (sig.aborted) break;

                  // Create dynamic cropped canvas representing each speech balloon
                  const cropCanvas = document.createElement('canvas');
                  const actualX = (b.x / 1000) * img.naturalWidth;
                  const actualY = (b.y / 1000) * img.naturalHeight;
                  const actualW = (b.w / 1000) * img.naturalWidth;
                  const actualH = (b.h / 1000) * img.naturalHeight;

                  cropCanvas.width = actualW;
                  cropCanvas.height = actualH;

                  const cropCtx = cropCanvas.getContext('2d');
                  if (cropCtx) {
                    cropCtx.drawImage(
                      img,
                      actualX, actualY, actualW, actualH,
                      0, 0, actualW, actualH
                    );
                  }

                  // Establish language parameters based on manga source language state
                  let langCode = 'jpn'; // fallback to Japanese
                  if (sourceLanguage === 'en') langCode = 'eng';
                  else if (sourceLanguage === 'ko') langCode = 'kor';
                  else if (sourceLanguage === 'zh') langCode = 'chi_sim';

                  let detectedText = '';
                  try {
                    // Use Page Segmentation Mode (PSM) '5' for vertical text or '6' for horizontal text
                    const psm = (langCode === 'jpn' || langCode === 'chi_sim') ? '5' : '6';
                    const ocrRes = await Tesseract.recognize(cropCanvas, langCode, {
                      tessedit_pageseg_mode: psm
                    } as any);
                    
                    const rawText = ocrRes.data.text || '';
                    if (langCode === 'jpn' || langCode === 'chi_sim') {
                      const cleanedRaw = rawText.replace(/[|Il1i\/\\_~°\+=\*<>#@\[\]\{\}\(\)「」『』]/g, '');
                      detectedText = cleanedRaw.replace(/\s+/g, '').trim();
                    } else {
                      const cleanedRaw = rawText.replace(/[|i\/\\_~°\+=\*<>#@\[\]\{\}\(\)]/g, '');
                      detectedText = cleanedRaw.replace(/\s+/g, ' ').trim();
                    }
                  } catch (ocrErr) {
                    console.error("Tesseract OCR single bubble error, continuing:", ocrErr);
                  }

                  if (!detectedText || detectedText.length < 1) {
                    continue;
                  }

                  let translatedText = '';
                  if (mode === 'ocr_only') {
                    translatedText = detectedText;
                  } else {
                    translatedText = await translateWithFreeEngine(detectedText);
                  }

                  mappedBlocks.push({
                    id: Math.random().toString(36).substr(2, 9),
                    originalText: detectedText,
                    translatedText: translatedText || detectedText,
                    x: b.x,
                    y: b.y,
                    width: b.w,
                    height: b.h,
                    fontSize: Math.max(12, Math.round(Math.min(b.w, b.h) * 0.16)),
                    fontStyle: "normal",
                    isBalloon: true,
                    type: 'auto'
                  });
                }
                
                resolve(mappedBlocks);
              } catch (err) {
                console.error("Local speech bubble detection failed:", err);
                resolve([]);
              }
            };
            img.onerror = () => {
              resolve([]);
            };
          });
        };

        const detectedBlocks = await detectBalloons();

        if (detectedBlocks.length === 0 && translationRef.current) {
          // Full-page Tesseract OCR fallback for pages without clear speech bubbles
          let langCode = 'jpn';
          if (sourceLanguage === 'en') langCode = 'eng';
          else if (sourceLanguage === 'ko') langCode = 'kor';
          else if (sourceLanguage === 'zh') langCode = 'chi_sim';

          try {
            const fullImg = new Image();
            fullImg.crossOrigin = 'anonymous';
            fullImg.src = page.originalUrl;
            await new Promise((res) => { fullImg.onload = res; fullImg.onerror = res; });

            if (fullImg.naturalWidth && fullImg.naturalHeight && !sig.aborted) {
              const ocrRes = await Tesseract.recognize(fullImg, langCode);
              const lines = (ocrRes.data as any).lines || [];
              for (const line of lines) {
                if (sig.aborted) break;
                const raw = line.text || '';
                const cleaned = raw.replace(/[|i\/\\_~°\+=\*<>#@\[\]\{\}\(\)]/g, '').trim();
                if (cleaned.length >= 1) {
                  const bbox = line.bbox;
                  const x = (bbox.x1 / fullImg.naturalWidth) * 1000;
                  const y = (bbox.y1 / fullImg.naturalHeight) * 1000;
                  const w = ((bbox.x2 - bbox.x1) / fullImg.naturalWidth) * 1000;
                  const h = ((bbox.y2 - bbox.y1) / fullImg.naturalHeight) * 1000;
                  const transText = await translateWithFreeEngine(cleaned);
                  detectedBlocks.push({
                    id: Math.random().toString(36).substr(2, 9),
                    originalText: cleaned,
                    translatedText: transText,
                    x,
                    y,
                    width: Math.max(80, w),
                    height: Math.max(30, h),
                    fontSize: Math.max(12, Math.round(h * 0.4)),
                    fontStyle: "normal",
                    isBalloon: false,
                    type: 'auto'
                  });
                }
              }
            }
          } catch (err) {
            console.warn("Full page Tesseract fallback error:", err);
          }
        }

        return detectedBlocks;
      };

      const runCloudTextOnlyTranslation = async (blocks: TextBlock[]): Promise<TextBlock[]> => {
        const textToTranslate = blocks.map(b => b.originalText || '').filter(Boolean);
        if (textToTranslate.length === 0) {
          return blocks.map(b => ({ ...b, translatedText: b.translatedText || b.originalText }));
        }

        let key = '';
        if (apiSettings.provider === 'openai') {
          key = apiKeys.openai || process.env.OPENAI_API_KEY || '';
        } else if (apiSettings.provider === 'anthropic') {
          key = apiKeys.anthropic || process.env.ANTHROPIC_API_KEY || '';
        } else if (apiSettings.provider === 'custom') {
          key = apiKeys.custom || process.env.OPENAI_API_KEY || '';
        } else {
          key = apiKeys.gemini || process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY || '';
        }

        if (!key) {
          console.warn("No cloud key found for text-only translation, falling back to local.");
          return runLocalTranslation();
        }

        const prompt = `Translate the following list of manga/comic dialogue texts into natural, engaging Indonesian comic/webtoon style colloquial dialogue (bahasa santai komik). Do not translate titles/idioms literally, make them fit standard Indonesian comic translation conventions.
Source language: ${sourceLanguage === 'auto' ? 'auto-detect (ja/ko/zh/en)' : sourceLanguage}. Translate meaning in context (not word-for-word); keep honorifics only when they matter; never translate CJK idioms literally.
Maintain the exact same order. Return a JSON array of strings containing the translations, in the exact same index order.

Lines to translate:
${JSON.stringify(textToTranslate)}

Return EXACTLY a JSON array of strings, like:
["Terjemahan 1", "Terjemahan 2", ...]`;

        try {
          const res = await apiFetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: apiSettings.provider,
              model: apiSettings.provider === 'custom' ? apiSettings.customModel : apiSettings.model,
              contents: [{ parts: [{ text: prompt }] }],
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: "ARRAY",
                  items: { type: "STRING" }
                }
              },
              customKey: key
            }),
            signal: pageController.signal
          });

          if (!res.ok) {
            throw new Error(`Text-only translation failed: ${res.statusText}`);
          }

          const data = await res.json();
          const resultText = data.text || (data.candidates && data.candidates[0]?.content?.parts[0]?.text) || '[]';
          const translatedArray = cleanAndParseJSON(resultText);

          let transIdx = 0;
          return blocks.map(b => {
            if (b.originalText) {
              const trans = translatedArray[transIdx] || b.originalText;
              transIdx++;
              return {
                ...b,
                translatedText: trans,
                isCleanOnly: false
              };
            }
            return b;
          });
        } catch (e) {
          console.error("Cloud text-only translation error, falling back to local:", e);
          return runLocalTranslation();
        }
      };

      if (mode === 'translate_only') {
        const existingBlocks = page.textBlocks || [];
        if (existingBlocks.length === 0) {
          return [];
        }
        if (apiSettings.provider === 'local') {
          return runLocalTranslation();
        } else {
          return runCloudTextOnlyTranslation(existingBlocks);
        }
      }

      if (apiSettings.provider === 'local') {
        return runLocalTranslation();
      }
      
      const data = blobCache.current.get(page.id);
      let blob: Blob;

      if (data) {
        blob = new Blob([data], { type: page.mimeType });
      } else {
        try {
          const response = await fetch(page.originalUrl, { signal: pageController.signal });
          if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
          blob = await response.blob();
        } catch (e: any) {
          if (e.name === 'AbortError') throw e;
          console.error('Image fetch error:', e);
          throw new Error(`Failed to load image data: ${e.message || 'Check your connection'}`);
        }
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      if (!translationRef.current) throw new Error('Translation stopped');

      if (apiSettings.provider === 'local') {
        return runLocalTranslation();
      }

      let langGuidelines = '';
      if (sourceLanguage === 'ja') {
        langGuidelines = `
- SOURCE LANGUAGE: Japanese (Manga)
- TRANSLATION CONVENTIONS: Translate dialogue contextually into highly natural, engaging Indonesian comic/webtoon language (bahasa santai/gaul komik). Keep manga honorifics like "-san", "-sama", "-chan", "-kun" only if they convey crucial character relationships; otherwise, translate them comfortably.
- DIALOGUE STYLE: Never use stiff formal words like 'saya' or 'anda' unless a formal, robotic, or subservient character is speaking. Use 'aku', 'kamu', 'kau', 'dia', or friendly slang. Inject particles like 'sih', 'kok', 'lah', 'dong', 'ya' so speech flows beautifully.`;
      } else if (sourceLanguage === 'ko') {
        langGuidelines = `
- SOURCE LANGUAGE: Korean (Manhwa/Webtoon)
- TRANSLATION CONVENTIONS: Localize internet, gaming, dungeon, or system text contextually (e.g., 'guild', 'quest', 'level up' can remain standard localizations). Translate titles like Oppa, Hyung, Noona, Unnie into natural Indonesian (e.g., 'Kak', 'Kakak') or keep them if they convey essential manhwa flavor.
- DIALOGUE STYLE: Make conversational dialogues lively, action-oriented, and active.`;
      } else if (sourceLanguage === 'zh') {
        langGuidelines = `
- SOURCE LANGUAGE: Chinese (Manhua)
- TRANSLATION CONVENTIONS: Manhua heavily features 4-character idioms (Chengyu), cultivation protocols, or wuxia terms. Never translate these literally! Find natural Indonesian dialogue alternatives or equivalent Indonesian idioms.
- DIALOGUE STYLE: Keep the atmosphere respectful and exciting, avoiding direct mechanical word-for-word translation.`;
      } else if (sourceLanguage === 'en') {
        langGuidelines = `
- SOURCE LANGUAGE: English
- TRANSLATION CONVENTIONS: Avoid hyper-literal translations (e.g., do not translate expressions like "What are you up to?" as "Apa yang sedang kamu lakukan?", replace with "Lagi ngapain?" or "Ada apa?").
- DIALOGUE STYLE: Ensure standard conversational colloquial Indonesian.`;
      } else {
        langGuidelines = `
- SOURCE LANGUAGE: Auto-detect (Japanese, Korean, Chinese, or English)
- LOCALIZATION RULES: Localize action dialogues, jokes, or intimate lines using highly fluent Indonesian manga conventions. Avoid stiff or robotic textbook style translations.`;
      }

      let scopePromptInstruction = '';
      if (translateScope === 'balloon') {
        scopePromptInstruction = `
        CRITICAL PRIORITY - TRANSLATE SPEECH BALLOONS ONLY: 
        - ONLY identify, extract, translate, and return text blocks that are INSIDE hand-drawn speech balloons/dialogue bubbles (where isBalloon=true). 
        - Completely IGNORE and EXCLUDE any narrator boxes, sound effects (SFX), marginal handwritten notes, splash texts, or floating text outside of speech bubbles. If there are no speech balloons on the page, return an empty array.`;
      }

      const batchPages = batches.find(b => b.id === targetBatchId)?.pages || [];
      const pageIdx = batchPages.findIndex(p => p.id === page.id);
      const prompt = buildPagePrompt({
        ocrOnly: mode === 'ocr_only',
        langGuidelines,
        scopeInstruction: scopePromptInstruction,
        literal: translationStyle !== 'natural',
        context: buildContext(pageIdx > 0 ? batchPages[pageIdx - 1].textBlocks : undefined),
        corrections: correctionsPrompt()
      });

      const aiParams: AIParams = {
        model: apiSettings.model,
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: page.mimeType || blob.type || 'image/jpeg', data: base64 } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          responseSchema: PAGE_SCHEMA
        }
      };

      try {
        const result = await callTranslateWithRetry(
          apiSettings.provider,
          apiSettings.provider === 'custom' ? apiSettings.customModel : apiSettings.model,
          aiParams.contents,
          aiParams.config,
          apiKeys[apiSettings.provider as keyof typeof apiKeys],
          (delay, currentAttempt, totalRetries, isStartingServer) => {
            const delaySecs = Math.round(delay / 1000);
            const errorMsg = isStartingServer
              ? `Server sedang dimulai (cold-start). Menunggu ${delaySecs} detik untuk mencoba kembali (Percobaan ${currentAttempt}/${totalRetries})...`
              : `Batas kuota terlampaui. Menunggu ${delaySecs} detik untuk mencoba kembali (Percobaan ${currentAttempt}/${totalRetries})...`;
            pageUpdater(prev => prev.map(p => p.id === page.id ? { 
              ...p, 
              error: errorMsg
            } : p));
          },
          pageController.signal
        );

        const resultText = result.text || '[]';
        let rawBlocks: any[] = cleanAndParseJSON(resultText);
        if (translateScope === 'balloon') {
          rawBlocks = rawBlocks.filter(b => b && (b.isBalloon === true || b.isBalloon === 'true' || b.isBalloon === 1 || b.isBalloon === '1'));
        }
        return normalizeBlocks(rawBlocks, { balloonOnly: translateScope === 'balloon' });
      } catch (error: any) {
        const errorStr = error.message || JSON.stringify(error);
        const isAbort = error.name === 'AbortError' || 
                        errorStr.toLowerCase().includes('abort') || 
                        errorStr.toLowerCase().includes('cancel') ||
                        errorStr.includes('signal is aborted');
                        
        if (isAbort) {
          const abortErr = new Error('Translation stopped');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const isQuotaOrRateLimit = errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('quota') || errorStr.includes('Quota exceeded') || errorStr.includes('exceeded your current quota');
        if (isQuotaOrRateLimit) {
          if (apiSettings.provider === 'local') {
            return runLocalTranslation();
          }
          throw new Error("Batas kuota Gemini terlampaui (HTTP 429). Silakan tunggu 1-2 menit sebelum mencoba lagi, atau masukkan API Key pribadi Anda di ⚙️ Pengaturan.");
        }
        
        if (errorStr.includes('Failed to fetch')) {
          throw new Error('Network error: Failed to connect to the translation service. Check your internet or ad-blocker.');
        }
        throw error;
      }
    };

    try {
      const textBlocks = await executeTranslation();
      if (!translationRef.current) return false;
      
      const rendered = await renderTranslatedPage(page, textBlocks, true);
      const translatedUrl = rendered.url;
      if (!translationRef.current) return false;

      pageUpdater(prev => prev.map(p => p.id === page.id ? { 
        ...p, 
        status: 'completed', 
        translatedUrl,
        textBlocks: rendered.blocks,
        isCleaned: mode === 'ocr_only' ? true : (mode === 'full' ? true : p.isCleaned),
        isTranslated: mode === 'translate_only' ? true : (mode === 'full' ? true : p.isTranslated)
      } : p));
      return true;
    } catch (error: any) {
      let errorMessage = error.message || 'Failed to translate';
      const errorStr = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
      const isAbort = error.name === 'AbortError' || 
                      errorStr.includes('AbortError') || 
                      errorStr.includes('Translation stopped') || 
                      errorStr.toLowerCase().includes('aborted') || 
                      errorStr.toLowerCase().includes('cancel') ||
                      errorStr.includes('signal is aborted');
      
      if (!isAbort) {
        console.warn('Translation process failed for page:', page.name, error);
      }
      
      if (errorStr.includes('Failed to fetch') || errorStr.includes('Network error')) {
        errorMessage = 'Network error: Connection to translation service failed. Check your internet connection or ad-blocker.';
      } else if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED')) {
        errorMessage = 'Batas kuota terlampaui (Rate Limit / Quota Exceeded). Silakan coba lagi beberapa saat, masukkan API Key pribadi Anda di panel Pengaturan, atau beralih ke Mode Translator Offline (Gratis) di Pengaturan.';
      } else if (errorStr.includes('credit balance is too low')) {
        errorMessage = 'Anthropic billing error: Credit balance too low. Please check your Anthropic account or switch providers.';
      } else if (errorStr.includes('401') || errorStr.includes('invalid_api_key')) {
        errorMessage = 'Invalid API key. Please check your settings.';
      } else if (isAbort) {
        pageUpdater(prev => prev.map(p => p.id === page.id ? { ...p, status: 'pending', error: undefined } : p));
        return false; // Ignore abort errors
      }
      
      pageUpdater(prev => prev.map(p => p.id === page.id ? { 
        ...p, 
        status: 'error', 
        error: errorMessage
      } : p));
      return false;
    } finally {
      pageAbortControllersRef.current.delete(page.id);
    }
  };

  const renderCacheRef = useRef<Map<string, PageCacheEntry>>(new Map());
  const imgCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const renderTranslatedPage = async (page: MangaPage, blocks: TextBlock[], fit = false): Promise<{ url: string; blocks: TextBlock[] }> => {
    try {
      let img = imgCacheRef.current.get(page.id);
      if (!img) {
        img = await loadImage(page, true);
        imgCacheRef.current.set(page.id, img);
        while (imgCacheRef.current.size > 4) imgCacheRef.current.delete(imgCacheRef.current.keys().next().value as string);
      }
      // Pastikan font sudah termuat sebelum mengukur teks (penyebab tata letak "acak" di render pertama)
      const families = new Set<string>([fontSettings.fontFamily, ...(blocks || []).map(b => b.fontFamily || '')].filter(Boolean));
      await Promise.all([...families].map(f => (document as any).fonts?.load(`bold 20px ${f}`).catch(() => null)));
      return renderPage(img, blocks, {
        autoClean: performanceSettings.autoCleanText,
        showText: showTranslatedText,
        fontFamily: fontSettings.fontFamily,
        weight: fontSettings.weight,
        sizeMultiplier: fontSettings.sizeMultiplier,
        outline: fontSettings.outline,
        bgOpacity: fontSettings.bgOpacity,
        boxPadding: fontSettings.boxPadding,
        autoExpand: fontSettings.autoExpandBlocks
      }, { pageId: page.id, cache: renderCacheRef.current, fit });
    } catch (e) {
      console.error('Failed to render page:', page.name, e);
      return { url: page.translatedUrl || page.originalUrl, blocks };
    }
  };

  const renderTranslatedImage = async (page: MangaPage, blocks: TextBlock[]): Promise<string> =>
    (await renderTranslatedPage(page, blocks)).url;

  // ───── Seleksi massal halaman (lintas proyek) ─────
  const lastSelectedRef = useRef<string | null>(null);
  const selectedPagesAll = batches.flatMap(b => b.pages.filter(p => p.selected).map(p => ({ batchId: b.id, page: p })));
  const clearPageSelection = () => setBatches(prev => prev.map(b => ({ ...b, pages: b.pages.map(p => (p.selected ? { ...p, selected: false } : p)) })));
  const retranslateSelected = async () => {
    if (isTranslating || selectedPagesAll.length === 0) return;
    const targets = [...selectedPagesAll];
    setIsTranslating(true);
    translationRef.current = true;
    abortControllerRef.current = new AbortController();
    try {
      for (const t of targets) {
        if (!translationRef.current) break;
        await translatePage(t.page, t.batchId, 'full', true);
        if (translationRef.current && apiSettings.provider !== 'local') await new Promise(r => setTimeout(r, 1500));
      }
      if (translationRef.current) confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
    } finally {
      setIsTranslating(false);
      translationRef.current = false;
    }
  };
  const deleteSelectedPages = () => {
    const n = selectedPagesAll.length;
    if (!n || !window.confirm(`Hapus ${n} halaman terpilih?`)) return;
    setBatches(prev => prev.map(b => ({ ...b, pages: b.pages.filter(p => !p.selected) })));
    setCurrentIndex(0);
  };

  const togglePageSelection = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (e?.shiftKey && lastSelectedRef.current) {
      const a = pages.findIndex(p => p.id === lastSelectedRef.current);
      const b = pages.findIndex(p => p.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setPages(prev => prev.map((p, i) => (i >= lo && i <= hi ? { ...p, selected: true } : p)));
        return;
      }
    }
    lastSelectedRef.current = id;
    setPages(prev => prev.map(p => (p.id === id ? { ...p, selected: !p.selected } : p)));
    return;
  };

  /** Selesaikan gambar kotak: alat Pilih = seleksi area (marquee); alat Teks/Eraser = buat blok baru */
  const finishDrawing = () => {
    const d = drawingBox;
    if (!d) return;
    const x = d.w < 0 ? d.x + d.w : d.x;
    const y = d.h < 0 ? d.y + d.h : d.y;
    const w = Math.abs(d.w);
    const h = Math.abs(d.h);
    if (drawTool === 'select') {
      if (w > 8 || h > 8) {
        const ids = (pages[currentIndex]?.textBlocks || [])
          .filter(b => b.x < x + w && b.x + b.width > x && b.y < y + h && b.y + b.height > y)
          .map(b => b.id);
        setSelectedBlockId(null);
        setSelectedBlockIds(ids);
      }
    } else if (w > 10 && h > 10) {
      const id = Math.random().toString(36).substr(2, 9);
      const nb: TextBlock =
        drawTool === 'eraser'
          ? { id, originalText: '', translatedText: '', x, y, width: w, height: h, type: 'manual', isCleanOnly: true, cleanShape: 'auto' }
          : { id, originalText: '', translatedText: 'Teks Baru', x, y, width: w, height: h, fontSize: 30, fontStyle: 'normal', type: 'manual', eraseMode: 'auto' };
      addBlockAndRender(nb);
      setDrawTool('select');
    }
    setDrawingBox(null);
  };

  /** Geser / ubah ukuran AREA HAPUS teks asli (kotak merah putus-putus) secara terpisah dari kotak teks */
  const startSrcDrag = (e: React.MouseEvent, b: TextBlock, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    if (!containerRef.current) return;
    pushHistory(true);
    const rect = containerRef.current.getBoundingClientRect();
    const follow = b.eraseFollow || b.srcX === undefined;
    const s0 = { x: follow ? b.x : b.srcX!, y: follow ? b.y : b.srcY!, w: follow ? b.width : b.srcW!, h: follow ? b.height : b.srcH! };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: MouseEvent) => {
      const dx = ((ev.clientX - x0) / rect.width) * 1000;
      const dy = ((ev.clientY - y0) / rect.height) * 1000;
      if (mode === 'move') {
        updateBlock(b.id, { srcX: clampNum(s0.x + dx, 0, 1000 - s0.w), srcY: clampNum(s0.y + dy, 0, 1000 - s0.h), srcW: s0.w, srcH: s0.h, eraseFollow: false });
      } else {
        updateBlock(b.id, { srcX: s0.x, srcY: s0.y, srcW: clampNum(s0.w + dx, 10, 1000 - s0.x), srcH: clampNum(s0.h + dy, 10, 1000 - s0.y), eraseFollow: false });
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      scheduleRender();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isEditing) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 1000;
      const y = ((e.clientY - rect.top) / rect.height) * 1000;
      if (!e.shiftKey) { setSelectedBlockId(null); setSelectedBlockIds([]); }
      setDrawingBox({ x, y, w: 0, h: 0 });
    } else if (zoom > 1) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isEditing) {
      if (!drawingBox || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 1000;
      const y = ((e.clientY - rect.top) / rect.height) * 1000;
      setDrawingBox(prev => prev ? { ...prev, w: x - prev.x, h: y - prev.y } : null);
    } else if (isPanning && zoom > 1) {
      setPanOffset({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      });
    }
  };

  const handleMouseUp = () => {
    if (isEditing) {
      if (!drawingBox) return;
      finishDrawing();
    } else {
      setIsPanning(false);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isEditing) {
      if (!containerRef.current) return;
      const touch = e.touches[0];
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((touch.clientX - rect.left) / rect.width) * 1000;
      const y = ((touch.clientY - rect.top) / rect.height) * 1000;
      setSelectedBlockId(null);
      setSelectedBlockIds([]);
      setDrawingBox({ x, y, w: 0, h: 0 });
    } else if (zoom > 1) {
      setIsPanning(true);
      const touch = e.touches[0];
      setPanStart({ x: touch.clientX - panOffset.x, y: touch.clientY - panOffset.y });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isEditing) {
      if (!drawingBox || !containerRef.current) return;
      const touch = e.touches[0];
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((touch.clientX - rect.left) / rect.width) * 1000;
      const y = ((touch.clientY - rect.top) / rect.height) * 1000;
      setDrawingBox(prev => prev ? { ...prev, w: x - prev.x, h: y - prev.y } : null);
    } else if (isPanning && zoom > 1) {
      const touch = e.touches[0];
      setPanOffset({
        x: touch.clientX - panStart.x,
        y: touch.clientY - panStart.y
      });
    }
  };

  const handleTouchEnd = () => {
    if (isEditing) {
      if (!drawingBox) return;
      finishDrawing();
    } else {
      setIsPanning(false);
    }
  };

  const [activeHandling, setActiveHandling] = useState<{
    blockId: string;
    type: 'move' | 'resize';
    handle?: 'tl' | 'tr' | 'bl' | 'br';
    startX: number;
    startY: number;
    startBlockX: number;
    startBlockY: number;
    startBlockW: number;
    startBlockH: number;
  } | null>(null);

  const triggerRender = useCallback(async (page: MangaPage) => {
    const translatedUrl = await renderTranslatedImage(page, page.textBlocks || []);
    setPages(prev => prev.map(p => p.id === page.id ? { ...p, translatedUrl } : p));
  }, [renderTranslatedImage, setPages]);

  useEffect(() => {
    const currentPage = pages[currentIndex];
    if (currentPage && (currentPage.status === 'completed' || currentPage.status === 'translating' || currentPage.status === 'pending') && currentPage.textBlocks) {
      triggerRender(currentPage);
    }
  }, [
    currentIndex,
    showTranslatedText,
    fontSettings.sizeMultiplier,
    fontSettings.weight,
    fontSettings.fontFamily,
    fontSettings.outline,
    fontSettings.bgOpacity,
    fontSettings.boxPadding,
    performanceSettings.autoCleanText
  ]);

  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;
  const activeBatchRef = useRef<string | null>(null);
  activeBatchRef.current = activeBatchId;
  const renderTimer2Ref = useRef<any>(null);
  const renderSeqRef = useRef(0);
  const historyRef = useRef<Map<string, { past: TextBlock[][]; future: TextBlock[][]; t: number }>>(new Map());

  /** Render ulang halaman aktif (di-debounce, hasil basi dibuang) */
  const scheduleRender = () => {
    if (renderTimer2Ref.current) clearTimeout(renderTimer2Ref.current);
    renderTimer2Ref.current = setTimeout(async () => {
      const page = pagesRef.current[currentIndexRef.current];
      const batchId = activeBatchRef.current;
      if (!page || !batchId) return;
      const seq = ++renderSeqRef.current;
      const url = await renderTranslatedImage(page, page.textBlocks || []);
      if (seq !== renderSeqRef.current) return;
      updatePagesInBatch(batchId, prev => prev.map(p => (p.id === page.id ? { ...p, translatedUrl: url } : p)));
    }, 60);
  };

  const pushHistory = (force = false) => {
    const page = pagesRef.current[currentIndexRef.current];
    if (!page) return;
    const h = historyRef.current.get(page.id) || { past: [], future: [], t: 0 };
    const now = Date.now();
    if (force || now - h.t > 600) {
      h.past.push(JSON.parse(JSON.stringify(page.textBlocks || [])));
      if (h.past.length > 50) h.past.shift();
      h.future = [];
    }
    h.t = now;
    historyRef.current.set(page.id, h);
  };

  const undoRedo = (redo: boolean) => {
    const page = pagesRef.current[currentIndexRef.current];
    const h = page && historyRef.current.get(page.id);
    if (!page || !h) return;
    const snap = (redo ? h.future : h.past).pop();
    if (!snap) return;
    (redo ? h.past : h.future).push(JSON.parse(JSON.stringify(page.textBlocks || [])));
    setPages(prev => prev.map(p => (p.id === page.id ? { ...p, textBlocks: snap } : p)));
    setSelectedBlockId(null);
    setSelectedBlockIds([]);
    scheduleRender();
  };

  const updateBlockAndRender = (blockId: string, updates: Partial<TextBlock>) => {
    pushHistory();
    setPages(prev => prev.map((p, i) => (i === currentIndex ? { ...p, textBlocks: p.textBlocks?.map(b => (b.id === blockId ? withSrc(b, updates) : b)) } : p)));
    scheduleRender();
  };

  /** Terapkan perubahan ke semua blok yang sedang dipilih */
  const updateSelected = (fn: (b: TextBlock) => Partial<TextBlock>) => {
    const ids = selectedBlockIds.length ? selectedBlockIds : selectedBlockId ? [selectedBlockId] : [];
    if (!ids.length) return;
    pushHistory();
    setPages(prev => prev.map((p, i) => (i === currentIndex ? { ...p, textBlocks: p.textBlocks?.map(b => (ids.includes(b.id) ? withSrc(b, fn(b)) : b)) } : p)));
    scheduleRender();
  };

  const handleBlockMouseDown = (e: React.MouseEvent, block: TextBlock) => {
    if (!isEditing || !containerRef.current) return;
    e.stopPropagation();
    setSelectedBlockId(block.id);
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1000;
    const y = ((e.clientY - rect.top) / rect.height) * 1000;
    
    pushHistory(true);
    setActiveHandling({
      blockId: block.id,
      type: 'move',
      startX: x,
      startY: y,
      startBlockX: block.x,
      startBlockY: block.y,
      startBlockW: block.width,
      startBlockH: block.height
    });
  };

  const handleBlockTouchStart = (e: React.TouchEvent, block: TextBlock) => {
    if (!isEditing || !containerRef.current) return;
    e.stopPropagation();
    setSelectedBlockId(block.id);
    
    const touch = e.touches[0];
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((touch.clientX - rect.left) / rect.width) * 1000;
    const y = ((touch.clientY - rect.top) / rect.height) * 1000;
    
    pushHistory(true);
    setActiveHandling({
      blockId: block.id,
      type: 'move',
      startX: x,
      startY: y,
      startBlockX: block.x,
      startBlockY: block.y,
      startBlockW: block.width,
      startBlockH: block.height
    });
  };

  const handleResizeHandleMouseDown = (e: React.MouseEvent, block: TextBlock, handle: 'tl' | 'tr' | 'bl' | 'br') => {
    if (!isEditing || !containerRef.current) return;
    e.stopPropagation();
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1000;
    const y = ((e.clientY - rect.top) / rect.height) * 1000;
    
    pushHistory(true);
    setActiveHandling({
      blockId: block.id,
      type: 'resize',
      handle,
      startX: x,
      startY: y,
      startBlockX: block.x,
      startBlockY: block.y,
      startBlockW: block.width,
      startBlockH: block.height
    });
  };

  const handleResizeHandleTouchStart = (e: React.TouchEvent, block: TextBlock, handle: 'tl' | 'tr' | 'bl' | 'br') => {
    if (!isEditing || !containerRef.current) return;
    e.stopPropagation();
    
    const touch = e.touches[0];
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((touch.clientX - rect.left) / rect.width) * 1000;
    const y = ((touch.clientY - rect.top) / rect.height) * 1000;
    
    pushHistory(true);
    setActiveHandling({
      blockId: block.id,
      type: 'resize',
      handle,
      startX: x,
      startY: y,
      startBlockX: block.x,
      startBlockY: block.y,
      startBlockW: block.width,
      startBlockH: block.height
    });
  };

  useEffect(() => {
    if (!activeHandling) return;

    const handleWindowMove = (clientX: number, clientY: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const currentX = ((clientX - rect.left) / rect.width) * 1000;
      const currentY = ((clientY - rect.top) / rect.height) * 1000;
      
      const dx = currentX - activeHandling.startX;
      const dy = currentY - activeHandling.startY;
      
      const page = pages[currentIndex];
      if (!page) return;

      if (activeHandling.type === 'move') {
        const newX = Math.max(0, Math.min(1000 - activeHandling.startBlockW, activeHandling.startBlockX + dx));
        const newY = Math.max(0, Math.min(1000 - activeHandling.startBlockH, activeHandling.startBlockY + dy));
        
        updateBlock(activeHandling.blockId, { x: newX, y: newY });
      } else if (activeHandling.type === 'resize') {
        let newX = activeHandling.startBlockX;
        let newY = activeHandling.startBlockY;
        let newW = activeHandling.startBlockW;
        let newH = activeHandling.startBlockH;
        
        const handle = activeHandling.handle;
        if (handle === 'br') {
          newW = Math.max(20, activeHandling.startBlockW + dx);
          newH = Math.max(20, activeHandling.startBlockH + dy);
        } else if (handle === 'tl') {
          const possibleW = activeHandling.startBlockW - dx;
          const possibleH = activeHandling.startBlockH - dy;
          if (possibleW > 20) {
            newX = Math.max(0, activeHandling.startBlockX + dx);
            newW = possibleW;
          }
          if (possibleH > 20) {
            newY = Math.max(0, activeHandling.startBlockY + dy);
            newH = possibleH;
          }
        } else if (handle === 'tr') {
          newW = Math.max(20, activeHandling.startBlockW + dx);
          const possibleH = activeHandling.startBlockH - dy;
          if (possibleH > 20) {
            newY = Math.max(0, activeHandling.startBlockY + dy);
            newH = possibleH;
          }
        } else if (handle === 'bl') {
          const possibleW = activeHandling.startBlockW - dx;
          if (possibleW > 20) {
            newX = Math.max(0, activeHandling.startBlockX + dx);
            newW = possibleW;
          }
          newH = Math.max(20, activeHandling.startBlockH + dy);
        }
        
        newX = Math.max(0, Math.min(1000, newX));
        newY = Math.max(0, Math.min(1000, newY));
        newW = Math.min(1000 - newX, newW);
        newH = Math.min(1000 - newY, newH);

        updateBlock(activeHandling.blockId, { x: newX, y: newY, width: newW, height: newH });
      }
    };

    const handleWindowMouseMove = (e: MouseEvent) => {
      handleWindowMove(e.clientX, e.clientY);
    };

    const handleWindowTouchMove = (e: TouchEvent) => {
      if (e.touches && e.touches[0]) {
        if (e.cancelable) e.preventDefault();
        handleWindowMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const handleWindowEnd = async () => {
      setActiveHandling(null);
      const page = pages[currentIndex];
      if (page) {
        triggerRender(page);
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowEnd);
    window.addEventListener('touchmove', handleWindowTouchMove, { passive: false });
    window.addEventListener('touchend', handleWindowEnd);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowEnd);
      window.removeEventListener('touchmove', handleWindowTouchMove);
      window.removeEventListener('touchend', handleWindowEnd);
    };
  }, [activeHandling, pages, currentIndex, triggerRender]);

  const updateBlock = (blockId: string, updates: Partial<TextBlock>) => {
    setPages(prev => prev.map((p, i) => (i === currentIndex ? { ...p, textBlocks: p.textBlocks?.map(b => (b.id === blockId ? withSrc(b, updates) : b)) } : p)));
  };

  const addBlockAndRender = (newBlock: TextBlock) => {
    pushHistory(true);
    setPages(prev => prev.map((p, i) => (i === currentIndex ? { ...p, textBlocks: [...(p.textBlocks || []), newBlock] } : p)));
    setSelectedBlockId(newBlock.id);
    scheduleRender();
  };

  const addManualTextBlock = () => {
    const page = pages[currentIndex];
    if (!page) return;
    const newBlock: TextBlock = {
      id: Math.random().toString(36).substr(2, 9),
      originalText: '',
      translatedText: 'Teks Baru',
      eraseMode: 'none',
      x: 375,
      y: 450,
      width: 250,
      height: 100,
      fontSize: 30,
      fontStyle: 'normal',
      type: 'manual',
      align: 'center'
    };
    addBlockAndRender(newBlock);
  };

  const addManualEraserBlock = () => {
    const page = pages[currentIndex];
    if (!page) return;
    const newBlock: TextBlock = {
      id: Math.random().toString(36).substr(2, 9),
      originalText: '',
      translatedText: '',
      x: 375,
      y: 450,
      width: 250,
      height: 250,
      type: 'manual',
      isCleanOnly: true,
      cleanShape: 'ellipse',
      cleanColor: '#FFFFFF'
    };
    addBlockAndRender(newBlock);
  };

  const deleteBlocks = (ids: string[]) => {
    if (!ids.length) return;
    pushHistory(true);
    setPages(prev => prev.map((p, i) => (i === currentIndex ? { ...p, textBlocks: p.textBlocks?.filter(b => !ids.includes(b.id)) } : p)));
    setSelectedBlockId(null);
    setSelectedBlockIds([]);
    scheduleRender();
  };
  const deleteBlock = (blockId: string) => deleteBlocks([blockId]);

  const reTranslateBlock = async (blockId: string) => {
    const currentPage = pages[currentIndex];
    const block = currentPage.textBlocks?.find(b => b.id === blockId);
    if (!block || !currentPage) return;

    const wasBusy = translationRef.current;
    try {
      // Show loading state for block
      updateBlock(blockId, { translatedText: 'Translating...' });
      setIsTranslating(true);
      translationRef.current = true;
      abortControllerRef.current = new AbortController();

      const data = blobCache.current.get(currentPage.id);
      let blob: Blob;
      
      if (data) {
        blob = new Blob([data], { type: currentPage.mimeType });
      } else {
        try {
          const response = await fetch(currentPage.originalUrl, { signal: abortControllerRef.current?.signal });
          if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
          blob = await response.blob();
        } catch (e: any) {
          if (e.name === 'AbortError') throw e;
          console.error('Image fetch error:', e);
          throw new Error(`Failed to load image data: ${e.message || 'Check your connection'}`);
        }
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      let resultText = '';
      const contents = [
        {
          parts: [
            { text: `Translate the text in this specific region of the manga page to Indonesian. 
              Region (x, y, width, height): ${block.x}, ${block.y}, ${block.width}, ${block.height} (relative to 0-1000).
              
              CRITICAL: 
              1. NATURAL INDONESIAN: Use colloquial, natural, and context-aware Indonesian.
              2. EMOTION: Reflect the speaker's emotion and tone.
              
              Write the result as normal horizontal Indonesian prose (no line breaks). Return ONLY the translated text as a string.` },
            { inlineData: { mimeType: currentPage.mimeType || blob.type || 'image/jpeg', data: base64 } }
          ]
        }
      ];

      const result = await callTranslateWithRetry(
        apiSettings.provider,
        apiSettings.provider === 'custom' ? apiSettings.customModel : apiSettings.model,
        contents,
        undefined,
        apiKeys[apiSettings.provider as keyof typeof apiKeys],
        (delay, currentAttempt, totalRetries) => {
          const delaySecs = Math.round(delay / 1000);
          updateBlock(blockId, { translatedText: `Rate limited... Retrying in ${delaySecs}s (${currentAttempt}/${totalRetries})` });
        }
      );

      resultText = result.text || '';

      const translatedText = resultText.trim().replace(/^["“]|["”]$/g, '') || block.translatedText;
      updateBlock(blockId, { translatedText });
      scheduleRender();
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Block translation aborted');
        updateBlock(blockId, { translatedText: block.translatedText }); // Restore previous text
      } else {
        console.error('Block translation error:', error);
        updateBlock(blockId, { translatedText: 'Error translating' });
      }
    } finally {
      if (!wasBusy) {
        setIsTranslating(false);
        translationRef.current = false;
        abortControllerRef.current = null;
      }
    }
  };

  const groupSelectedBlocks = () => {
    if (selectedBlockIds.length < 2) return;
    const groupId = Math.random().toString(36).substr(2, 9);
    setPages(prev => prev.map((p, i) => i === currentIndex ? {
      ...p,
      textBlocks: p.textBlocks?.map(b => selectedBlockIds.includes(b.id) ? { ...b, groupId } : b)
    } : p));
    setSelectedBlockIds([]);
    setSelectedBlockId(null);
  };

  const ungroupBlocks = (groupId: string) => {
    setPages(prev => prev.map((p, i) => i === currentIndex ? {
      ...p,
      textBlocks: p.textBlocks?.map(b => b.groupId === groupId ? { ...b, groupId: undefined } : b)
    } : p));
  };

  const handleBlockClick = (e: React.MouseEvent, block: TextBlock) => {
    e.stopPropagation();
    if (e.shiftKey) {
      setSelectedBlockIds(prev => prev.includes(block.id) ? prev.filter(id => id !== block.id) : [...prev, block.id]);
      setSelectedBlockId(null);
    } else {
      setSelectedBlockId(block.id);
      setSelectedBlockIds([]);
    }
  };

  const saveEdits = async () => {
    try { recordCorrections(pagesRef.current[currentIndexRef.current]?.textBlocks || []); } catch { /* abaikan */ }
    const currentPage = pages[currentIndex];
    if (currentPage && currentPage.textBlocks) {
      const translatedUrl = await renderTranslatedImage(currentPage, currentPage.textBlocks || []);
      setPages(prev => prev.map((p, i) => i === currentIndex ? { ...p, translatedUrl } : p));
    }
    setIsEditing(false);
    setSelectedBlockId(null);
  };

  const selectAllPages = (selected: boolean) => {
    setPages(prev => prev.map(p => ({ ...p, selected })));
  };

  const updateRenders = async (targetPages: MangaPage[], force = false) => {
    if (isTranslating && !force) return;
    setIsTranslating(true);
    translationRef.current = true;
    abortControllerRef.current = new AbortController();
    
    try {
      // Ensure targetPages is an array (onClick might pass an event object)
      const actualTargetPages = Array.isArray(targetPages) ? targetPages : [];
      
      // Process one by one for better responsiveness to stop signal
      for (const page of actualTargetPages) {
        if (!translationRef.current) break;
        
        if (page.status === 'completed' && page.textBlocks) {
          const translatedUrl = await renderTranslatedImage(page, page.textBlocks);
          setPages(prev => prev.map(p => p.id === page.id ? { ...p, translatedUrl } : p));
        }
      }

      if (translationRef.current) {
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 }
        });
      }
    } catch (error) {
      console.error('Update renders error:', error);
    } finally {
      setIsTranslating(false);
      translationRef.current = false;
    }
  };

  const renderTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    
    renderTimeoutRef.current = setTimeout(() => {
      const currentPage = pages[currentIndex];
      if (currentPage && currentPage.status === 'completed' && currentPage.textBlocks) {
        updateRenders([currentPage], true);
      }
    }, 500);

    return () => {
      if (renderTimeoutRef.current) clearTimeout(renderTimeoutRef.current);
    };
  }, [fontSettings.sizeMultiplier, fontSettings.weight, fontSettings.fontFamily, fontSettings.outline, fontSettings.useAiFont]);

  const translateAll = async (
    targetPages?: MangaPage[], 
    batchId?: string,
    mode: 'full' | 'ocr_only' | 'translate_only' = 'full'
  ) => {
    const targetBatchId = batchId || activeBatchId;
    if (isTranslating || !targetBatchId) return;
    
    const targetBatch = batches.find(b => b.id === targetBatchId);
    if (!targetBatch) return;

    const pageUpdater = (updater: (prev: MangaPage[]) => MangaPage[]) => updatePagesInBatch(targetBatchId, updater);
    
    setIsTranslating(true);
    translationRef.current = true;
    abortControllerRef.current = new AbortController();
    
    try {
      const actualTargetPages = Array.isArray(targetPages) ? targetPages : null;
      const pendingPages = actualTargetPages || targetBatch.pages.filter(p => {
        if (mode === 'translate_only') {
          return p.textBlocks && p.textBlocks.length > 0 && !p.isTranslated;
        }
        return p.status === 'pending' || p.status === 'error';
      });
      
      if (pendingPages.length === 0) {
        updateBatch(targetBatchId, { status: 'completed' });
        setIsTranslating(false);
        return;
      }

      updateBatch(targetBatchId, { status: 'processing' });

      if (!translationEnabled) {
        pageUpdater(prev => prev.map(p => {
          if (pendingPages.some(pp => pp.id === p.id)) {
            return { ...p, status: 'completed' };
          }
          return p;
        }));
      } else {
        for (let i = 0; i < pendingPages.length; i++) {
          if (!translationRef.current) break;
          const page = pendingPages[i];
          const success = await translatePage(page, targetBatchId, mode);
          
          if (!success) {
            console.warn(`Page ${page.name} failed to translate. Continuing with other pages in the queue.`);
            if (!translationRef.current) {
              break;
            }
          }
          
          updateBatch(targetBatchId, { progress: Math.round(((i + 1) / pendingPages.length) * 100) });

          if (translationRef.current) {
            const isCloud = apiSettings.provider !== 'local';
            await new Promise(resolve => setTimeout(resolve, isCloud ? 3000 : 200));
          }
        }
      }

      if (translationRef.current) {
        updateBatch(targetBatchId, { status: 'completed', progress: 100 });
        confetti({
          particleCount: 150,
          spread: 70,
          origin: { y: 0.6 }
        });
      } else {
        updateBatch(targetBatchId, { status: 'idle' });
      }
    } catch (error) {
      console.error('Translate all error:', error);
      updateBatch(targetBatchId, { status: 'error' });
    } finally {
      setIsTranslating(false);
      translationRef.current = false;
    }
  };

  const [pdfProgress, setPdfProgress] = useState<{ current: number; total: number } | null>(null);

  const loadImage = async (page: MangaPage, isOriginal: boolean): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = document.createElement('img');
      
      // If we want original, we always try cache first. 
      // If we want translated, we check if translatedUrl exists; if not, we fall back to original (cache).
      const imgUrl = isOriginal ? page.originalUrl : (page.translatedUrl || page.originalUrl);
      
      const isBase64 = imgUrl.startsWith('data:');
      const isBlob = imgUrl.startsWith('blob:');

      // Detailed logging for debugging
      const logId = `[IMG:${page.name}]`;

      if (!isBlob && !isBase64) {
        img.crossOrigin = "anonymous";
        img.referrerPolicy = 'no-referrer';
      }
      
      // Increased timeout to 50s for slow connections/large files
      const timeout = setTimeout(() => {
        const errorMsg = `${logId} Load timeout (50s). Type: ${isBlob ? 'blob' : (isBase64 ? 'data' : 'ext')}`;
        console.error(errorMsg);
        reject(new Error(errorMsg));
      }, 50000);

      img.onload = () => {
        clearTimeout(timeout);
        if (img.naturalWidth > 0) {
          resolve(img);
        } else {
          reject(new Error(`${logId} Image loaded with 0 dimensions`));
        }
      };

      let hasRetried = false;
      img.onerror = (err) => {
        if (!hasRetried && isBlob) {
          hasRetried = true;
          console.warn(`${logId} Direct blob load failed, attempting fallback fetch conversion...`);
          fetch(imgUrl)
            .then(res => {
              if (!res.ok) throw new Error(`HTTP status ${res.status}`);
              return res.blob();
            })
            .then(resBlob => {
              const reader = new FileReader();
              reader.onloadend = () => {
                if (reader.result) {
                  img.src = reader.result as string;
                } else {
                  clearTimeout(timeout);
                  reject(new Error(`${logId} FileReader result empty on retry`));
                }
              };
              reader.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`${logId} FileReader error on retry`));
              };
              reader.readAsDataURL(resBlob);
            })
            .catch(fetchErr => {
              clearTimeout(timeout);
              console.error(`${logId} Fetch fallback retry failed:`, fetchErr);
              reject(new Error(`${logId} Failed to load image asset on retry`));
            });
          return;
        }

        if (!hasRetried && isBase64) {
          hasRetried = true;
          console.warn(`${logId} Direct base64 load failed, attempting fallback to Blob URL...`);
          try {
            const parts = imgUrl.split(',');
            if (parts.length >= 2) {
              const mimeMatch = parts[0].match(/:(.*?);/);
              const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
              const bstr = atob(parts[1]);
              let n = bstr.length;
              const u8arr = new Uint8Array(n);
              while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
              }
              const blob = new Blob([u8arr], { type: mime });
              const blobUrl = URL.createObjectURL(blob);
              img.src = blobUrl;
              return;
            }
          } catch (e) {
            console.error(`${logId} Base64 fallback to Blob URL failed:`, e);
          }
        }

        clearTimeout(timeout);
        console.error(`${logId} Load error. URL type: ${isBlob ? 'blob' : (isBase64 ? 'data' : 'ext')}. URL:`, imgUrl.substring(0, 100));
        reject(new Error(`${logId} Failed to load image asset`));
      };

      // Use Uint8Array from cache to avoid stale blob URL issues in iframes
      // We use cache for originals, or if we're falling back to original when translatedUrl is missing
      const data = (isOriginal || !page.translatedUrl) ? blobCache.current.get(page.id) : null;
      
      if (data && !isBase64) {
        const blob = new Blob([data], { type: page.mimeType || 'image/jpeg' });
        const reader = new FileReader();
        reader.onloadend = () => {
          if (reader.result) {
            img.src = reader.result as string;
          } else {
            console.warn(`${logId} FileReader result empty, falling back to URL`);
            img.src = imgUrl; 
          }
        };
        reader.onerror = () => {
          console.error(`${logId} FileReader error, falling back to URL`);
          img.src = imgUrl; 
        };
        reader.readAsDataURL(blob);
      } else if (isBlob) {
        // Eagerly fetch and convert to Data URL to prevent loading blob directly in sandboxed iframe
        fetch(imgUrl)
          .then(res => {
            if (!res.ok) throw new Error(`HTTP status ${res.status}`);
            return res.blob();
          })
          .then(resBlob => {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (reader.result) {
                img.src = reader.result as string;
              } else {
                console.warn(`${logId} Eager fetch FileReader result empty, falling back to direct URL`);
                img.src = imgUrl;
              }
            };
            reader.onerror = () => {
              console.error(`${logId} Eager fetch FileReader error, falling back to direct URL`);
              img.src = imgUrl;
            };
            reader.readAsDataURL(resBlob);
          })
          .catch(fetchErr => {
            console.error(`${logId} Eager fetch failed, loading direct URL:`, fetchErr);
            img.src = imgUrl;
          });
      } else {
        img.src = imgUrl;
      }

      // Check if already loaded
      if (img.complete && img.naturalWidth > 0) {
        clearTimeout(timeout);
        resolve(img);
      }
    });
  };

  const generatePDF = async (targetPages?: MangaPage[], batchId?: string) => {
    const targetBatchId = batchId || activeBatchId;
    const targetBatch = batches.find(b => b.id === targetBatchId) || activeBatch;
    if (!targetBatch) return;

    // Determine which pages to export
    let pagesToExport = targetPages || targetBatch.pages.filter(p => p.selected);
    if (pagesToExport.length === 0) {
      pagesToExport = targetBatch.pages.filter(p => p.status === 'completed');
    }
    if (pagesToExport.length === 0) {
      pagesToExport = targetBatch.pages;
    }
    
    if (pagesToExport.length === 0) return;

    setIsGeneratingPdf(true);
    setPdfProgress({ current: 0, total: pagesToExport.length, batchName: targetBatch.name });

    try {
      const pdf = new jsPDF();
      const canvas = document.createElement('canvas');

      for (let i = 0; i < pagesToExport.length; i++) {
        setPdfProgress({ current: i + 1, total: pagesToExport.length, batchName: targetBatch.name });
        const page = pagesToExport[i];
        const isOriginal = !page.translatedUrl;
        
        if (i > 0) pdf.addPage();

        const img = await loadImage(page, isOriginal);

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        
        const imgWidth = img.naturalWidth || img.width;
        const imgHeight = img.naturalHeight || img.height;

        let drawWidth = imgWidth;
        let drawHeight = imgHeight;
        
        if (pdfSettings.compressed) {
          const maxDim = pdfSettings.maxDimension;
          if (imgWidth > maxDim || imgHeight > maxDim) {
            const scale = Math.min(maxDim / imgWidth, maxDim / imgHeight);
            drawWidth = Math.round(imgWidth * scale);
            drawHeight = Math.round(imgHeight * scale);
          }
        }

        const ratio = Math.min(pageWidth / drawWidth, pageHeight / drawHeight);
        const w = drawWidth * ratio;
        const h = drawHeight * ratio;
        const x = (pageWidth - w) / 2;
        const y = (pageHeight - h) / 2;

        // Re-use clean canvas buffer to optimize CPU/RAM on mobile devices
        canvas.width = drawWidth;
        canvas.height = drawHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context');
        ctx.clearRect(0, 0, drawWidth, drawHeight);
        ctx.drawImage(img, 0, 0, drawWidth, drawHeight);
        
        // Export as JPEG with chosen compression quality
        const quality = pdfSettings.compressed ? pdfSettings.jpegQuality : 0.85;
        const imgData = canvas.toDataURL('image/jpeg', quality);
        pdf.addImage(imgData, 'JPEG', x, y, w, h, undefined, 'FAST');

        img.src = ''; // Deallocate image buffer immediately

        // Small delay to keep UI responsive
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Release memory of reusable canvas element
      canvas.width = 0;
      canvas.height = 0;

      const fileName = targetBatch.zipFileName 
        ? `${targetBatch.zipFileName}${translationEnabled ? '_Translated' : ''}.pdf`
        : (pagesToExport.length === 1 
            ? `${pagesToExport[0].name.split('.')[0]}${translationEnabled ? '_Translated' : ''}.pdf`
            : `${targetBatch.name}${translationEnabled ? '_Translated' : ''}.pdf`);
        
      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);
      const sizeStr = `${(pdfBlob.size / (1024 * 1024)).toFixed(2)} MB`;

      setCompletedPdfs(prev => {
        const filtered = prev.filter(p => p.name !== fileName);
        return [...filtered, {
          id: Math.random().toString(36).substr(2, 9),
          name: fileName,
          url: blobUrl,
          size: sizeStr,
          timestamp: Date.now()
        }];
      });

      // Secure Server-side download trigger (100% reliable in iframes & WebViews)
      await triggerServerSideDownload(pdfBlob, fileName);
      
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    } catch (e: any) {
      console.error('PDF generation error:', e);
      alert(`Export Error: ${e.message || 'Unknown error occurred during PDF generation.'}`);
    } finally {
      setIsGeneratingPdf(false);
      setPdfProgress(null);
    }
  };

  const processBatchQueue = useCallback(async () => {
    if (isTranslating) return;

    const nextBatch = batches.find(b => b.status === 'queued');
    if (!nextBatch) return;

    setActiveBatchId(nextBatch.id);
    updateBatch(nextBatch.id, { status: 'processing' });
    
    // We need to wait for state to propagate if we rely on 'pages' from useMemo
    // But translateAll uses 'pages' which is derived from batches.
  }, [batches, isTranslating, activeBatchId, updateBatch]);

  useEffect(() => {
    processBatchQueue();
  }, [batches, isTranslating, processBatchQueue]);

  const queueAllBatches = () => {
    setBatches(prev => prev.map(b => b.status === 'idle' ? { ...b, status: 'queued' } : b));
  };

  useEffect(() => {
    if (activeBatch?.status === 'processing' && !isTranslating) {
      translateAll();
    }
  }, [activeBatch?.id, activeBatch?.status, isTranslating]);

  const exportToZip = async (targetPages?: MangaPage[], batchId?: string) => {
    const targetBatchId = batchId || activeBatchId;
    if (!targetBatchId) return;

    const targetBatch = batches.find(b => b.id === targetBatchId);
    if (!targetBatch) return;

    const zip = new JSZip();
    let pagesToExport = targetPages || targetBatch.pages.filter(p => p.selected);
    if (pagesToExport.length === 0) {
      pagesToExport = targetBatch.pages.filter(p => p.status === 'completed');
    }
    if (pagesToExport.length === 0) {
      pagesToExport = targetBatch.pages;
    }
    
    if (pagesToExport.length === 0) return;

    zipCancellationRef.current = false;
    setIsExportingZip(true);
    try {
      for (const page of pagesToExport) {
        if (zipCancellationRef.current) {
          throw new Error('ZIP Export Aborted');
        }
        const isOriginal = !page.translatedUrl;
        const imgUrl = page.translatedUrl || page.originalUrl;
        
        let blob: Blob;
        const data = isOriginal ? blobCache.current.get(page.id) : null;
        
        if (data) {
          blob = new Blob([data], { type: page.mimeType });
        } else if (imgUrl.startsWith('data:')) {
          const parts = imgUrl.split(',');
          const mime = parts[0].match(/:(.*?);/)?.[1] || page.mimeType;
          const bstr = atob(parts[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          blob = new Blob([u8arr], { type: mime });
        } else {
          const response = await fetch(imgUrl);
          if (!response.ok) throw new Error(`Failed to fetch ${imgUrl}`);
          blob = await response.blob();
        }
        
        // Use clean name without weird characters
        const baseName = page.name.split('.')[0].replace(/[^a-z0-9]/gi, '_');
        const ext = page.name.split('.').pop() || 'jpg';
        zip.file(`${baseName}_translated.${ext}`, blob);
      }

      if (zipCancellationRef.current) {
        throw new Error('ZIP Export Aborted');
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const fileName = targetBatch.zipFileName 
        ? `${targetBatch.zipFileName}${translationEnabled ? '_Translated' : ''}.zip`
        : `manga_export_${new Date().getTime()}${translationEnabled ? '_Translated' : ''}.zip`;

      await triggerServerSideDownload(content, fileName);
    } catch (error: any) {
      console.error('ZIP export error:', error);
      if (error?.message === 'ZIP Export Aborted') {
        alert('Proses export ZIP dibatalkan oleh pengguna.');
      } else {
        alert('Failed to export ZIP. Check console for details.');
      }
    } finally {
      setIsExportingZip(false);
    }
  };

  const downloadAllPdfsAsZip = async () => {
    if (completedPdfs.length === 0) return;
    zipCancellationRef.current = false;
    setIsExportingZip(true);
    try {
      const zip = new JSZip();
      for (const item of completedPdfs) {
        if (zipCancellationRef.current) {
          throw new Error('ZIP Export Aborted');
        }
        try {
          const response = await fetch(item.url);
          const blob = await response.blob();
          zip.file(item.name, blob);
        } catch (err) {
          console.error('Error adding PDF to zip:', item.name, err);
        }
      }
      
      if (zipCancellationRef.current) {
        throw new Error('ZIP Export Aborted');
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      await triggerServerSideDownload(zipBlob, `manga_all_pdfs_${new Date().getTime()}.zip`);
    } catch (err: any) {
      console.error('Error generating ZIP of PDFs:', err);
      if (err?.message === 'ZIP Export Aborted') {
        alert('Proses download ZIP dibatalkan oleh pengguna.');
      } else {
        alert('Failed to generate ZIP of PDFs. Please check console.');
      }
    } finally {
      setIsExportingZip(false);
    }
  };



  // ───── Seleksi drag: tahan lalu seret (mouse: geser >6px, sentuh: tekan lama) + auto-scroll ─────
  const [selectMode, setSelectMode] = useState(false);
  const suppressClickRef = useRef(0);
  const dsRef = useRef<any>(null);
  const dsLatest = useRef<any>({});
  dsLatest.current = { pages, selectedBlockIds, blocks: pages[currentIndex]?.textBlocks || [], setPages };

  const applyDS = (st: any, hover: number) => {
    st.last = hover;
    const lo = Math.min(st.anchor, hover);
    const hi = Math.max(st.anchor, hover);
    if (st.group === 'pages') {
      dsLatest.current.setPages((prev: MangaPage[]) => prev.map((p, i) => ({ ...p, selected: i >= lo && i <= hi ? st.target : st.base[i] })));
    } else {
      const ids = (dsLatest.current.blocks as TextBlock[]).filter((_, i) => (i >= lo && i <= hi ? st.target : st.base[i])).map(b => b.id);
      setSelectedBlockIds(ids);
      setSelectedBlockId(null);
    }
  };

  const beginDS = (e: React.PointerEvent, group: 'pages' | 'blocks') => {
    if (e.button > 0) return;
    const tgt = e.target as HTMLElement;
    const el = tgt.closest('[data-ds-idx]') as HTMLElement | null;
    if (!el || tgt.closest('textarea,input,select')) return;
    const idx = Number(el.dataset.dsIdx);
    const L = dsLatest.current;
    const base: boolean[] = group === 'pages'
      ? L.pages.map((p: MangaPage) => !!p.selected)
      : L.blocks.map((b: TextBlock) => L.selectedBlockIds.includes(b.id));
    const st: any = { group, anchor: idx, base, target: !base[idx], x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      started: false, touch: e.pointerType === 'touch', container: e.currentTarget as HTMLElement, last: idx, timer: null };
    if (st.touch) {
      st.timer = setTimeout(() => {
        if (dsRef.current === st) { st.started = true; applyDS(st, idx); (navigator as any).vibrate?.(15); }
      }, 350);
    }
    dsRef.current = st;
  };

  useEffect(() => {
    let raf = 0;
    const hover = (st: any) => {
      const el = document.elementFromPoint(st.x, st.y)?.closest('[data-ds-idx]') as HTMLElement | null;
      if (el && el.dataset.dsGroup === st.group) {
        const i = Number(el.dataset.dsIdx);
        if (i !== st.last) applyDS(st, i);
      }
    };
    const tick = () => {
      const st = dsRef.current;
      if (st?.started) {
        const r = st.container.getBoundingClientRect();
        const edge = 48;
        if (st.y < r.top + edge) st.container.scrollTop -= Math.ceil((r.top + edge - st.y) / 3);
        else if (st.y > r.bottom - edge) st.container.scrollTop += Math.ceil((st.y - (r.bottom - edge)) / 3);
        hover(st);
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      const st = dsRef.current;
      if (!st) return;
      st.x = e.clientX;
      st.y = e.clientY;
      const dist = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
      if (!st.started) {
        if (st.touch) { if (dist > 10) { clearTimeout(st.timer); dsRef.current = null; } return; }
        if (dist > 6) { st.started = true; window.getSelection()?.removeAllRanges(); applyDS(st, st.anchor); }
      }
    };
    const up = () => {
      const st = dsRef.current;
      if (!st) return;
      clearTimeout(st.timer);
      if (st.started) suppressClickRef.current = Date.now();
      dsRef.current = null;
    };
    const touchMove = (e: TouchEvent) => { if (dsRef.current?.started && e.cancelable) e.preventDefault(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.addEventListener('touchmove', touchMove, { passive: false });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.removeEventListener('touchmove', touchMove);
    };
  }, []);

  // ───── Layout adaptif & shortcut keyboard ─────
  const [showShortcuts, setShowShortcuts] = useState(false);
  const drawerW = typeof window !== 'undefined' ? Math.max(260, Math.min(335, Math.round(window.innerWidth * 0.23))) : 335;
  const selIds = selectedBlockIds.length ? selectedBlockIds : selectedBlockId ? [selectedBlockId] : [];

  useEffect(() => {
    // Layar sempit / zoom browser: beri ruang kanvas, jangan tampilkan 2 panel dock sekaligus
    if (isEditing && typeof window !== 'undefined' && window.innerWidth < 1700) setIsSidebarOpen(false);
  }, [isEditing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (rebinding) {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { setRebinding(null); return; }
        const c = comboOf(e);
        const next = { ...keymap };
        Object.keys(next).forEach(id => { if (next[id] === c) next[id] = ''; });
        next[rebinding] = c;
        setKeymap(next);
        saveKeymap(next);
        setRebinding(null);
        return;
      }
      if (typing) return;
      const page = pages[currentIndex];
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      const go = (d: number) => {
        setCurrentIndex(i => Math.max(0, Math.min(pages.length - 1, i + d)));
        setSelectedBlockId(null);
        setSelectedBlockIds([]);
        setZoom(1);
        setPanOffset({ x: 0, y: 0 });
      };
      // tombol tetap
      if (mod && e.shiftKey && k.toLowerCase() === 'z') { e.preventDefault(); undoRedo(true); return; }
      if (k === 'PageDown') { e.preventDefault(); go(1); return; }
      if (k === 'PageUp') { e.preventDefault(); go(-1); return; }
      if (k === 'Escape') {
        if (showShortcuts) setShowShortcuts(false);
        else if (drawTool !== 'select') setDrawTool('select');
        else if (selIds.length) { setSelectedBlockId(null); setSelectedBlockIds([]); }
        else if (isEditing) setIsEditing(false);
        else clearPageSelection();
        return;
      }
      if (isEditing && page && selIds.length && k === 'Backspace') { e.preventDefault(); deleteBlocks(selIds); return; }
      if (isEditing && page && selIds.length && k.startsWith('Arrow') && !mod) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
        const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        updateSelected(b => ({ x: clampNum(b.x + dx, 0, 1000 - b.width), y: clampNum(b.y + dy, 0, 1000 - b.height) }));
        return;
      }
      // tombol kustom
      const combo = comboOf(e);
      const id = Object.keys(keymap).find(a => keymap[a] && keymap[a] === combo);
      if (!id) return;
      if (EDIT_ONLY.has(id) && (!isEditing || !page)) return;
      e.preventDefault();
      switch (id) {
        case 'prevPage': go(-1); break;
        case 'nextPage': go(1); break;
        case 'toggleEdit': if (page) { setIsEditing(v => !v); setIsPageDrawerOpen(true); } break;
        case 'toolSelect': setDrawTool('select'); break;
        case 'toolText': setDrawTool('text'); break;
        case 'toolEraser': setDrawTool('eraser'); break;
        case 'addText': addManualTextBlock(); break;
        case 'addEraser': addManualEraserBlock(); break;
        case 'delete': if (selIds.length) deleteBlocks(selIds); break;
        case 'selectAll': setSelectedBlockId(null); setSelectedBlockIds((page?.textBlocks || []).map(b => b.id)); break;
        case 'deselect': setSelectedBlockId(null); setSelectedBlockIds([]); break;
        case 'undo': undoRedo(false); break;
        case 'redo': undoRedo(true); break;
        case 'save': saveEdits(); break;
        case 'zoomIn': setZoom(z => Math.min(4, +(z + 0.25).toFixed(2))); break;
        case 'zoomOut': setZoom(z => Math.max(0.25, +(z - 0.25).toFixed(2))); break;
        case 'zoomFit': setZoom(1); setPanOffset({ x: 0, y: 0 }); break;
        case 'fontDown': updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) - 2, 5, 150), fontSizeLocked: true })); break;
        case 'fontUp': updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) + 2, 5, 150), fontSizeLocked: true })); break;
        case 'alignL': updateSelected(() => ({ align: 'left' })); break;
        case 'alignC': updateSelected(() => ({ align: 'center' })); break;
        case 'alignR': updateSelected(() => ({ align: 'right' })); break;
        case 'horizontal': updateSelected(() => ({ isVertical: false })); break;
        case 'vertical': updateSelected(() => ({ isVertical: true })); break;
        case 'toggleErase': updateSelected(b => ({ eraseMode: b.eraseMode === 'none' ? 'auto' : 'none' })); break;
        case 'eraseToBox': updateSelected(b => ({ srcX: b.x, srcY: b.y, srcW: b.width, srcH: b.height, eraseFollow: false })); break;
        case 'strokeToggle': updateSelected(b => ({ strokeW: b.strokeW && b.strokeW > 0 ? 0 : 8 })); break;
        case 'retranslate': if (selIds.length === 1) reTranslateBlock(selIds[0]); break;
        case 'help': setShowShortcuts(v => !v); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (showShortcuts) setCorrectionCount(loadCorrections().length);
  }, [showShortcuts]);

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans overflow-x-hidden">
      <header className="border-b border-[#E5E5E5] bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between gap-2 md:gap-4">
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className={`p-2 rounded-full transition-all ${isSettingsOpen ? 'bg-black text-white' : 'hover:bg-[#F5F5F5]'}`}
              title="Settings"
            >
              <Settings className={`w-5 h-5 transition-transform ${isSettingsOpen ? 'rotate-90' : ''}`} />
            </button>
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className={`p-2 rounded-full transition-all ${isSidebarOpen ? 'bg-black text-white' : 'hover:bg-[#F5F5F5]'}`}
              title="Projects & Pages"
            >
              <List className="w-5 h-5" />
            </button>
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center hidden sm:flex ml-2">
              <Languages className="text-white w-5 h-5" />
            </div>
            <h1 className="text-base md:text-xl font-bold tracking-tight truncate hidden sm:block">MangaTranslate</h1>
          </div>
          <div className="flex items-center gap-2 md:gap-4 py-1">
            {batches.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#F5F5F5] border border-[#E5E5E5] rounded-full shadow-sm animate-fade-in">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#666]">Manga Status:</span>
                <span className={`text-[10px] font-bold uppercase ${isTranslating ? 'text-amber-600 animate-pulse' : 'text-emerald-600'}`}>
                  {isTranslating ? 'Translating' : 'Ready'}
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1920px] w-full mx-auto px-2 md:px-6 py-4 md:py-6 flex gap-4 md:gap-6 h-[calc(100vh-64px)] overflow-hidden relative">
            {/* Left Sidebar: Settings */}
            <AnimatePresence>
              {isSettingsOpen && (
                <div className="fixed inset-y-0 left-4 z-[70] top-20 bottom-4 flex text-left animate-fade-in">
                  {/* Backdrop */}
                  <div className="fixed inset-0 bg-black/30 z-[-1]" onClick={() => setIsSettingsOpen(false)} />
                  <motion.aside
                    initial={{ x: -300, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: -300, opacity: 0 }}
                    className="w-80 sm:w-[320px] 2xl:w-[350px] bg-white rounded-3xl border border-[#E5E5E5] flex flex-shrink-0 flex-col overflow-hidden shadow-2xl h-full"
                  >
                  <div className="p-6 border-b border-[#F0F0F0] flex items-center justify-between">
                    <h3 className="font-bold uppercase text-xs tracking-widest text-[#999]">Settings</h3>
                    <button onClick={() => setIsSettingsOpen(false)} className="p-1.5 hover:bg-[#F5F5F5] rounded-full">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                   <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
                    {/* Workflow Mode toggle */}
                    <div className="p-4 bg-black text-white rounded-2xl space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Workflow Mode</label>
                          <p className="text-[11px] font-bold">{translationEnabled ? 'Translate & Convert' : 'Direct Convert'}</p>
                        </div>
                        <button
                          onClick={() => setTranslationEnabled(!translationEnabled)}
                          className={`w-10 h-5 rounded-full transition-all relative ${translationEnabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${translationEnabled ? 'left-5.5' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <p className="text-[8px] text-zinc-400 leading-relaxed uppercase tracking-wider">
                        {translationEnabled 
                          ? 'Manga pages will be processed by AI to detect and translate text into Indonesian before conversion.' 
                          : 'Pages will be directly prepared for PDF conversion without any AI text processing or translation.'}
                      </p>
                    </div>

                    {translationEnabled && (
                      <div className="space-y-8 pt-4 border-t border-[#F0F0F0]">
                        {/* AI Mode & Style */}
                        <div className="space-y-6">
                          <div className="space-y-4">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Translation Tone</label>
                            <div className="grid grid-cols-2 gap-2">
                              {['natural', 'literal'].map((s) => (
                                <button
                                  key={s}
                                  onClick={() => setTranslationStyle(s as any)}
                                  className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                                    translationStyle === s ? 'bg-black text-white border-black' : 'border-[#E5E5E5] hover:border-black/20'
                                  }`}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="space-y-4">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Intelligence Level</label>
                            <div className="grid grid-cols-2 gap-2">
                              {[
                                { id: 'flash', label: 'Flash (Fast)' },
                                { id: 'pro', label: 'Pro (Smart)' },
                                { id: 'lite', label: 'Lite (Eco)' },
                                { id: 'auto', label: 'Auto (Best)' }
                              ].map((e) => (
                                <button
                                  key={e.id}
                                  onClick={() => setAiEngine(e.id as any)}
                                  className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                                    aiEngine === e.id ? 'bg-black text-white border-black' : 'border-[#E5E5E5] hover:border-black/20'
                                  }`}
                                >
                                  {e.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Font Size */}
                        <div className="space-y-4">
                          <div className="flex justify-between items-center">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Font Size</label>
                            <span className="text-xs font-mono">{Math.round(fontSettings.sizeMultiplier * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="2.0"
                            step="0.1"
                            value={fontSettings.sizeMultiplier}
                            onChange={(e) => setFontSettings(prev => ({ ...prev, sizeMultiplier: parseFloat(e.target.value) }))}
                            className="w-full h-1.5 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                          />
                        </div>

                    {/* Font Weight */}
                    <div className="space-y-4">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Font Weight</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['normal', 'bold', '900'].map((w) => (
                          <button
                            key={w}
                            onClick={() => setFontSettings(prev => ({ ...prev, weight: w }))}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                              fontSettings.weight === w ? 'bg-black text-white border-black' : 'border-[#E5E5E5] hover:border-black/20'
                            }`}
                          >
                            {w === '900' ? 'Extra' : w}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Font Style */}
                    <div className="space-y-4">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Font Style</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { name: 'Manga (Comic)', value: '"Comic Neue", cursive' },
                          { name: 'Rounded', value: '"Fredoka", sans-serif' },
                          { name: 'Action/Yell', value: '"Bangers", cursive' },
                          { name: 'Handwrite', value: '"Architects Daughter", cursive' },
                          { name: 'Modern Sans', value: '"Inter", sans-serif' },
                          { name: 'Classic Serif', value: 'serif' }
                        ].map((f) => (
                          <button
                            key={f.name}
                            onClick={() => setFontSettings(prev => ({ ...prev, fontFamily: f.value }))}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                              fontSettings.fontFamily === f.value ? 'bg-black text-white border-black' : 'border-[#E5E5E5] hover:border-black/20'
                            }`}
                            style={{ fontFamily: f.value }}
                          >
                            {f.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Background Opacity */}
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Background Opacity</label>
                        <span className="text-xs font-mono">{Math.round(fontSettings.bgOpacity * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1.0"
                        step="0.1"
                        value={fontSettings.bgOpacity}
                        onChange={(e) => setFontSettings(prev => ({ ...prev, bgOpacity: parseFloat(e.target.value) }))}
                        className="w-full h-1.5 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                      />
                    </div>

                    {/* Box Padding */}
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Box Padding</label>
                        <span className="text-xs font-mono">{fontSettings.boxPadding}px</span>
                      </div>
                      <input
                        type="range"
                        min="-20"
                        max="20"
                        step="1"
                        value={fontSettings.boxPadding}
                        onChange={(e) => setFontSettings(prev => ({ ...prev, boxPadding: parseInt(e.target.value) }))}
                        className="w-full h-1.5 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                      />
                    </div>

                    {/* Toggles */}
                    <div className="space-y-4 pt-4 border-t border-[#F0F0F0]">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Text Outline</label>
                        <button
                          onClick={() => setFontSettings(prev => ({ ...prev, outline: !prev.outline }))}
                          className={`w-10 h-5 rounded-full transition-all relative ${fontSettings.outline ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${fontSettings.outline ? 'left-5.5' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">AI Font Size</label>
                        <button
                          onClick={() => setFontSettings(prev => ({ ...prev, useAiFont: !prev.useAiFont }))}
                          className={`w-10 h-5 rounded-full transition-all relative ${fontSettings.useAiFont ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${fontSettings.useAiFont ? 'left-5.5' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between" title="Auto-expand text blocks to fit translations that are too big for the original bubble box">
                        <div className="flex flex-col">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Auto-Expand Boxes</label>
                          <span className="text-[8px] text-zinc-400 font-semibold leading-tight mt-0.5">Expands original boundary if too small</span>
                        </div>
                        <button
                          onClick={() => setFontSettings(prev => ({ ...prev, autoExpandBlocks: !prev.autoExpandBlocks }))}
                          className={`w-10 h-5 rounded-full transition-all relative ${fontSettings.autoExpandBlocks ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                        >
                          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${fontSettings.autoExpandBlocks ? 'left-5.5' : 'left-0.5'}`} />
                        </button>
                      </div>
                    </div>

                    {/* OCR Settings */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">OCR & Detection</h4>
                        <button 
                          onClick={() => {
                            const defaults = { confidenceThreshold: 70, detectionSensitivity: 80 };
                            setOcrSettings(defaults);
                            saveOcrSettings(defaults);
                          }}
                          className="text-[9px] font-bold text-blue-600 hover:text-blue-700 uppercase tracking-wider"
                        >
                          Reset
                        </button>
                      </div>
                      <div className="space-y-4">
                        <div className="flex justify-between items-center">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Confidence Threshold</label>
                          <span className="text-xs font-mono bg-black/5 px-1.5 py-0.5 rounded text-black font-bold">{ocrSettings.confidenceThreshold}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={ocrSettings.confidenceThreshold}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            const updated = { ...ocrSettings, confidenceThreshold: val };
                            setOcrSettings(updated);
                            saveOcrSettings(updated);
                          }}
                          className="w-full h-2 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                        />
                        <p className="text-[9px] text-[#999] leading-tight">Lower values detect more text, higher values reduce false positives.</p>
                      </div>
                      <div className="space-y-4">
                        <div className="flex justify-between items-center">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Detection Sensitivity</label>
                          <span className="text-xs font-mono bg-black/5 px-1.5 py-0.5 rounded text-black font-bold">{ocrSettings.detectionSensitivity}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={ocrSettings.detectionSensitivity}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            const updated = { ...ocrSettings, detectionSensitivity: val };
                            setOcrSettings(updated);
                            saveOcrSettings(updated);
                          }}
                          className="w-full h-2 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                        />
                      </div>
                    </div>

                    {/* Provider & Model Selection */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">AI Provider & Model</h4>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Provider</label>
                          <div className="flex flex-wrap gap-1.5">
                            {['gemini', 'openai', 'anthropic', 'custom', 'local'].map((p) => (
                              <button
                                key={p}
                                onClick={() => {
                                  const models = getModelsForProvider(p);
                                  setApiSettings(prev => ({ 
                                    ...prev, 
                                    provider: p as any,
                                    model: models[0] || ''
                                  }));
                                }}
                                className={`px-2.5 py-1.5 rounded-xl text-[9px] font-bold uppercase tracking-widest border transition-all ${
                                  apiSettings.provider === p ? 'bg-black text-white border-black' : 'border-[#E5E5E5] hover:border-black/20'
                                }`}
                              >
                                {p === 'custom' ? 'Universal' : p === 'local' ? 'Lokal (Offline)' : p}
                              </button>
                            ))}
                          </div>
                        </div>

                        {apiSettings.provider === 'custom' ? (
                          <div className="space-y-4 animate-fade-in bg-gray-50/50 p-3 rounded-2xl border border-gray-100">
                            <div className="space-y-2">
                              <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Endpoint URL</label>
                              <input
                                type="text"
                                value={apiSettings.customBaseURL || ''}
                                onChange={(e) => setApiSettings(prev => ({ ...prev, customBaseURL: e.target.value }))}
                                placeholder="e.g. https://openrouter.ai/api/v1"
                                className="w-full px-3 py-2 bg-white border border-[#E5E5E5] rounded-xl text-xs focus:outline-none focus:border-black transition-all"
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Model Name</label>
                              <input
                                type="text"
                                value={apiSettings.customModel || ''}
                                onChange={(e) => setApiSettings(prev => ({ ...prev, customModel: e.target.value }))}
                                placeholder="e.g. deepseek-chat"
                                className="w-full px-3 py-2 bg-white border border-[#E5E5E5] rounded-xl text-xs focus:outline-none focus:border-black transition-all"
                              />
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Model</label>
                            <select
                              value={apiSettings.model}
                              onChange={(e) => setApiSettings(prev => ({ ...prev, model: e.target.value }))}
                              className="w-full px-3 py-2 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-xs focus:outline-none focus:border-black transition-all appearance-none cursor-pointer"
                            >
                              {getModelsForProvider(apiSettings.provider).map(m => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Dialogue Localization & Nuances */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">Dialogue Localization</h4>
                      </div>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Manga Source Language</label>
                          <select
                             value={sourceLanguage}
                             onChange={(e) => saveSourceLanguage(e.target.value as any)}
                             className="w-full px-3 py-2 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-xs focus:outline-none focus:border-black transition-all appearance-none cursor-pointer"
                          >
                            <option value="auto">Auto Detect Language</option>
                            <option value="ja">Japanese (Colloquial / Comic Slang)</option>
                            <option value="ko">Korean (Webtoon / Gamer Slang)</option>
                            <option value="zh">Chinese (Wuxia / Fantasy / Idioms)</option>
                            <option value="en">English (Casual Dialogue to Indo)</option>
                          </select>
                        </div>
                        
                        <div className="space-y-2">
                          <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Prioritas Terjemahan</label>
                          <div className="grid grid-cols-2 gap-1.5 bg-[#F5F5F5] p-1 rounded-xl border border-[#E5E5E5]">
                            <button
                              type="button"
                              onClick={() => saveTranslateScope('all')}
                              className={`py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                translateScope === 'all'
                                  ? 'bg-black text-white shadow-sm'
                                  : 'text-[#999] hover:text-black hover:bg-[#EAEAEA]'
                              }`}
                            >
                              Semua Teks
                            </button>
                            <button
                              type="button"
                              onClick={() => saveTranslateScope('balloon')}
                              className={`py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all ${
                                translateScope === 'balloon'
                                  ? 'bg-black text-white shadow-sm'
                                  : 'text-[#999] hover:text-black hover:bg-[#EAEAEA]'
                              }`}
                            >
                              Hanya Balon
                            </button>
                          </div>
                        </div>
                        <p className="text-[8px] text-[#999] leading-tight flex-wrap">
                          Optimizes slang parsing, dialogue flow, particle additions, and honorific mapping to professional Indonesian standards.
                        </p>
                      </div>
                    </div>

                      </div>
                    )}

                    {/* Performance Settings */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-black" />
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">Performance & Hardware</h4>
                      </div>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">GPU Acceleration</label>
                            <p className="text-[8px] text-[#BBB]">Use hardware for rendering</p>
                          </div>
                          <button
                            onClick={() => setPerformanceSettings(prev => ({ ...prev, gpuAcceleration: !prev.gpuAcceleration }))}
                            className={`w-10 h-5 rounded-full transition-all relative ${performanceSettings.gpuAcceleration ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                          >
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${performanceSettings.gpuAcceleration ? 'left-5.5' : 'left-0.5'}`} />
                          </button>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Auto-Clean Text</label>
                            <p className="text-[8px] text-[#BBB]">Clear original text area</p>
                          </div>
                          <button
                            onClick={() => setPerformanceSettings(prev => ({ ...prev, autoCleanText: !prev.autoCleanText }))}
                            className={`w-10 h-5 rounded-full transition-all relative ${performanceSettings.autoCleanText ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                          >
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${performanceSettings.autoCleanText ? 'left-5.5' : 'left-0.5'}`} />
                          </button>
                        </div>
                      </div>
                      <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100">
                        <p className="text-[8px] text-emerald-800 leading-relaxed">
                          <strong>Local Optimization Active:</strong> This application is optimized for local desktop performance using browser-level CPU/GPU acceleration.
                        </p>
                      </div>
                    </div>

                    {/* PDF Export Settings */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-black" />
                        <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">PDF Export Settings</h4>
                      </div>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Enable Compression</label>
                            <p className="text-[8px] text-[#BBB]">Reduce PDF size dramatically</p>
                          </div>
                          <button
                            onClick={() => savePdfSettings({ ...pdfSettings, compressed: !pdfSettings.compressed })}
                            className={`w-10 h-5 rounded-full transition-all relative ${pdfSettings.compressed ? 'bg-emerald-500' : 'bg-[#E5E5E5]'}`}
                          >
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${pdfSettings.compressed ? 'left-5.5' : 'left-0.5'}`} />
                          </button>
                        </div>

                        {pdfSettings.compressed && (
                          <motion.div 
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            className="space-y-4 pt-2 border-t border-dashed border-[#F0F0F0]"
                          >
                            <div className="space-y-2">
                              <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Max Image Dimension</label>
                                <span className="text-xs font-mono bg-black/5 px-1.5 py-0.5 rounded text-black font-bold">{pdfSettings.maxDimension}px</span>
                              </div>
                              <input
                                type="range"
                                min="800"
                                max="2400"
                                step="100"
                                value={pdfSettings.maxDimension}
                                onChange={(e) => savePdfSettings({ ...pdfSettings, maxDimension: parseInt(e.target.value) })}
                                className="w-full h-1.5 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                              />
                              <p className="text-[8px] text-[#999] leading-tight">Scales images down if their width/height exceeds this limit.</p>
                            </div>

                            <div className="space-y-2">
                              <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">JPEG Export Quality</label>
                                <span className="text-xs font-mono bg-black/5 px-1.5 py-0.5 rounded text-black font-bold">{Math.round(pdfSettings.jpegQuality * 100)}%</span>
                              </div>
                              <input
                                type="range"
                                min="0.30"
                                max="0.95"
                                step="0.05"
                                value={pdfSettings.jpegQuality}
                                onChange={(e) => savePdfSettings({ ...pdfSettings, jpegQuality: parseFloat(e.target.value) })}
                                className="w-full h-1.5 bg-[#F0F0F0] rounded-lg appearance-none cursor-pointer accent-black"
                              />
                              <p className="text-[8px] text-[#999] leading-tight">Lower quality decreases final file size but may add subtle image noise.</p>
                            </div>
                          </motion.div>
                        )}
                      </div>
                    </div>

                    {/* API Key Management */}
                    <div className="space-y-6 pt-6 border-t border-[#F0F0F0]">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Key className="w-4 h-4 text-black" />
                          <h4 className="text-[10px] font-bold uppercase tracking-widest text-black">API Key Management</h4>
                        </div>
                      </div>
                      
                      <div className="space-y-6">
                        {[
                          { 
                            id: 'gemini', 
                            name: 'Gemini', 
                            url: 'https://aistudio.google.com/app/apikey',
                            systemAvailable: !!systemKeys.gemini
                          },
                          { 
                            id: 'openai', 
                            name: 'OpenAI (GPT)', 
                            url: 'https://platform.openai.com/api-keys',
                            systemAvailable: !!systemKeys.openai
                          },
                          { 
                            id: 'anthropic', 
                            name: 'Anthropic (Claude)', 
                            url: 'https://console.anthropic.com/settings/keys',
                            systemAvailable: !!systemKeys.anthropic
                          },
                          { 
                            id: 'custom', 
                            name: 'Universal Custom API Key', 
                            url: 'https://openrouter.ai/keys',
                            systemAvailable: false 
                          }
                        ].map((provider) => (
                          <div key={provider.id} className="space-y-2">
                            <div className="flex items-center justify-between">
                              <label className="text-[10px] font-bold uppercase tracking-widest text-[#999]">{provider.name}</label>
                              <a 
                                href={provider.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-[9px] text-black/40 hover:text-black underline flex items-center gap-1"
                              >
                                Get Key <ChevronRight className="w-2 h-2" />
                              </a>
                            </div>
                            <div className="relative">
                              <input
                                type="password"
                                value={apiKeys[provider.id as keyof typeof apiKeys]}
                                onChange={(e) => {
                                  const newKeys = { ...apiKeys, [provider.id]: e.target.value };
                                  setApiKeys(newKeys);
                                  localStorage.setItem('manga_translator_api_keys', JSON.stringify(newKeys));
                                }}
                                placeholder={provider.systemAvailable ? "Using System Key (Optional: Enter yours)" : "Enter API Key"}
                                className={`w-full px-3 py-2 bg-[#F5F5F5] border rounded-xl text-xs focus:outline-none transition-all ${
                                  apiKeys[provider.id as keyof typeof apiKeys] 
                                    ? 'border-black' 
                                    : provider.systemAvailable 
                                      ? 'border-emerald-500/30' 
                                      : 'border-[#E5E5E5] focus:border-black'
                                }`}
                              />
                              {provider.systemAvailable && !apiKeys[provider.id as keyof typeof apiKeys] && (
                                <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
                                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                  <span className="text-[8px] font-bold text-emerald-600 uppercase">System Active</span>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      <button
                        onClick={() => {
                          const emptyKeys = { gemini: '', openai: '', anthropic: '', custom: '' };
                          setApiKeys(emptyKeys);
                          localStorage.setItem('manga_translator_api_keys', JSON.stringify(emptyKeys));
                        }}
                        className="w-full py-2 border border-[#E5E5E5] text-[#999] rounded-xl text-[9px] font-bold uppercase tracking-widest hover:border-red-500/20 hover:text-red-500 transition-all flex items-center justify-center gap-2"
                      >
                        <Trash2 className="w-3 h-3" />
                        Clear All Custom Keys
                      </button>
                    </div>

                    {/* Apply Buttons */}
                    <div className="grid grid-cols-1 gap-2 pt-6 border-t border-[#F0F0F0]">
                      {isTranslating ? (
                        <button
                          onClick={stopTranslation}
                          className="w-full py-3 bg-red-500 text-white rounded-2xl text-[10px] font-bold uppercase tracking-widest hover:bg-red-600 transition-all flex items-center justify-center gap-2"
                        >
                          <X className="w-3 h-3" />
                          Stop Translation
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            const pending = pages.filter(p => p.status === 'pending' || p.status === 'error');
                            if (pending.length > 0) translateAll();
                          }}
                          disabled={pages.filter(p => p.status === 'pending' || p.status === 'error').length === 0}
                          className="w-full py-3 bg-black text-white rounded-2xl text-[10px] font-bold uppercase tracking-widest hover:bg-black/80 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          {translationEnabled ? <Languages className="w-3 h-3" /> : <Save className="w-3 h-3" />}
                          {translationEnabled ? 'Translate All Pending' : 'Process All Pending'}
                        </button>
                      )}
                      
                      {translationEnabled && (
                        <button
                          onClick={() => updateRenders(pages)}
                          disabled={isTranslating || pages.filter(p => p.status === 'completed').length === 0}
                          className="w-full py-3 border border-black text-black rounded-2xl text-[10px] font-bold uppercase tracking-widest hover:bg-black/5 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <Save className="w-3 h-3" />
                          Apply Render to All
                        </button>
                      )}

                      {translationEnabled && (
                        <button
                          onClick={async () => {
                            const completed = pages.filter(p => p.status === 'completed');
                            if (completed.length === 0) return;
                            
                            setPages(prev => prev.map(p => p.status === 'completed' ? { ...p, status: 'pending' } : p));
                            await translateAll(completed.map(p => ({ ...p, status: 'pending' })));
                          }}
                          disabled={isTranslating || pages.filter(p => p.status === 'completed').length === 0}
                          className="w-full py-3 border border-[#E5E5E5] text-[#999] rounded-2xl text-[10px] font-bold uppercase tracking-widest hover:border-black/20 hover:text-black transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-translate All
                        </button>
                      )}
                    </div>
                    <div>
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#999] mb-3">Self-Host Guide</h4>
                      <div className="text-[11px] text-[#666] leading-relaxed space-y-2">
                        <p>To run this app on your computer or Android (Termux):</p>
                        <ol className="list-decimal pl-4 space-y-1">
                          <li>Export project as ZIP from the settings menu.</li>
                          <li>Install Node.js on your computer or Termux.</li>
                          <li>Unzip and run <code className="bg-[#F5F5F5] px-1">npm install</code>.</li>
                          <li>Run <code className="bg-[#F5F5F5] px-1">npm run dev</code>.</li>
                          <li>Open the local address in your browser.</li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </motion.aside>
              </div>
            )}
          </AnimatePresence>

            {/* Main Content: Viewer */}
            <div className="flex-grow flex flex-col min-w-0 h-full max-h-full overflow-hidden">
              {pages.length > 0 && pages[currentIndex] ? (
                <div className="flex-1 flex flex-col min-w-0 h-full max-h-full overflow-hidden gap-3 pb-2">
                  
                  {/* Top Page Status & Zoom Bar */}
                  <div className="flex items-center justify-between p-3 bg-white border border-[#E5E5E5] rounded-2xl shadow-xs shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="bg-[#FAF9F5] px-3 py-1 bg-white border border-[#E5E5E5] rounded-xl flex flex-col items-start leading-none shrink-0">
                        <span className="text-[8px] uppercase font-bold tracking-wider text-[#999] mb-0.5">Page index</span>
                        <span className="text-xs font-black text-black">{currentIndex + 1} / {pages.length}</span>
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-xs sm:text-sm font-bold text-black truncate max-w-[150px] sm:max-w-[280px]">
                          {pages[currentIndex].name}
                        </h2>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            pages[currentIndex].status === 'completed' ? 'bg-emerald-500' :
                            pages[currentIndex].status === 'translating' ? 'bg-blue-500 animate-pulse' :
                            pages[currentIndex].status === 'error' ? 'bg-red-500' : 'bg-zinc-400'
                          }`} />
                          <span className="text-[9px] font-bold uppercase tracking-wider text-[#666]">
                            {pages[currentIndex].status}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Controls Bar: Zoom and Drawer toggler */}
                    <div className="flex items-center gap-2">
                      {/* Manga Layer Options / Edit Preview Toggle Buttons */}
                      {isEditing ? (
                        <div className="flex items-center gap-1 bg-[#FAF9F5] border border-[#E5E5E5] rounded-xl p-0.5 shadow-2xs mr-1">
                          <button
                            type="button"
                            onClick={() => setEditShowOriginal(false)}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[9px] font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                              !editShowOriginal 
                                ? 'bg-black text-white shadow-2xs font-black' 
                                : 'bg-white text-zinc-500 hover:text-black hover:bg-zinc-100'
                            }`}
                            title="Tampilkan versi hasil terjemahan"
                          >
                            ✨ Terjemahan
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditShowOriginal(true)}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[9px] font-extrabold uppercase tracking-wider transition-all cursor-pointer ${
                              editShowOriginal 
                                ? 'bg-black text-white shadow-2xs font-black' 
                                : 'bg-white text-zinc-500 hover:text-black hover:bg-zinc-100'
                            }`}
                            title="Tampilkan gambar asli tanpa terjemahan"
                          >
                            📷 Original
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 bg-[#FAF9F5] border border-[#E5E5E5] rounded-xl p-0.5 shadow-2xs mr-1">
                          <button
                            onClick={() => setPerformanceSettings(prev => ({ ...prev, autoCleanText: !prev.autoCleanText }))}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                              performanceSettings.autoCleanText
                                ? 'bg-amber-500 text-white shadow-2xs'
                                : 'bg-white text-zinc-500 hover:text-black hover:bg-zinc-100'
                            }`}
                            title={performanceSettings.autoCleanText ? "Manga text auto-erased (Option Active)" : "Keep original manga lettering visible"}
                          >
                            <Eraser className="w-3 h-3" />
                            <span className="hidden md:inline">Erase Text</span>
                          </button>

                          <button
                            onClick={() => setShowTranslatedText(prev => !prev)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                              showTranslatedText
                                ? 'bg-emerald-600 text-white shadow-2xs'
                                : 'bg-white text-zinc-500 hover:text-black hover:bg-zinc-100'
                            }`}
                            title={showTranslatedText ? "Translated text layer active" : "Hide text details (Keep blank patched background)"}
                          >
                            <Languages className="w-3 h-3" />
                            <span className="hidden md:inline">Translate</span>
                          </button>
                        </div>
                      )}

                      {/* Interactive Zoom Controls */}
                      <div className="flex items-center bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl p-0.5 shadow-2xs">
                        <button
                          onClick={() => setZoom(prev => Math.max(0.25, Number((prev - 0.25).toFixed(2))))}
                          className="p-1.5 hover:bg-white rounded-lg transition-all text-black hover:shadow-2xs disabled:opacity-35 cursor-pointer"
                          title="Zoom Out"
                          disabled={zoom <= 0.25}
                        >
                          <ZoomOut className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-[10px] font-mono font-bold px-2 text-center w-12 select-none">
                          {Math.round(zoom * 100)}%
                        </span>
                        <button
                          onClick={() => setZoom(prev => Math.min(4, Number((prev + 0.25).toFixed(2))))}
                          className="p-1.5 hover:bg-white rounded-lg transition-all text-black hover:shadow-2xs disabled:opacity-35 cursor-pointer"
                          title="Zoom In"
                          disabled={zoom >= 4}
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                        </button>

                        {(zoom !== 1 || panOffset.x !== 0 || panOffset.y !== 0) && (
                          <button
                            onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
                            className="p-1 px-2 bg-black text-white text-[9px] font-bold uppercase tracking-wider rounded-lg shadow-xs hover:bg-black/80 transition-all ml-1 cursor-pointer"
                            title="Reset Zoom to Fit"
                          >
                            Fit
                          </button>
                        )}
                      </div>

                      {/* Toggle side drawer */}
                      <button
                        onClick={() => setIsPageDrawerOpen(!isPageDrawerOpen)}
                        className={`flex items-center gap-1 px-3 py-1.5 rounded-xl border transition-all text-xs font-bold cursor-pointer uppercase tracking-wider ${
                          isPageDrawerOpen 
                            ? 'bg-black text-white border-black shadow-xs' 
                            : 'bg-white text-black border-[#E5E5E5] hover:bg-[#F5F5F5]'
                        }`}
                        title="Tampilkan Panel Aksi Halaman"
                      >
                        {isPageDrawerOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                        <span className="hidden sm:inline">Aksi Halaman</span>
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                          <div
                            className="shrink-0 flex flex-wrap items-center gap-1 bg-white border border-[#E5E5E5] rounded-2xl shadow-xs p-1 text-[10px] font-bold select-none"
                            onMouseDown={e => e.stopPropagation()}
                            onTouchStart={e => e.stopPropagation()}
                          >
                            {([['select', '↖ Pilih', 'Pilih / seleksi area (Q)'], ['text', '✎ Teks', 'Seret di gambar untuk membuat kotak teks (T)'], ['eraser', '🧹 Eraser', 'Seret di gambar untuk membuat area eraser (X)']] as const).map(([k, l, t]) => (
                              <button key={k} title={t} onClick={() => setDrawTool(k)} className={`px-2 py-1 rounded-lg cursor-pointer ${drawTool === k ? 'bg-black text-white' : 'hover:bg-[#F0F0F0]'}`}>{l}</button>
                            ))}
                            {selIds.length > 0 && (
                              <button title="Lepas pilihan (D / Esc / klik area kosong)" onClick={() => { setSelectedBlockId(null); setSelectedBlockIds([]); }} className="px-2 py-1 rounded-lg hover:bg-[#F0F0F0] cursor-pointer">✕ Lepas</button>
                            )}
                            <span className="w-px h-4 bg-[#E5E5E5]" />
                            {[
                              { l: '+ Teks', t: 'Tambah kotak teks di tengah (Shift+T)', f: addManualTextBlock },
                              { l: '🧹', t: 'Tambah eraser di tengah (Shift+X)', f: addManualEraserBlock },
                              { l: '↶', t: 'Undo (Ctrl+Z)', f: () => undoRedo(false) },
                              { l: '↷', t: 'Redo (Ctrl+Y)', f: () => undoRedo(true) }
                            ].map(b => (
                              <button key={b.t} title={b.t} onClick={b.f} className="px-2 py-1 rounded-lg hover:bg-[#F0F0F0] cursor-pointer">{b.l}</button>
                            ))}
                            {selIds.length > 0 && (
                              <>
                                <span className="w-px h-4 bg-[#E5E5E5]" />
                                {[
                                  { l: 'A−', t: 'Font lebih kecil ( [ )', f: () => updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) - 2, 5, 150), fontSizeLocked: true })) },
                                  { l: 'A+', t: 'Font lebih besar ( ] )', f: () => updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) + 2, 5, 150), fontSizeLocked: true })) },
                                  { l: '⬅', t: 'Rata kiri (1)', f: () => updateSelected(() => ({ align: 'left' })) },
                                  { l: '⬌', t: 'Tengah (2)', f: () => updateSelected(() => ({ align: 'center' })) },
                                  { l: '➡', t: 'Rata kanan (3)', f: () => updateSelected(() => ({ align: 'right' })) },
                                  { l: 'Horizontal', t: 'Teks horizontal (H)', f: () => updateSelected(() => ({ isVertical: false })) },
                                  { l: 'Hapus teks asli', t: 'Hidup/matikan penghapusan teks asli di bawah blok (C)', f: () => updateSelected(b => ({ eraseMode: b.eraseMode === 'none' ? 'auto' : 'none' })) }
                                ].map(b => (
                                  <button key={b.t} title={b.t} onClick={b.f} className="px-2 py-1 rounded-lg hover:bg-[#F0F0F0] cursor-pointer">{b.l}</button>
                                ))}
                                {selIds.length === 1 && (
                                  <button title="Terjemahkan ulang blok (R)" onClick={() => reTranslateBlock(selIds[0])} className="px-2 py-1 rounded-lg hover:bg-[#F0F0F0] cursor-pointer">AI ↻</button>
                                )}
                                <button title="Hapus blok (Delete)" onClick={() => deleteBlocks(selIds)} className="px-2 py-1 rounded-lg text-red-600 hover:bg-red-50 cursor-pointer">🗑 {selIds.length > 1 ? selIds.length : ''}</button>
                              </>
                            )}
                            <span className="w-px h-4 bg-[#E5E5E5]" />
                            <button title="Simpan & keluar (Ctrl+S)" onClick={saveEdits} className="px-2 py-1 rounded-lg bg-emerald-600 text-white cursor-pointer">Simpan</button>
                            <button title="Daftar shortcut (?)" onClick={() => setShowShortcuts(true)} className="px-2 py-1 rounded-lg hover:bg-[#F0F0F0] cursor-pointer">?</button>
                          </div>
                        )}

                        
                  {/* Viewer Work Area: Flex Row layout supporting the Collapsible Drawer */}
                  <div className="flex-1 flex flex-row min-w-0 h-full max-h-full overflow-hidden gap-4 relative">
                    
                    {/* Main Image Box */}
                    <div className={`flex-1 bg-gradient-to-br from-[#FAF9F5] to-white/95 border border-[#E5E5E5] rounded-3xl relative select-none flex items-center justify-center p-2 sm:p-4 overflow-hidden min-h-0 h-full transition-all duration-300 ${((isSidebarOpen || isSettingsOpen) && !isFullscreen) ? 'scale-[0.85] xs:scale-[0.9] sm:scale-100 opacity-75 sm:opacity-100 origin-center' : ''}`}>
                      
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={pages[currentIndex].id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="w-full h-full flex items-center justify-center relative select-none overflow-hidden"
                        >
                          <div
                            ref={containerRef}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            onTouchStart={handleTouchStart}
                            onTouchMove={handleTouchMove}
                            onTouchEnd={handleTouchEnd}
                            className={`relative select-none rounded-2xl bg-white border border-[#E5E5E5]/60 shadow-md ${isEditing ? 'cursor-crosshair' : (zoom > 1 ? 'cursor-grab active:cursor-grabbing' : '')}`}
                            style={{
                              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                              transformOrigin: 'center center',
                              transition: isPanning ? 'none' : 'transform 0.15s ease-out',
                              ...currentImgSize ? { aspectRatio: `${currentImgSize.w} / ${currentImgSize.h}`, height: '100%', width: 'auto', maxHeight: '100%' } : { height: '100%', width: 'auto', maxHeight: '100%' }}
                            }
                          >
                          <img
                            src={isEditing && editShowOriginal ? pages[currentIndex].originalUrl : (pages[currentIndex].translatedUrl || pages[currentIndex].originalUrl)}
                            alt={pages[currentIndex].name}
                            onLoad={(e) => {
                              setCurrentImgSize({
                                w: e.currentTarget.naturalWidth || 1,
                                h: e.currentTarget.naturalHeight || 1
                              });
                            }}
                            className="w-full h-full object-contain select-none pointer-events-none"
                          />

                        {pages[currentIndex].status === 'error' && (
                          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 z-50">
                            <div className="bg-white max-w-md w-full rounded-3xl p-6 shadow-2xl border border-[#E5E5E5] text-center flex flex-col items-center animate-fade-in">
                              <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center text-red-500 mb-4">
                                <AlertCircle className="w-6 h-6" />
                              </div>
                              <h3 className="text-lg font-bold text-gray-900 mb-2">Translation Failed</h3>
                              <p className="text-xs text-red-600 mb-4 line-clamp-4 bg-red-50/50 p-3 rounded-xl border border-red-100/50 font-mono text-left w-full overflow-y-auto max-h-32">
                                {pages[currentIndex].error || 'Manga translation encountered an issue.'}
                              </p>
                              {((pages[currentIndex].error || '').toLowerCase().includes('429') || (pages[currentIndex].error || '').toLowerCase().includes('quota') || (pages[currentIndex].error || '').toLowerCase().includes('exhausted')) && (
                                <div className="text-xs text-amber-800 bg-amber-50/80 rounded-2xl p-4 text-left w-full mb-4 border border-amber-100/50">
                                  <p className="font-bold mb-1 flex items-center gap-1.5 text-amber-900 text-xs">💡 Daily Quota Exceeded (Limit: 20 calls/day)</p>
                                  <p className="leading-relaxed text-[11px] text-amber-850">You have hit the Gemini Free Tier project quota limit. To continue translating unlimited pages immediately, please open the <strong>API Settings panel (gear icon)</strong> and enter your own free <strong>Gemini API Key</strong>.</p>
                                </div>
                              )}
                              
                              <div className="space-y-2.5 w-full">
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() => {
                                      setPages(prev => prev.map((p, i) => i === currentIndex ? { ...p, status: 'pending', error: undefined } : p));
                                    }}
                                    className="py-2.5 px-3 bg-gray-100 hover:bg-gray-250 text-gray-800 font-bold rounded-xl text-[10px] uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5 border border-gray-200"
                                    title="Reset page status back to ready/clean"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" /> Reset Pending
                                  </button>
                                  <button
                                    onClick={() => {
                                      setPages(prev => prev.map((p, i) => i === currentIndex ? { ...p, status: 'completed', error: undefined } : p));
                                    }}
                                    className="py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold rounded-xl text-[10px] uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5 border border-emerald-250"
                                    title="Skip AI translation and start adding translation text/masks manually"
                                  >
                                    <Plus className="w-3.5 h-3.5" /> Edit Manual
                                  </button>
                                </div>
                                <button
                                  onClick={() => translatePage(pages[currentIndex], undefined, 'full', true)}
                                  className="w-full py-3 px-4 bg-black hover:bg-zinc-800 text-white font-bold rounded-xl text-[10px] uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2"
                                >
                                  <Languages className="w-4 h-4 text-emerald-400 animate-pulse" /> Re-Translate Page (AI)
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        {isEditing && pages[currentIndex].textBlocks?.map(block => {
                          const activeShape = block.cleanShape !== undefined 
                            ? block.cleanShape 
                            : (block.isBalloon ? 'ellipse' : 'none');
                          const isSelected = selectedBlockId === block.id || selectedBlockIds.includes(block.id);
                          const isEraser = block.isCleanOnly;
                          
                          let borderShapeClass = 'rounded-xl';
                          if (activeShape === 'ellipse') borderShapeClass = 'rounded-full';
                          else if (activeShape === 'rect') borderShapeClass = 'rounded-none';
                          else if (activeShape === 'rounded-rect') borderShapeClass = 'rounded-2xl';
                          
                          let borderStyleClass = '';
                          if (isSelected) {
                            borderStyleClass = isEraser 
                              ? 'border-dashed border-amber-500 bg-amber-500/15 shadow-md z-20 cursor-move shadow-amber-200'
                              : 'border-emerald-500 bg-emerald-500/15 shadow-md z-20 cursor-move shadow-emerald-200';
                          } else {
                            if (isEraser) {
                              borderStyleClass = 'border-dashed border-amber-400 bg-amber-400/5 hover:border-amber-600 z-10 cursor-pointer';
                            } else {
                              borderStyleClass = block.groupId
                                ? 'border-blue-400 bg-blue-400/10 hover:border-blue-600 z-10 cursor-pointer'
                                : 'border-black/30 bg-black/5 hover:border-black/60 z-10 cursor-pointer';
                            }
                          }
                          
                          return (
                            <div
                              key={block.id}
                              onClick={(e) => handleBlockClick(e, block)}
                              onMouseDown={(e) => handleBlockMouseDown(e, block)}
                              onTouchStart={(e) => handleBlockTouchStart(e, block)}
                              className={`absolute border-2 transition-shadow select-none touch-none ${borderShapeClass} ${borderStyleClass}`}
                              style={{
                                left: `${block.x / 10}%`,
                                top: `${block.y / 10}%`,
                                width: `${block.width / 10}%`,
                                height: `${block.height / 10}%`
                              }}
                            >
                              {isEraser && (
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-1 overflow-hidden">
                                  <span className="text-[8px] font-bold bg-amber-600 text-white px-1.5 py-0.5 rounded shadow-xs opacity-90 uppercase tracking-wider truncate flex items-center gap-0.5">
                                    🧹 Eraser
                                  </span>
                                </div>
                              )}
                              
                              {(selectedBlockId === block.id || selectedBlockIds.includes(block.id)) && (
                                <>
                                  <div className={`absolute left-0 flex gap-1 z-30 ${block.y < 50 ? 'top-full mt-1' : '-top-8'}`} onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
                                    <button 
                                      onClick={(e) => { e.stopPropagation(); deleteBlock(block.id); }}
                                      className="p-1 bg-red-500 text-white rounded shadow-sm hover:bg-red-600 cursor-pointer"
                                      title="Hapus Blok"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                    {block.groupId && (
                                      <button 
                                        onClick={(e) => { e.stopPropagation(); ungroupBlocks(block.groupId!); }}
                                        className="p-1 bg-blue-500 text-white rounded shadow-sm hover:bg-blue-600 cursor-pointer"
                                        title="Ungroup"
                                      >
                                        <Ungroup className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>

                                  {/* Resize Handles */}
                                  <div 
                                    className="absolute w-3 h-3 bg-emerald-550 border border-white rounded-full -top-1.5 -left-1.5 cursor-nwse-resize z-30 shadow-md hover:scale-125 transition-transform"
                                    onMouseDown={(e) => handleResizeHandleMouseDown(e, block, 'tl')}
                                    onTouchStart={(e) => handleResizeHandleTouchStart(e, block, 'tl')}
                                  />
                                  <div 
                                    className="absolute w-3 h-3 bg-emerald-550 border border-white rounded-full -top-1.5 -right-1.5 cursor-nesw-resize z-30 shadow-md hover:scale-125 transition-transform"
                                    onMouseDown={(e) => handleResizeHandleMouseDown(e, block, 'tr')}
                                    onTouchStart={(e) => handleResizeHandleTouchStart(e, block, 'tr')}
                                  />
                                  <div 
                                    className="absolute w-3 h-3 bg-emerald-550 border border-white rounded-full -bottom-1.5 -left-1.5 cursor-nesw-resize z-30 shadow-md hover:scale-125 transition-transform"
                                    onMouseDown={(e) => handleResizeHandleMouseDown(e, block, 'bl')}
                                    onTouchStart={(e) => handleResizeHandleTouchStart(e, block, 'bl')}
                                  />
                                  <div 
                                    className="absolute w-3 h-3 bg-emerald-550 border border-white rounded-full -bottom-1.5 -right-1.5 cursor-nwse-resize z-30 shadow-md hover:scale-125 transition-transform"
                                    onMouseDown={(e) => handleResizeHandleMouseDown(e, block, 'br')}
                                    onTouchStart={(e) => handleResizeHandleTouchStart(e, block, 'br')}
                                  />
                                </>
                              )}
                              {block.groupId && !selectedBlockId && !selectedBlockIds.includes(block.id) && (
                                <div className="absolute top-0 right-0 p-0.5 bg-blue-400 text-white rounded-bl-sm">
                                  <Layers className="w-2 h-2" />
                                </div>
                              )}
                            </div>
                          );
                        })}

                        {isEditing && (pages[currentIndex]?.textBlocks || []).filter(b => selIds.includes(b.id) && !b.isCleanOnly && b.eraseMode !== 'none').map(b => {
                          const f = b.eraseFollow || b.srcX === undefined;
                          const sx = f ? b.x : b.srcX!;
                          const sy = f ? b.y : b.srcY!;
                          const sw = f ? b.width : b.srcW!;
                          const sh = f ? b.height : b.srcH!;
                          return (
                            <div key={'src-' + b.id} className="absolute border border-dashed border-red-500 bg-red-500/10 pointer-events-none z-30" style={{ left: `${sx / 10}%`, top: `${sy / 10}%`, width: `${sw / 10}%`, height: `${sh / 10}%` }}>
                              <div title="Geser area hapus teks asli" onMouseDown={e => startSrcDrag(e, b, 'move')} className="absolute -top-2.5 -left-2.5 w-3.5 h-3.5 rounded-sm bg-red-500 cursor-move pointer-events-auto" />
                              <div title="Ubah ukuran area hapus" onMouseDown={e => startSrcDrag(e, b, 'resize')} className="absolute -bottom-2.5 -right-2.5 w-3.5 h-3.5 rounded-sm bg-red-500 cursor-nwse-resize pointer-events-auto" />
                            </div>
                          );
                        })}

                        {drawingBox && (
                          <div 
                            className="absolute border-2 border-emerald-500 bg-emerald-500/10 z-30 pointer-events-none"
                            style={{
                              left: `${(drawingBox.w < 0 ? drawingBox.x + drawingBox.w : drawingBox.x) / 10}%`,
                              top: `${(drawingBox.h < 0 ? drawingBox.y + drawingBox.h : drawingBox.y) / 10}%`,
                              width: `${Math.abs(drawingBox.w) / 10}%`,
                              height: `${Math.abs(drawingBox.h) / 10}%`
                            }}
                          />
                        )}
                        </div>
                      </motion.div>
                    </AnimatePresence>

                    {/* Floating Side Page Chevrons (Available in both view and edit modes) */}
                    <div className="absolute inset-y-0 left-2 z-30 w-12 md:w-16 flex items-center justify-center pointer-events-none">
                      <button
                        onClick={() => {
                          if (currentIndex > 0) {
                            setCurrentIndex(prev => prev - 1);
                            setSelectedBlockId(null);
                            setSelectedBlockIds([]);
                          }
                        }}
                        disabled={currentIndex === 0}
                        className="p-2.5 md:p-3 bg-white/90 hover:bg-black hover:text-white backdrop-blur-md rounded-full shadow-xl disabled:opacity-0 transition-all cursor-pointer pointer-events-auto border border-[#E5E5E5] text-black group"
                        title="Halaman Sebelumnya"
                      >
                        <ChevronLeft className="w-5 h-5 md:w-6 md:h-6 group-hover:-translate-x-0.5 transition-transform" />
                      </button>
                    </div>
                    <div className="absolute inset-y-0 right-2 z-30 w-12 md:w-16 flex items-center justify-center pointer-events-none">
                      <button
                        onClick={() => {
                          if (currentIndex < pages.length - 1) {
                            setCurrentIndex(prev => prev + 1);
                            setSelectedBlockId(null);
                            setSelectedBlockIds([]);
                          }
                        }}
                        disabled={currentIndex === pages.length - 1}
                        className="p-2.5 md:p-3 bg-white/90 hover:bg-black hover:text-white backdrop-blur-md rounded-full shadow-xl disabled:opacity-0 transition-all cursor-pointer pointer-events-auto border border-[#E5E5E5] text-black group"
                        title="Halaman Berikutnya"
                      >
                        <ChevronRight className="w-5 h-5 md:w-6 md:h-6 group-hover:translate-x-0.5 transition-transform" />
                      </button>
                    </div>
                  </div>

                  {/* Right-Side Page Actions Drawer (collapsible menu) */}
                  <AnimatePresence>
                    {isPageDrawerOpen && (
                      <motion.aside
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: drawerW, opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ type: "spring", damping: 26, stiffness: 225 }}
                        className="h-full bg-white rounded-3xl border border-[#E5E5E5] flex flex-col overflow-hidden shadow-2xl shrink-0 text-left font-sans"
                      >
                        <div className="p-4 border-b border-[#F0F0F0] flex items-center justify-between shrink-0 bg-gray-50/50">
                          <div className="flex items-center gap-2">
                            {isEditing ? <Edit3 className="w-4 h-4 text-black" /> : <Layers className="w-4 h-4 text-[#555]" />}
                            <h3 className="font-bold text-xs tracking-wider uppercase text-black">{isEditing ? 'Mode Edit Balon' : 'Aksi Halaman'}</h3>
                          </div>
                          <button 
                            onClick={() => setIsPageDrawerOpen(false)} 
                            className="p-1.5 hover:bg-[#F5F5F5] rounded-full cursor-pointer text-gray-500 hover:text-black"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                          {isEditing ? (
                            /* Drawer-Inlined Bubbles Editing Panel */
                            <div className="space-y-4">
                              {/* Page Navigation inside Edit Mode */}
                              <div className="flex items-center justify-between gap-2 p-2 bg-[#F9F9FB] border border-[#E5E5E5] rounded-xl shadow-xs">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (currentIndex > 0) {
                                      setCurrentIndex(currentIndex - 1);
                                      setSelectedBlockId(null);
                                      setSelectedBlockIds([]);
                                    }
                                  }}
                                  disabled={currentIndex === 0}
                                  className="p-1.5 hover:bg-gray-100 border border-gray-200/50 hover:border-gray-300 disabled:opacity-30 rounded-lg text-black cursor-pointer transition-colors disabled:cursor-not-allowed bg-white shadow-xs"
                                  title="Halaman Sebelumnya"
                                >
                                  <ChevronLeft className="w-4 h-4" />
                                </button>
                                <span className="text-xs font-bold font-mono text-gray-700">
                                  Halaman {currentIndex + 1} / {pages.length}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (currentIndex < pages.length - 1) {
                                      setCurrentIndex(currentIndex + 1);
                                      setSelectedBlockId(null);
                                      setSelectedBlockIds([]);
                                    }
                                  }}
                                  disabled={currentIndex === pages.length - 1}
                                  className="p-1.5 hover:bg-gray-100 border border-gray-200/50 hover:border-gray-300 disabled:opacity-30 rounded-lg text-black cursor-pointer transition-colors disabled:cursor-not-allowed bg-white shadow-xs"
                                  title="Halaman Berikutnya"
                                >
                                  <ChevronRight className="w-4 h-4" />
                                </button>
                              </div>
                              <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-xl">
                                <p className="text-[11px] font-bold text-emerald-800 mb-0.5">Mode Edit Aktif</p>
                                <p className="text-[10px] text-emerald-700 leading-relaxed">
                                  • Drag mouse di atas gambar untuk membuat balon teks baru.<br/>
                                  • Klik pada kotak di atas gambar untuk mengedit teks atau menghapus balon.
                                </p>
                              </div>

                              <div className="space-y-2">
                                {selectedBlockIds.length >= 2 && (
                                  <button
                                    onClick={groupSelectedBlocks}
                                    className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-sm shadow-blue-700/20"
                                  >
                                    <Layers className="w-4 h-4" />
                                    Group ({selectedBlockIds.length})
                                  </button>
                                )}
                                <div className="grid grid-cols-2 gap-2 w-full">
                                  <button
                                    onClick={addManualTextBlock}
                                    className="flex items-center justify-center gap-1.5 py-2 bg-[#F5F5F5] hover:bg-[#EAEAEA] border border-[#E5E5E5] text-black font-bold text-[10px] uppercase tracking-wider rounded-xl transition-all cursor-pointer"
                                    title="Tambah Kotak Teks Manual"
                                  >
                                    <Plus className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                    Teks Manual
                                  </button>
                                  <button
                                    onClick={addManualEraserBlock}
                                    className="flex items-center justify-center gap-1.5 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 font-bold text-[10px] uppercase tracking-wider rounded-xl transition-all cursor-pointer"
                                    title="Tambah Mask Masking/Penghapus Teks Bulat/Oval"
                                  >
                                    <Eraser className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                    Mask Eraser
                                  </button>
                                </div>
                                <button
                                  onClick={saveEdits}
                                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-sm shadow-emerald-700/20"
                                >
                                  <Save className="w-4 h-4" />
                                  Simpan Perubahan
                                </button>
                                <button
                                  onClick={() => { setIsEditing(false); setSelectedBlockId(null); setSelectedBlockIds([]); }}
                                  className="w-full flex items-center justify-center gap-2 py-2 bg-white hover:bg-gray-100 border border-[#E5E5E5] text-gray-600 font-bold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer"
                                >
                                  Kembali ke Review
                                </button>
                              </div>

                              {(() => {
                                const blocks = pages[currentIndex].textBlocks || [];
                                if (!blocks.length) return null;
                                const allSel = blocks.every(b => selIds.includes(b.id));
                                return (
                                  <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                                      <span>Blok teks ({blocks.length})</span>
                                      <span className="flex gap-1 normal-case">
                                        <button onClick={() => { setSelectedBlockId(null); setSelectedBlockIds(allSel ? [] : blocks.map(b => b.id)); }} className="px-1.5 py-0.5 rounded border border-[#E5E5E5] cursor-pointer">{allSel ? 'Batal' : 'Semua'}</button>
                                        {selIds.length > 0 && <button onClick={() => deleteBlocks(selIds)} className="px-1.5 py-0.5 rounded bg-red-600 text-white cursor-pointer">🗑 {selIds.length}</button>}
                                      </span>
                                    </div>
                                    <div onPointerDown={e => beginDS(e, 'blocks')} className="max-h-44 overflow-y-auto rounded-xl border border-[#E5E5E5] divide-y divide-[#F0F0F0] select-none custom-scrollbar">
                                      {blocks.map((b, i) => {
                                        const on = selIds.includes(b.id);
                                        return (
                                          <div key={b.id} data-ds-group="blocks" data-ds-idx={i}
                                            onClick={() => { if (Date.now() - suppressClickRef.current < 300) return; setSelectedBlockId(b.id); setSelectedBlockIds([]); }}
                                            className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer text-[11px] ${on ? 'bg-emerald-50' : 'hover:bg-[#F7F7F7]'}`}>
                                            <button onClick={e => { e.stopPropagation(); setSelectedBlockId(null); setSelectedBlockIds(on ? selIds.filter(x => x !== b.id) : [...selIds, b.id]); }}
                                              className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center text-[9px] ${on ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-[#BBB] bg-white'}`}>{on ? '✓' : ''}</button>
                                            <span className="text-zinc-400 w-4 shrink-0">{i + 1}</span>
                                            <span className="truncate">{b.isCleanOnly ? '🧹 Eraser' : (b.translatedText || b.originalText || '(kosong)')}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}

                              {selIds.length > 0 && (() => {
                                const sel = (pages[currentIndex].textBlocks || []).filter(b => selIds.includes(b.id) && !b.isCleanOnly);
                                const f = sel[0];
                                if (!f) return null;
                                const num = (n: number | undefined, d = 0) => (n === undefined ? d : n);
                                const btn = (on: boolean) => `px-2 py-1 rounded-lg border text-[10px] font-bold cursor-pointer ${on ? 'bg-black text-white border-black' : 'bg-white border-[#E5E5E5] hover:bg-[#F5F5F5]'}`;
                                const slider = (label: string, key: 'strokeW' | 'shadowBlur' | 'glowBlur', max: number, colorKey: 'strokeColor' | 'shadowColor' | 'glowColor', defColor: string) => (
                                  <div className="space-y-1">
                                    <div className="flex items-center justify-between text-[10px] font-bold text-zinc-500">
                                      <span>{label}{f[key] !== undefined ? ` · ${f[key]}` : ' · auto'}</span>
                                      <span className="flex items-center gap-1">
                                        <input type="color" value={(f[colorKey] as string) || defColor} onChange={e => updateSelected(() => ({ [colorKey]: e.target.value }))} className="w-5 h-5 p-0 border border-[#DDD] rounded cursor-pointer" />
                                        <button onClick={() => updateSelected(() => ({ [key]: undefined, [colorKey]: undefined }))} className="px-1 rounded border border-[#E5E5E5] cursor-pointer">reset</button>
                                      </span>
                                    </div>
                                    <input type="range" min={0} max={max} value={num(f[key])} onChange={e => updateSelected(() => ({ [key]: Number(e.target.value) }))} className="w-full accent-black" />
                                  </div>
                                );
                                return (
                                  <div className="space-y-2.5 p-3 rounded-2xl border border-[#E5E5E5] bg-[#FAFAFA]">
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Gaya &amp; Efek · {sel.length} blok</div>
                                    <div className="flex flex-wrap gap-1">
                                      <button onClick={() => updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) - 2, 5, 150), fontSizeLocked: true }))} className={btn(false)}>A−</button>
                                      <button onClick={() => updateSelected(b => ({ fontSize: clampNum((b.fontSize || 24) + 2, 5, 150), fontSizeLocked: true }))} className={btn(false)}>A+</button>
                                      <button onClick={() => updateSelected(() => ({ align: 'left' }))} className={btn(f.align === 'left')}>⬅</button>
                                      <button onClick={() => updateSelected(() => ({ align: 'center' }))} className={btn(!f.align || f.align === 'center')}>⬌</button>
                                      <button onClick={() => updateSelected(() => ({ align: 'right' }))} className={btn(f.align === 'right')}>➡</button>
                                      <button onClick={() => updateSelected(b => ({ fontStyle: b.fontStyle === 'bold' || b.fontStyle === 'bold-italic' ? (b.fontStyle === 'bold' ? 'normal' : 'italic') : (b.fontStyle === 'italic' ? 'bold-italic' : 'bold') }))} className={btn(!!f.fontStyle && f.fontStyle.includes('bold'))}><b>B</b></button>
                                      <button onClick={() => updateSelected(b => ({ fontStyle: b.fontStyle === 'italic' || b.fontStyle === 'bold-italic' ? (b.fontStyle === 'italic' ? 'normal' : 'bold') : (b.fontStyle === 'bold' ? 'bold-italic' : 'italic') }))} className={btn(!!f.fontStyle && f.fontStyle.includes('italic'))}><i>I</i></button>
                                      <button onClick={() => updateSelected(() => ({ isVertical: false }))} className={btn(!f.isVertical)}>Horizontal</button>
                                      <button onClick={() => updateSelected(() => ({ isVertical: true }))} className={btn(!!f.isVertical)}>Vertikal</button>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <select value={f.fontFamily || ''} onChange={e => updateSelected(() => ({ fontFamily: e.target.value }))} className="flex-1 min-w-0 text-[11px] border border-[#E5E5E5] rounded-lg px-2 py-1 bg-white">
                                        <option value="">(font default)</option>
                                        <option value={'"Comic Neue", cursive'}>Comic Neue</option>
                                        <option value={'"Bangers", cursive'}>Bangers</option>
                                        <option value={'"Architects Daughter", cursive'}>Architects Daughter</option>
                                        <option value={'"Fredoka", sans-serif'}>Fredoka</option>
                                        <option value={'"Inter", sans-serif'}>Inter</option>
                                      </select>
                                      <label className="flex items-center gap-1 text-[10px] font-bold text-zinc-500">Warna
                                        <input type="color" value={f.color || '#000000'} onChange={e => updateSelected(() => ({ color: e.target.value }))} className="w-5 h-5 p-0 border border-[#DDD] rounded cursor-pointer" />
                                      </label>
                                    </div>
                                    {slider('Stroke', 'strokeW', 30, 'strokeColor', '#FFFFFF')}
                                    {slider('Bayangan', 'shadowBlur', 20, 'shadowColor', '#000000')}
                                    {slider('Glow', 'glowBlur', 30, 'glowColor', '#FFFFFF')}
                                    <div className="space-y-1">
                                      <div className="text-[10px] font-bold text-zinc-500">Area hapus teks asli (kotak merah putus-putus, bisa digeser)</div>
                                      <div className="flex flex-wrap gap-1">
                                        <button onClick={() => updateSelected(() => ({ eraseFollow: false }))} className={btn(!f.eraseFollow)}>Tetap</button>
                                        <button onClick={() => updateSelected(() => ({ eraseFollow: true }))} className={btn(!!f.eraseFollow)}>Ikut kotak</button>
                                        <button onClick={() => updateSelected(b => ({ srcX: b.x, srcY: b.y, srcW: b.width, srcH: b.height, eraseFollow: false }))} className={btn(false)}>Set = kotak</button>
                                      </div>
                                    </div>
                                    <div className="space-y-1">
                                      <div className="text-[10px] font-bold text-zinc-500">Masking penutup teks asli</div>
                                      <div className="flex flex-wrap items-center gap-1">
                                        {([['auto', 'Auto'], ['ellipse', 'Oval'], ['rounded-rect', 'Rounded'], ['rect', 'Siku'], ['none', 'Off']] as const).map(([v, l]) => (
                                          <button key={v} onClick={() => updateSelected(() => ({ cleanShape: v }))} className={btn((f.cleanShape || 'auto') === v)}>{l}</button>
                                        ))}
                                        <input type="color" title="Warna penutup" value={f.cleanColor || '#FFFFFF'} onChange={e => updateSelected(() => ({ cleanColor: e.target.value }))} className="w-5 h-5 p-0 border border-[#DDD] rounded cursor-pointer" />
                                        <button onClick={() => updateSelected(b => ({ eraseMode: b.eraseMode === 'none' ? 'auto' : 'none' }))} className={btn(f.eraseMode === 'none')}>{f.eraseMode === 'none' ? 'Hapus asli: OFF' : 'Hapus asli: ON'}</button>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}

                              {selectedBlockId && (() => {
                                const currentBlock = pages[currentIndex].textBlocks?.find(b => b.id === selectedBlockId);
                                if (!currentBlock) return null;
                                return (
                                  <div className="pt-4 border-t border-[#F0F0F0] space-y-4 animate-fade-in">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Parameter Blok</span>
                                      {!currentBlock.isCleanOnly && (
                                        <button 
                                          onClick={() => reTranslateBlock(selectedBlockId)}
                                          className="flex items-center gap-1 px-2 py-1 bg-black text-white hover:bg-black/90 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all cursor-pointer"
                                        >
                                          <RotateCcw className="w-3.5 h-3.5" />
                                          AI Translate
                                        </button>
                                      )}
                                    </div>

                                    {/* Tipe Blok Selector */}
                                    <div className="space-y-1">
                                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Tipe Blok</label>
                                      <div className="grid grid-cols-2 bg-[#F5F5F5] border border-[#E5E5E5] p-0.5 rounded-xl gap-0.5 shadow-inner">
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { isCleanOnly: false })}
                                          className={`py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                                            !currentBlock.isCleanOnly
                                              ? 'bg-white text-emerald-600 shadow-xs' : 'text-zinc-500 hover:text-black hover:bg-white/55'
                                          }`}
                                        >
                                          Teks Translasi
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { isCleanOnly: true, translatedText: '' })}
                                          className={`py-1 rounded-lg text-xs font-semibold cursor-pointer transition-all ${
                                            currentBlock.isCleanOnly
                                              ? 'bg-amber-500 text-white shadow-xs' : 'text-zinc-500 hover:text-black hover:bg-white/55'
                                          }`}
                                        >
                                          🧹 Mask Eraser
                                        </button>
                                      </div>
                                    </div>

                                    {/* Shape Selection */}
                                    <div className="space-y-1">
                                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Bentuk Masking (Eraser Shape)</label>
                                      <div className="grid grid-cols-4 bg-[#F5F5F5] border border-[#E5E5E5] p-0.5 rounded-xl gap-0.5 text-[10px]">
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { cleanShape: 'ellipse' })}
                                          className={`py-1.5 rounded-lg font-medium cursor-pointer text-center transition-all ${
                                            (currentBlock.cleanShape !== undefined 
                                              ? currentBlock.cleanShape 
                                              : (currentBlock.isBalloon ? 'ellipse' : 'none')) === 'ellipse'
                                              ? 'bg-white text-black font-bold shadow-xs' : 'text-zinc-500 hover:text-black'
                                          }`}
                                          title="Sangat cocok untuk balon kata oval"
                                        >
                                          ⭕ Oval
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { cleanShape: 'rounded-rect' })}
                                          className={`py-1.5 rounded-lg font-medium cursor-pointer text-center transition-all ${
                                            (currentBlock.cleanShape !== undefined 
                                              ? currentBlock.cleanShape 
                                              : (currentBlock.isBalloon ? 'ellipse' : 'none')) === 'rounded-rect'
                                              ? 'bg-white text-black font-bold shadow-xs' : 'text-zinc-500 hover:text-black'
                                          }`}
                                        >
                                          Rounded
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { cleanShape: 'rect' })}
                                          className={`py-1.5 rounded-lg font-medium cursor-pointer text-center transition-all ${
                                            (currentBlock.cleanShape !== undefined 
                                              ? currentBlock.cleanShape 
                                              : (currentBlock.isBalloon ? 'ellipse' : 'none')) === 'rect'
                                              ? 'bg-white text-black font-bold shadow-xs' : 'text-zinc-500 hover:text-black'
                                          }`}
                                        >
                                          Siku
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => updateBlockAndRender(selectedBlockId!, { cleanShape: 'none' })}
                                          className={`py-1.5 rounded-lg font-medium cursor-pointer text-center transition-all ${
                                            (currentBlock.cleanShape !== undefined 
                                              ? currentBlock.cleanShape 
                                              : (currentBlock.isBalloon ? 'ellipse' : 'none')) === 'none'
                                              ? 'bg-white text-black font-bold shadow-xs' : 'text-zinc-500 hover:text-black'
                                          }`}
                                          title="Jangan bersihkan background"
                                        >
                                          None
                                        </button>
                                      </div>
                                    </div>

                                    {/* Custom Colors Picker Selection Row */}
                                    <div className="grid grid-cols-2 gap-3 pb-1">
                                      <div className="space-y-1">
                                        <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">Warna Masking</label>
                                        <div className="flex items-center gap-1">
                                          <input
                                            type="color"
                                            value={currentBlock.cleanColor || '#FFFFFF'}
                                            onChange={(e) => updateBlockAndRender(selectedBlockId!, { cleanColor: e.target.value })}
                                            className="w-7 h-7 p-0 rounded-full border border-gray-300 cursor-pointer overflow-hidden bg-transparent"
                                            title="Pilih Warna Kustom"
                                          />
                                          <div className="flex gap-0.5">
                                            {['#FFFFFF', '#000000', '#FFFDF4'].map((col) => (
                                              <button
                                                key={col}
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { cleanColor: col })}
                                                className="w-4 h-4 rounded-full border border-gray-300 cursor-pointer transition-transform hover:scale-110"
                                                style={{ backgroundColor: col }}
                                              />
                                            ))}
                                          </div>
                                        </div>
                                      </div>

                                      {!currentBlock.isCleanOnly && (
                                        <div className="space-y-1">
                                          <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block">Warna Teks</label>
                                          <div className="flex items-center gap-1">
                                            <input
                                              type="color"
                                              value={currentBlock.color || '#000000'}
                                              onChange={(e) => updateBlockAndRender(selectedBlockId!, { color: e.target.value })}
                                              className="w-7 h-7 p-0 rounded-full border border-gray-300 cursor-pointer overflow-hidden bg-transparent"
                                              title="Pilih Warna Teks"
                                            />
                                            <div className="flex gap-0.5">
                                              {['#000000', '#FFFFFF', '#EF4444'].map((col) => (
                                                <button
                                                  key={col}
                                                  type="button"
                                                  onClick={() => updateBlockAndRender(selectedBlockId!, { color: col })}
                                                  className="w-4 h-4 rounded-full border border-gray-300 cursor-pointer transition-transform hover:scale-110"
                                                  style={{ backgroundColor: col }}
                                                />
                                              ))}
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    {currentBlock.isCleanOnly ? (
                                      <div className="p-3.5 bg-amber-50 rounded-2xl border border-amber-200/50 text-amber-900 text-[11px] leading-relaxed">
                                        ✨ <strong>Mode Masking Aktif:</strong> Blok ini digunakan semata-mata untuk menimpa teks bahasa Jepang di balon kata dengan bentuk visual oval/kotak bersih, tanpa menaruh tulisan baru di atasnya.
                                      </div>
                                    ) : (
                                      <>
                                        <div className="space-y-1">
                                          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Teks Terjemahan</label>
                                          <textarea
                                            value={currentBlock.translatedText || ''}
                                            onChange={(e) => updateBlockAndRender(selectedBlockId, { translatedText: e.target.value })}
                                            className="w-full px-3 py-2 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-sm focus:outline-none focus:border-black transition-all min-h-[90px] font-medium"
                                            placeholder="Tulis translasi..."
                                          />
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                          <div className="space-y-1">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Ukuran Font</label>
                                            <div className="flex items-center gap-1">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const currentVal = currentBlock.fontSize || 30;
                                                  updateBlockAndRender(selectedBlockId, { fontSize: Math.max(5, currentVal - 2), fontSizeLocked: true });
                                                }}
                                                className="px-2.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded-lg text-xs hover:bg-gray-100 cursor-pointer font-bold select-none"
                                              >
                                                -
                                              </button>
                                              <input
                                                type="number"
                                                value={currentBlock.fontSize || 30}
                                                onChange={(e) => updateBlockAndRender(selectedBlockId, { fontSize: parseInt(e.target.value) || 12, fontSizeLocked: true })}
                                                className="w-full px-2 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-xs font-mono text-center"
                                              />
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const currentVal = currentBlock.fontSize || 30;
                                                  updateBlockAndRender(selectedBlockId, { fontSize: Math.min(150, currentVal + 2), fontSizeLocked: true });
                                                }}
                                                className="px-2.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded-lg text-xs hover:bg-gray-100 cursor-pointer font-bold select-none"
                                              >
                                                +
                                              </button>
                                            </div>
                                          </div>

                                          <div className="space-y-1">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Align</label>
                                            <div className="grid grid-cols-3 bg-[#F5F5F5] border border-[#E5E5E5] p-0.5 rounded-xl">
                                              <button
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { align: 'left' })}
                                                className={`p-1 flex items-center justify-center rounded-lg cursor-pointer ${
                                                  (currentBlock.align || 'center') === 'left'
                                                    ? 'bg-white shadow-xs text-black font-semibold' : 'text-zinc-450 hover:text-black'
                                                }`}
                                              >
                                                <AlignLeft className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { align: 'center' })}
                                                className={`p-1 flex items-center justify-center rounded-lg cursor-pointer ${
                                                  (currentBlock.align || 'center') === 'center'
                                                    ? 'bg-white shadow-xs text-black font-semibold' : 'text-zinc-455 hover:text-black'
                                                }`}
                                              >
                                                <AlignCenter className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { align: 'right' })}
                                                className={`p-1 flex items-center justify-center rounded-lg cursor-pointer ${
                                                  (currentBlock.align || 'center') === 'right'
                                                    ? 'bg-white shadow-xs text-black font-semibold' : 'text-zinc-450 hover:text-black'
                                                }`}
                                              >
                                                <AlignRight className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          </div>

                                          <div className="space-y-1">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Style</label>
                                            <select
                                              value={currentBlock.fontStyle || 'normal'}
                                              onChange={(e) => updateBlockAndRender(selectedBlockId, { fontStyle: e.target.value as any })}
                                              className="w-full px-2 py-1.5 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-xs cursor-pointer focus:outline-none"
                                            >
                                              <option value="normal">Normal</option>
                                              <option value="bold">Bold</option>
                                              <option value="italic">Italic</option>
                                              <option value="bold-italic">Bold Italic</option>
                                            </select>
                                          </div>

                                          <div className="space-y-1">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Jenis Font</label>
                                            <select
                                              value={currentBlock.fontFamily || ''}
                                              onChange={(e) => updateBlockAndRender(selectedBlockId, { fontFamily: e.target.value || undefined })}
                                              className="w-full px-2 py-1.5 bg-[#F5F5F5] border border-[#E5E5E5] rounded-xl text-xs cursor-pointer focus:outline-none"
                                            >
                                              <option value="">Gunakan Global</option>
                                              <option value='"Comic Neue", cursive'>Manga (Comic)</option>
                                              <option value='"Fredoka", sans-serif'>Rounded</option>
                                              <option value='"Bangers", cursive'>Action/Yell</option>
                                              <option value='"Architects Daughter", cursive'>Handwrite</option>
                                              <option value='"Inter", sans-serif'>Modern Sans</option>
                                              <option value='serif'>Classic Serif</option>
                                            </select>
                                          </div>

                                          <div className="space-y-1">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block">Padding</label>
                                            <div className="flex items-center gap-1.5 mt-1">
                                              <input
                                                type="range"
                                                min="0"
                                                max="40"
                                                value={currentBlock.padding !== undefined ? currentBlock.padding : fontSettings.boxPadding}
                                                onChange={(e) => updateBlockAndRender(selectedBlockId, { padding: parseInt(e.target.value) })}
                                                className="grow bg-gray-200 accent-black rounded cursor-pointer h-1"
                                              />
                                              <span className="text-[10px] font-mono text-zinc-500 shrink-0 w-8 text-right">
                                                {(currentBlock.padding !== undefined ? currentBlock.padding : fontSettings.boxPadding)}px
                                              </span>
                                            </div>
                                          </div>

                                          <div className="space-y-1 col-span-2 pt-2.5 border-t border-gray-150">
                                            <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 block mb-1">Arah Teks (Text Direction)</label>
                                            <div className="grid grid-cols-2 bg-[#F5F5F5] border border-[#E5E5E5] p-0.5 rounded-xl gap-0.5 shadow-xs">
                                              <button
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { isVertical: false })}
                                                className={`py-1.5 rounded-lg text-center font-bold text-[10px] uppercase tracking-wider cursor-pointer transition-all ${
                                                  !currentBlock.isVertical
                                                    ? 'bg-white text-black shadow-xs font-[900]' : 'text-zinc-500 hover:text-black hover:bg-white/50'
                                                }`}
                                              >
                                                Horizontal ⇄
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => updateBlockAndRender(selectedBlockId!, { isVertical: true })}
                                                className={`py-1.5 rounded-lg text-center font-bold text-[10px] uppercase tracking-wider cursor-pointer transition-all ${
                                                  currentBlock.isVertical
                                                    ? 'bg-indigo-600 text-white shadow-xs font-[900]' : 'text-zinc-500 hover:text-black hover:bg-white/50'
                                                }`}
                                                title="Teks vertikal (membaca atas ke bawah, kolom kanan ke kiri)"
                                              >
                                                Vertikal ⬇
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      </>
                                    )}

                                    <div className="space-y-1 col-span-2 pt-2 border-t border-gray-150">
                                      <label className="text-[9px] font-bold uppercase tracking-widest text-zinc-400 block mb-1">Posisi & Dimensi (X, Y, W, H)</label>
                                      <div className="grid grid-cols-4 gap-1.5">
                                        <input
                                          type="number"
                                          value={Math.round(currentBlock.x || 0)}
                                          onChange={(e) => updateBlockAndRender(selectedBlockId, { x: parseInt(e.target.value) || 0 })}
                                          className="px-1.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded text-center text-[10px] font-mono"
                                          title="X coordinate"
                                        />
                                        <input
                                          type="number"
                                          value={Math.round(currentBlock.y || 0)}
                                          onChange={(e) => updateBlockAndRender(selectedBlockId, { y: parseInt(e.target.value) || 0 })}
                                          className="px-1.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded text-center text-[10px] font-mono"
                                          title="Y coordinate"
                                        />
                                        <input
                                          type="number"
                                          value={Math.round(currentBlock.width || 0)}
                                          onChange={(e) => updateBlockAndRender(selectedBlockId, { width: parseInt(e.target.value) || 1 })}
                                          className="px-1.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded text-center text-[10px] font-mono"
                                          title="Width"
                                        />
                                        <input
                                          type="number"
                                          value={Math.round(currentBlock.height || 0)}
                                          onChange={(e) => updateBlockAndRender(selectedBlockId, { height: parseInt(e.target.value) || 1 })}
                                          className="px-1.5 py-1 bg-[#F5F5F5] border border-[#E5E5E5] rounded text-center text-[10px] font-mono"
                                          title="Height"
                                        />
                                      </div>
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => deleteBlock(selectedBlockId)}
                                      className="w-full py-2 bg-red-50 hover:bg-red-100 text-red-650 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" /> Hapus Balon Ini
                                    </button>
                                  </div>
                                );
                              })()}
                            </div>
                          ) : (
                            /* Standard View Page Actions Drawer */
                            <div className="space-y-4">
                              <div className="p-3 bg-[#FAF9F5] border border-[#E5E5E5] rounded-2xl">
                                <span className="text-[10px] uppercase font-bold tracking-widest text-[#999] block mb-2">Export Halaman</span>
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    onClick={() => {
                                      if (activeBatchId) {
                                        const completedSelected = pages.filter(p => p.selected && p.status === 'completed');
                                        addBatchToPdfQueue(activeBatchId, completedSelected.length > 0 ? completedSelected : undefined);
                                      }
                                    }}
                                    disabled={!pages.some(p => p.status === 'completed')}
                                    className="flex flex-col items-center justify-center p-3.5 bg-white hover:bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl transition-all disabled:opacity-40 cursor-pointer text-center"
                                  >
                                    <FileText className="w-5 h-5 text-blue-500 mb-1" />
                                    <span className="text-[9px] font-[900] text-black uppercase tracking-wider">Export PDF</span>
                                  </button>
                                  <button
                                    onClick={() => exportToZip(pages.filter(p => p.selected && p.status === 'completed').length > 0 ? pages.filter(p => p.selected && p.status === 'completed') : undefined)}
                                    disabled={!pages.some(p => p.status === 'completed')}
                                    className="flex flex-col items-center justify-center p-3.5 bg-white hover:bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl transition-all disabled:opacity-40 cursor-pointer text-center"
                                  >
                                    <Archive className="w-5 h-5 text-emerald-500 mb-1" />
                                    <span className="text-[9px] font-[900] text-black uppercase tracking-wider">Export ZIP</span>
                                  </button>
                                </div>
                              </div>

                              <div className="space-y-3">
                                <span className="text-[10px] uppercase font-bold tracking-widest text-[#999] block mb-1">Aksi Translasi</span>
                                {isTranslating ? (
                                  <div className="p-3.5 bg-amber-50 border border-amber-200/80 rounded-2xl space-y-2.5">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <Loader2 className="w-4 h-4 animate-spin text-amber-600 shrink-0" />
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900 truncate max-w-[170px]">
                                          {pages.find(p => p.status === 'translating') 
                                            ? `Translasi: ${pages.find(p => p.status === 'translating')?.name}` 
                                            : 'Proses Translasi...'}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      {pages.find(p => p.status === 'translating') && (
                                        <button
                                          onClick={() => {
                                            const pTranslating = pages.find(p => p.status === 'translating');
                                            if (pTranslating) stopPageTranslation(pTranslating.id);
                                          }}
                                          className="py-2 px-2.5 bg-amber-100 hover:bg-amber-200 text-amber-900 font-extrabold text-[10px] uppercase tracking-wider rounded-xl transition-all cursor-pointer border border-amber-300/50 text-center"
                                          title="Lompati halaman yang sedang diproses dan lanjut ke halaman berikutnya"
                                        >
                                          Lompati Halaman
                                        </button>
                                      )}
                                      <button
                                        onClick={stopTranslation}
                                        className="py-2 px-2.5 bg-red-500 hover:bg-red-600 text-white font-extrabold text-[10px] uppercase tracking-wider rounded-xl transition-all shadow-xs cursor-pointer text-center"
                                        title="Hentikan seluruh antrean translasi"
                                      >
                                        Stop Semua
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="space-y-2.5">
                                    {/* Primary One-click Translate Current Page */}
                                    <button
                                      onClick={() => translatePage(pages[currentIndex], undefined, 'full', true)}
                                      className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-xs uppercase tracking-wider transition-all shadow-sm cursor-pointer flex items-center justify-center gap-2"
                                    >
                                      <Zap className="w-4 h-4 text-emerald-200" /> Terjemahkan Halaman Ini
                                    </button>

                                    {/* Translate All Pages */}
                                    <button
                                      onClick={() => translateAll(undefined, undefined, 'full')}
                                      className="w-full py-2.5 px-4 bg-black hover:bg-zinc-800 text-white font-bold rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2"
                                    >
                                      <Layers className="w-3.5 h-3.5 text-zinc-300" /> Terjemahkan Semua Halaman
                                    </button>

                                    {/* Advanced / Separate Actions */}
                                    <div className="pt-2 border-t border-gray-150 space-y-1.5">
                                      <span className="text-[9px] uppercase font-bold tracking-wider text-zinc-400 block">Proses Terpisah</span>
                                      <div className="grid grid-cols-2 gap-2">
                                        <button
                                          onClick={() => translatePage(pages[currentIndex], undefined, 'ocr_only', true)}
                                          className="py-2 px-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 font-bold text-[10px] uppercase tracking-wider rounded-lg transition-all cursor-pointer border border-zinc-200 flex items-center justify-center gap-1"
                                          title="Hanya lakukan deteksi teks & OCR tanpa terjemah"
                                        >
                                          <Scan className="w-3 h-3 text-zinc-600" /> Hanya OCR
                                        </button>
                                        <button
                                          onClick={() => translatePage(pages[currentIndex], undefined, 'translate_only', true)}
                                          className="py-2 px-2 bg-zinc-100 hover:bg-zinc-200 text-zinc-800 font-bold text-[10px] uppercase tracking-wider rounded-lg transition-all cursor-pointer border border-zinc-200 flex items-center justify-center gap-1"
                                          title="Terjemahkan teks terdeteksi saja"
                                        >
                                          <Languages className="w-3 h-3 text-zinc-600" /> Terjemah Teks
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="space-y-2 pt-2 border-t border-[#F0F0F0]">
                                <span className="text-[10px] uppercase font-bold tracking-widest text-[#999] block mb-1">Editor Balon</span>
                                <button
                                  onClick={() => {
                                    setIsEditing(true);
                                    setIsPageDrawerOpen(true);
                                  }}
                                  className="w-full flex items-center justify-center gap-2 py-3.5 bg-black hover:bg-zinc-850 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-sm"
                                >
                                  <Edit3 className="w-4 h-4" /> Edit Balon Kata
                                </button>
                              </div>

                              <div className="pt-4 border-t border-[#F0F0F0]">
                                <button
                                  onClick={() => removePage(pages[currentIndex].id)}
                                  className="w-full flex items-center justify-center gap-1.5 py-2.5 bg-red-50 hover:bg-red-100 text-red-650 font-bold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer border border-red-100/50"
                                >
                                  <Trash2 className="w-4 h-4" /> Hapus Halaman
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.aside>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            ) : (
                <div 
                  {...centralDropzone.getRootProps()} 
                  className={`flex-1 flex flex-col items-center justify-center border-2 border-dashed rounded-3xl p-8 text-center min-h-[500px] transition-colors cursor-pointer select-none ${
                    centralDropzone.isDragActive 
                      ? 'border-emerald-500 bg-emerald-50/20' 
                      : 'border-[#E5E5E5] bg-white hover:bg-[#FAFDFB]'
                  }`}
                >
                  <input {...centralDropzone.getInputProps()} />
                  <div className="w-16 h-16 bg-[#FAF9F6] border border-[#E5E5E5] rounded-2xl flex items-center justify-center mb-6 shadow-sm">
                    <Upload className="w-8 h-8 text-[#999] stroke-1 text-emerald-600 animate-bounce" />
                  </div>
                  <h3 className="font-bold text-sm uppercase tracking-wider text-[#1A1A1A] mb-2">Belum ada Halaman Manga</h3>
                  <p className="text-xs text-[#999] max-w-sm leading-relaxed mb-6">
                    Silakan seret & lepas file manga (.zip, .cbz, .pdf) atau gambar langsung ke sini, atau klik untuk memilih file di komputer/HP Anda.
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      className="px-5 py-2.5 bg-black text-white hover:bg-black/80 rounded-full text-xs font-bold uppercase tracking-wider cursor-pointer shadow-sm shadow-black/10 transition-all flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Upload File</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className={`fixed inset-y-0 right-1 xs:right-1.5 sm:right-4 z-[60] top-20 bottom-4 xl:relative xl:inset-auto xl:z-0 xl:w-[clamp(230px,16vw,325px)] xl:shrink-0 space-y-4 flex flex-col h-auto ${isSidebarOpen ? 'flex' : 'hidden xl:flex'} w-[245px] xs:w-[275px] sm:w-[320px] max-w-[calc(100vw-12px)]`}>
              <div className="fixed inset-0 bg-black/44 xl:hidden backdrop-blur-sm z-[-1]" onClick={() => setIsSidebarOpen(false)} />
              <div className="relative bg-white rounded-3xl p-3 sm:p-6 border border-[#E5E5E5] h-full flex flex-col shadow-2xl xl:shadow-none m-1.5 sm:m-4 xl:m-0 overflow-hidden xl:w-full">
                
                {/* Batch/Project List */}
                <div className="flex flex-col h-1/2 min-h-0 border-b border-[#F0F0F0] pb-6 mb-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold uppercase text-[10px] tracking-widest text-[#999]">Projects</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          batches.forEach(batch => {
                            if (batch.pages.length > 0) {
                              addBatchToPdfQueue(batch.id);
                            }
                          });
                        }}
                        disabled={batches.length === 0}
                        className="p-1.5 bg-blue-50 text-blue-600 rounded-full hover:bg-blue-100 disabled:opacity-50"
                        title="Export All Projects to PDF"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={queueAllBatches}
                        disabled={batches.length === 0 || batches.every(b => b.status === 'completed' || b.status === 'processing')}
                        className="p-1.5 bg-emerald-50 text-emerald-600 rounded-full hover:bg-emerald-100 disabled:opacity-50"
                        title="Queue All"
                      >
                        <Zap className="w-3.5 h-3.5" />
                      </button>
                      <div {...getRootProps()}>
                        <input {...getInputProps()} />
                        <button className="p-1.5 bg-black text-white rounded-full hover:bg-black/80">
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-2 no-scrollbar px-1 flex flex-col justify-start">
                    {batches.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[#E5E5E5] rounded-2xl p-4 text-center select-none py-8 bg-[#FAFBF9]">
                        <Upload className="w-5 h-5 text-[#999] mb-2 stroke-1" />
                        <p className="text-[10px] uppercase font-bold tracking-wider text-[#A0A0A0] mb-1">Belum ada Project</p>
                        <p className="text-[9px] text-[#BBB] leading-relaxed max-w-[160px] mx-auto">Tebarkan file Zip, PDF, atau Gambar, lalu tekan tombol + di atas untuk memulai!</p>
                      </div>
                    ) : (
                      batches.map(batch => (
                      <div 
                        key={batch.id}
                        onClick={() => setActiveBatchId(batch.id)}
                        className={`group relative p-3 rounded-2xl border transition-all cursor-pointer ${
                          activeBatchId === batch.id 
                            ? 'border-black bg-black text-white shadow-md' 
                            : 'border-[#F0F0F0] hover:border-black/20 bg-[#F9F9F9]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 overflow-hidden">
                          <div className="flex items-center gap-2 min-w-0">
                            {batch.status === 'processing' ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                            ) : batch.status === 'completed' ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            ) : batch.status === 'queued' ? (
                              <RotateCcw className="w-3.5 h-3.5 text-blue-500 animate-pulse shrink-0" />
                            ) : (
                              <Archive className={`w-3.5 h-3.5 shrink-0 ${activeBatchId === batch.id ? 'text-white/60' : 'text-[#999]'}`} />
                            )}
                            <span className="text-[11px] font-bold truncate">{batch.name}</span>
                          </div>
                          <div className="flex gap-1">
                            {batch.pages.length > 0 && (
                              <>
                                <button 
                                  onClick={(e) => { e.stopPropagation(); addBatchToPdfQueue(batch.id); }}
                                  className={`p-1 rounded-lg transition-all ${
                                    activeBatchId === batch.id 
                                      ? 'text-white/40 hover:text-white hover:bg-white/10' 
                                      : 'text-[#BBB] hover:text-black hover:bg-black/5'
                                  }`}
                                  title="Export PDF"
                                >
                                  <FileText className="w-3 h-3" />
                                </button>
                                <button 
                                  onClick={(e) => { e.stopPropagation(); exportToZip(undefined, batch.id); }}
                                  className={`p-1 rounded-lg transition-all ${
                                    activeBatchId === batch.id 
                                      ? 'text-white/40 hover:text-white hover:bg-white/10' 
                                      : 'text-[#BBB] hover:text-black hover:bg-black/5'
                                  }`}
                                  title="Export ZIP"
                                >
                                  <Archive className="w-3 h-3" />
                                </button>
                              </>
                            )}
                            <button 
                              onClick={(e) => { e.stopPropagation(); removeBatch(batch.id); }}
                              className={`p-1 rounded-lg transition-all ${
                                activeBatchId === batch.id 
                                  ? 'text-white/40 hover:text-white hover:bg-white/10' 
                                  : 'text-[#BBB] hover:text-red-500 hover:bg-red-50'
                              }`}
                              title="Remove Project"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <span className={`text-[8px] uppercase tracking-wider font-bold ${
                            activeBatchId === batch.id ? 'text-white/60' : 'text-[#999]'
                          }`}>
                            {batch.pages.length} Pages
                          </span>
                          <span className={`text-[8px] font-bold uppercase ${
                            batch.status === 'processing' ? 'text-blue-500' :
                            batch.status === 'completed' ? 'text-emerald-500' :
                            activeBatchId === batch.id ? 'text-white/40' : 'text-[#BBB]'
                          }`}>
                            {batch.status}
                          </span>
                        </div>
                      </div>
                    )))}
                  </div>
                </div>

                <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold uppercase text-[10px] tracking-widest text-[#999]">Pages - {activeBatch?.name || 'No Project'}</h3>
                    <div className="flex gap-2 items-center">
                    <button
                      onClick={translateAll}
                      disabled={isTranslating || pages.length === 0 || pages.every(p => p.status === 'completed')}
                      className="p-1.5 bg-black text-white rounded-full hover:bg-black/80 transition-all disabled:opacity-50 cursor-pointer"
                      title="Translate All"
                    >
                      <Languages className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setViewMode(prev => prev === 'list' ? 'grid' : 'list')}
                      className="p-1.5 hover:bg-[#F5F5F5] rounded-full transition-all text-[#999] cursor-pointer"
                      title="Toggle View Mode"
                    >
                      {viewMode === 'list' ? <Grid className="w-4 h-4" /> : <List className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => setIsSidebarOpen(false)}
                      className="lg:hidden p-1.5 hover:bg-[#F5F5F5] rounded-full transition-all text-[#999]"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {pages.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[10px] font-bold">
                    <button onClick={() => setSelectMode(v => !v)} className={`px-2 py-1 rounded-lg border cursor-pointer ${selectMode ? 'bg-black text-white border-black' : 'bg-white border-[#E5E5E5]'}`}>{selectMode ? '✓ Mode Pilih' : 'Pilih'}</button>
                    <button onClick={() => selectAllPages(!pages.every(p => p.selected))} className="px-2 py-1 rounded-lg border border-[#E5E5E5] bg-white cursor-pointer">{pages.every(p => p.selected) ? 'Batal semua' : 'Pilih semua'}</button>
                    {selectedPagesAll.length > 0 && (
                      <>
                        <button onClick={retranslateSelected} disabled={isTranslating} className="px-2 py-1 rounded-lg bg-emerald-600 text-white disabled:opacity-40 cursor-pointer">↻ Terjemah ({selectedPagesAll.length})</button>
                        <button onClick={deleteSelectedPages} className="px-2 py-1 rounded-lg bg-red-600 text-white cursor-pointer">🗑 Hapus</button>
                      </>
                    )}
                    <span className="w-full text-[9px] font-normal text-[#999]">Tahan &amp; seret pada thumbnail untuk memilih banyak sekaligus</span>
                  </div>
                )}
                {pages.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[#E5E5E5] rounded-2xl p-4 text-center select-none py-10 bg-[#FAF9F6]">
                    <FileText className="w-5 h-5 text-[#999] mb-2 stroke-1" />
                    <p className="text-[10px] uppercase font-bold tracking-wider text-[#A0A0A0] mb-1">Belum ada Halaman</p>
                    <p className="text-[9px] text-[#BBB] leading-relaxed max-w-[160px] mx-auto">Silakan pilih Project di atas atau upload file manga Anda.</p>
                  </div>
                ) : (
                  <div onPointerDown={e => beginDS(e, 'pages')} onDragStart={e => e.preventDefault()} className={`flex-1 overflow-y-auto pr-2 custom-scrollbar select-none ${viewMode === 'grid' ? 'grid grid-cols-2 gap-3' : 'space-y-3'}`}>
                    {pages.map((page, index) => (
                    <div key={page.id} data-ds-group="pages" data-ds-idx={index} className="relative group">
                      <div
                        onClick={(e) => { if (Date.now() - suppressClickRef.current < 300) return; if (selectMode) togglePageSelection(page.id, e); else setCurrentIndex(index); }}
                        className={`w-full flex ${viewMode === 'grid' ? 'flex-col' : 'items-center gap-4'} p-3 rounded-2xl transition-all text-left cursor-pointer ${
                          currentIndex === index ? 'bg-black text-white' : 'hover:bg-[#F5F5F5]'
                        }`}
                      >
                        <div className={`${viewMode === 'grid' ? 'w-full aspect-[3/4]' : 'w-12 h-16'} bg-[#F0F0F0] rounded-lg overflow-hidden flex-shrink-0`}>
                          <img src={page.originalUrl} draggable={false} className="w-full h-full object-cover" alt="" />
                        </div>
                        <div className={`flex-1 min-w-0 ${viewMode === 'grid' ? 'mt-2' : ''}`}>
                          <p className="text-sm font-medium truncate">{page.name}</p>
                          <div className="flex items-center gap-1 mt-1">
                            {page.status === 'completed' ? (
                              <div className="flex items-center gap-1">
                                {page.isCleaned && !page.isTranslated ? (
                                  <>
                                    <CheckCircle2 className="w-3 h-3 text-indigo-500" />
                                    <span className="text-[9px] font-bold text-indigo-650 bg-indigo-50 px-1 py-0.2 rounded font-sans uppercase">OCR</span>
                                  </>
                                ) : page.isTranslated ? (
                                  <>
                                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                    <span className="text-[9px] font-bold text-emerald-650 bg-emerald-50 px-1 py-0.2 rounded font-sans uppercase">Selesai</span>
                                  </>
                                ) : (
                                  <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                                )}
                              </div>
                            ) : page.status === 'translating' ? (
                              <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                <Loader2 className="w-3 h-3 animate-spin text-blue-500 hover:text-red-500" />
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    stopPageTranslation(page.id);
                                  }}
                                  className="p-0.5 hover:bg-red-50 text-red-500 rounded cursor-pointer transition-all border-0 bg-transparent flex items-center justify-center"
                                  title="Hentikan Proses Translasi Halaman Ini"
                                >
                                  <X className="w-2.5 h-2.5 text-red-600" />
                                </button>
                              </div>
                            ) : page.status === 'error' ? (
                              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" title={page.error || 'Terjadi kesalahan'} />
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setPages(prev => prev.map(p => p.id === page.id ? { ...p, status: 'pending', error: undefined } : p));
                                  }}
                                  className="p-0.5 hover:bg-[#F0F0F0] hover:text-black rounded text-[#999] border-0 bg-transparent flex items-center justify-center cursor-pointer"
                                  title="Reset halaman ke Pending"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setPages(prev => prev.map(p => p.id === page.id ? { ...p, status: 'completed', error: undefined } : p));
                                  }}
                                  className="p-0.5 hover:bg-emerald-500 hover:text-white rounded text-emerald-500 border-0 bg-transparent flex items-center justify-center cursor-pointer"
                                  title="Lewati otomatisasi AI dan langsung Edit Manual"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                            ) : (
                              <div className="w-3 h-3 rounded-full border border-current opacity-30" />
                            )}
                            <span className="text-[10px] uppercase tracking-wider opacity-60">
                              {page.status}
                            </span>
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={(e) => togglePageSelection(page.id, e)}
                        className={`absolute top-2 right-2 p-1.5 rounded-lg transition-all ${
                          page.selected 
                            ? 'bg-emerald-500 text-white' 
                            : 'bg-white/90 text-black border border-[#CFCFCF] shadow-sm'
                        }`}
                      >
                        {page.selected ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          </div>
      </main>

      {pdfProgress && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-sm text-center space-y-4"
          >
            <div className="w-16 h-16 bg-emerald-100 rounded-2xl flex items-center justify-center mx-auto mb-2">
              <FileText className="w-8 h-8 text-emerald-600" />
            </div>
            <h3 className="text-xl font-bold">Generating PDF</h3>
            {pdfProgress.batchName && (
              <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 uppercase tracking-widest inline-block text-center select-none">
                {pdfProgress.batchName}
              </span>
            )}
            <div className="space-y-1">
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-black"
                  initial={{ width: 0 }}
                  animate={{ width: `${(pdfProgress.current / pdfProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-sm font-medium text-gray-500">
                Processing {pdfProgress.current} of {pdfProgress.total} pages
              </p>
            </div>
            <p className="text-xs text-gray-400">
              Please keep this tab open until export is complete.
            </p>
          </motion.div>
        </div>
      )}

      {completedPdfs.length > 0 && (
        <div className="fixed bottom-6 right-6 z-[80] w-[360px] max-w-[calc(100vw-2rem)] bg-white rounded-3xl border border-[#E5E5E5] shadow-2xl overflow-hidden flex flex-col max-h-[380px]">
          <div className="bg-[#FAF9F6] border-b border-[#F0F0F0] px-5 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <h4 className="text-xs font-bold uppercase tracking-widest text-[#1A1A1A]">Ekspor PDF Sukses</h4>
              <span className="text-[10px] font-mono bg-black/5 px-1.5 py-0.5 rounded text-black font-bold">
                {completedPdfs.length}
              </span>
            </div>
            <button 
              onClick={() => {
                completedPdfs.forEach(item => URL.revokeObjectURL(item.url));
                setCompletedPdfs([]);
              }}
              className="text-[#999] hover:text-[#1A1A1A] p-1 rounded-full hover:bg-black/5 transition-all"
              title="Clear Export History"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5 custom-scrollbar min-h-0">
            {completedPdfs.map((file) => (
              <div key={file.id} className="flex items-center justify-between gap-3 p-3 bg-[#FAFDFB] rounded-2xl border border-emerald-100/50 hover:bg-emerald-50/10 transition-colors">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl flex-shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-900 truncate" title={file.name}>
                      {file.name}
                    </p>
                    <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                      {file.size}
                    </p>
                  </div>
                </div>
                <button
                  onClick={async (e) => {
                    e.preventDefault();
                    try {
                      const res = await fetch(file.url);
                      const blob = await res.blob();
                      await triggerServerSideDownload(blob, file.name);
                    } catch (err) {
                      console.error('Failed to secure-download PDF:', err);
                    }
                  }}
                  className="p-2 bg-white hover:bg-[#FAF9F6] border border-[#E5E5E5] text-gray-700 rounded-xl shadow-sm hover:shadow transition-all flex-shrink-0"
                  title="Download File"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="p-4 border-t border-[#F0F0F0] bg-white flex gap-2">
            <button
              onClick={downloadAllPdfsAsZip}
              disabled={isExportingZip}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-black hover:bg-black/80 text-white rounded-2xl text-xs font-bold transition-all shadow-sm disabled:opacity-50 select-none cursor-pointer"
            >
              {isExportingZip ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Mengompresi...</span>
                </>
              ) : (
                <>
                  <Archive className="w-3.5 h-3.5" />
                  <span>Unduh Semua (.zip)</span>
                </>
              )}
            </button>
            <button
              onClick={() => {
                completedPdfs.forEach(item => URL.revokeObjectURL(item.url));
                setCompletedPdfs([]);
              }}
              className="px-4 py-2.5 bg-[#FAF9F6] border border-[#E5E5E5] hover:bg-red-50 hover:border-red-100 hover:text-red-500 rounded-2xl text-[#666] text-xs font-medium transition-all"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {isWindowDragging && (
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-md flex flex-col items-center justify-center p-6 text-white pointer-events-none transition-all">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center max-w-md text-center p-8 bg-[#1A1A1A] border border-zinc-800 rounded-3xl shadow-2xl space-y-4"
          >
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 rounded-full animate-bounce">
              <Upload className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold">Lepaskan File di Sini</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Seret gambar manga, file berkas ZIP, atau dokumen langsung dari folder Explorer untuk memulai proses penerjemahan instan!
            </p>
          </motion.div>
        </div>
      )}

      {/* IMMERSIVE FULLSCREEN LIGHTBOX OVERLAY */}
      <AnimatePresence>
        {isFullscreen && pages.length > 0 && pages[currentIndex] && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#070707] z-[999] flex flex-col justify-between overflow-hidden text-left"
          >
            {/* Top Toolbar */}
            <div className="p-4 bg-black/60 border-b border-white/5 flex items-center justify-between z-10">
              <div className="flex items-center gap-3">
                <div className="bg-white/10 p-2 rounded-xl text-white">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-white font-bold text-sm md:text-base truncate max-w-[200px] sm:max-w-[400px]">{pages[currentIndex].name}</h3>
                  <p className="text-[11px] text-zinc-400 font-semibold tracking-wide">Halaman {currentIndex + 1} dari {pages.length}</p>
                </div>
              </div>

              {/* Toolbar Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setViewScrollMode(prev => prev === 'fit' ? 'scroll' : 'fit')}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white rounded-full text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer"
                >
                  {viewScrollMode === 'scroll' ? 'Scroll View' : 'Fit View'}
                </button>
                <button
                  onClick={() => setIsFullscreen(false)}
                  className="p-2 bg-white/10 hover:bg-white/25 rounded-full text-white cursor-pointer transition-all"
                  title="Close Fullscreen"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Immersive Viewer Box */}
            <div 
              className={`flex-1 relative w-full flex ${
                viewScrollMode === 'scroll' 
                  ? 'overflow-y-auto scroll-smooth custom-scrollbar flex-col items-center justify-start p-4 py-8' 
                  : 'items-center justify-center p-3 overflow-hidden'
              }`}
            >
              <div
                className={`relative select-none rounded-xl bg-[#121212] border border-white/5 shadow-2xl overflow-hidden ${
                  viewScrollMode === 'scroll' ? 'w-full max-w-2xl shadow-emerald-500/5' : 'max-h-full h-full'
                }`}
                style={
                  viewScrollMode === 'scroll'
                    ? { height: 'auto', maxHeight: 'none' }
                    : currentImgSize
                      ? { aspectRatio: `${currentImgSize.w} / ${currentImgSize.h}`, height: '100%', width: 'auto', maxHeight: '100%' }
                      : { height: '100%', width: 'auto', maxHeight: '100%' }
                }
              >
                <img
                  src={pages[currentIndex].translatedUrl || pages[currentIndex].originalUrl}
                  alt={pages[currentIndex].name}
                  className="w-full h-full object-contain select-none pointer-events-none"
                />
              </div>

              {/* Immersive floating chevrons */}
              <div className="absolute inset-y-0 left-4 w-16 flex items-center justify-center z-40 pointer-events-none">
                <button
                  onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentIndex === 0}
                  className="p-3 bg-white/10 backdrop-blur rounded-full shadow-xl hover:bg-white hover:text-black text-white disabled:opacity-0 transition-all pointer-events-auto cursor-pointer border border-white/5"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
              </div>
              <div className="absolute inset-y-0 right-4 w-16 flex items-center justify-center z-40 pointer-events-none">
                <button
                  onClick={() => setCurrentIndex(prev => Math.min(pages.length - 1, prev + 1))}
                  disabled={currentIndex === pages.length - 1}
                  className="p-3 bg-white/10 backdrop-blur rounded-full shadow-xl hover:bg-white hover:text-black text-white disabled:opacity-0 transition-all pointer-events-auto cursor-pointer border border-white/5"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Bottom Keyboard indicator */}
            <div className="p-3 bg-black/60 border-t border-white/5 text-center text-zinc-500 text-[10px] tracking-wide uppercase font-semibold">
              Gunakan tombol panah di layar untuk navigasi halaman manga
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MOBILE ACTIONS MENU BOTTOM SHEET */}
      <AnimatePresence>
        {isMobileActionsOpen && pages.length > 0 && pages[currentIndex] && (
          <>
            {/* Backdrop */}
            <div 
              className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[80] lg:hidden animate-fade-in"
              onClick={() => setIsMobileActionsOpen(false)}
            />
            {/* Sheet */}
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 250 }}
              className="fixed bottom-0 inset-x-0 bg-white rounded-t-[32px] border-t border-[#E5E5E5] p-6 pb-8 z-[90] lg:hidden flex flex-col gap-4 text-left shadow-2xl"
            >
              <div className="flex items-center justify-between pb-3 border-b border-[#F0F0F0]">
                <div>
                  <h4 className="font-bold text-base text-black">Aksi Halaman</h4>
                  <p className="text-xs text-[#999] truncate max-w-[250px]">{pages[currentIndex].name}</p>
                </div>
                <button
                  onClick={() => setIsMobileActionsOpen(false)}
                  className="p-2 hover:bg-[#F5F5F5] rounded-full transition-all"
                >
                  <X className="w-5 h-5 text-[#666]" />
                </button>
              </div>

              {/* Large touch targets */}
              <div className="grid grid-cols-1 gap-2 pt-2">
                <button
                  onClick={() => {
                    setIsMobileActionsOpen(false);
                    setIsEditing(true);
                  }}
                  className="flex items-center gap-3 w-full p-4 bg-[#F9F9F9] hover:bg-[#F0F0F0] active:bg-[#EAFAF1] border border-[#E5E5E5] rounded-2xl text-sm font-semibold transition-all text-left cursor-pointer"
                >
                  <Edit3 className="w-5 h-5 text-black" />
                  <div>
                    <p className="text-black font-bold text-sm">Edit Balon Kata</p>
                    <p className="text-[11px] text-[#999] font-medium font-semibold">Manipulasi teks manga secara visual</p>
                  </div>
                </button>

                {pages[currentIndex].status === 'completed' ? (
                  <button
                    onClick={() => {
                      setIsMobileActionsOpen(false);
                      setPages(prev => prev.map((p, i) => i === currentIndex ? { ...p, status: 'pending' } : p));
                      translatePage(pages[currentIndex], undefined, 'full', true);
                    }}
                    className="flex items-center gap-3 w-full p-4 bg-[#F9F9F9] hover:bg-[#F0F0F0] border border-[#E5E5E5] rounded-2xl text-sm font-semibold transition-all text-left cursor-pointer"
                  >
                    <RotateCcw className="w-5 h-5 text-blue-600" />
                    <div>
                      <p className="text-black font-bold text-sm">Terjemahkan Ulang Halaman</p>
                      <p className="text-[11px] text-[#999] font-[500]">Render ulang teks halaman ini</p>
                    </div>
                  </button>
                ) : (
                  pages.some(p => p.status === 'pending' || p.status === 'error') && (
                    <button
                      onClick={() => {
                        setIsMobileActionsOpen(false);
                        translateAll();
                      }}
                      className="flex items-center gap-3 w-full p-4 bg-emerald-50 hover:bg-emerald-100/80 border border-emerald-100 rounded-2xl text-sm font-semibold transition-all text-left cursor-pointer"
                    >
                      <Languages className="w-5 h-5 text-emerald-600" />
                      <div>
                        <p className="text-emerald-800 font-bold text-sm">Terjemahkan Semua</p>
                        <p className="text-[11px] text-[#999] font-semibold">Proses semua halaman yang tersisa</p>
                      </div>
                    </button>
                  )
                )}

                <div className="grid grid-cols-2 gap-2 mt-1">
                  <button
                    onClick={() => {
                      setIsMobileActionsOpen(false);
                      if (activeBatchId) {
                        const completedSelected = pages.filter(p => p.selected && p.status === 'completed');
                        addBatchToPdfQueue(activeBatchId, completedSelected.length > 0 ? completedSelected : undefined);
                      }
                    }}
                    disabled={!pages.some(p => p.status === 'completed')}
                    className="flex flex-col items-center justify-center p-3 bg-white hover:bg-[#F5F5F5] border border-[#E5E5E5] rounded-2xl transition-all disabled:opacity-40 cursor-pointer text-center"
                  >
                    <FileText className="w-5 h-5 text-blue-500 mb-1" />
                    <span className="text-xs font-bold text-black uppercase">Export PDF</span>
                  </button>
                  <button
                    onClick={() => {
                      setIsMobileActionsOpen(false);
                      exportToZip(pages.filter(p => p.selected && p.status === 'completed').length > 0 ? pages.filter(p => p.selected && p.status === 'completed') : undefined);
                    }}
                    disabled={!pages.some(p => p.status === 'completed')}
                    className="flex flex-col items-center justify-center p-3 bg-white hover:bg-[#F5F5F5] border border-[#E5E5E5] rounded-2xl transition-all disabled:opacity-40 cursor-pointer text-center"
                  >
                    <Archive className="w-5 h-5 text-emerald-500 mb-1" />
                    <span className="text-xs font-bold text-black uppercase">Export ZIP</span>
                  </button>
                </div>

                <button
                  onClick={() => {
                    setIsMobileActionsOpen(false);
                    removePage(pages[currentIndex].id);
                  }}
                  className="flex items-center gap-3 w-full p-4 bg-red-50 hover:bg-red-100 border border-red-100 rounded-2xl text-sm font-semibold transition-all text-left cursor-pointer mt-1"
                >
                  <Trash2 className="w-5 h-5 text-red-600" />
                  <div>
                    <p className="text-red-700 font-bold text-sm">Hapus Halaman Ini</p>
                    <p className="text-[11px] text-red-600/70 font-medium">Tindakan ini tidak dapat dibatalkan</p>
                  </div>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {selectedPagesAll.length > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[85] bg-black text-white rounded-2xl shadow-2xl px-4 py-3 flex flex-wrap items-center gap-3 text-xs font-bold">
            <span>{selectedPagesAll.length} halaman dipilih</span>
            <button onClick={retranslateSelected} disabled={isTranslating} className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 cursor-pointer">Terjemahkan ulang</button>
            <button onClick={deleteSelectedPages} className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-400 cursor-pointer">Hapus</button>
            <button onClick={clearPageSelection} className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 cursor-pointer">Batal (Esc)</button>
          </div>
        )}

        {showShortcuts && (
          <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4" onClick={() => { setShowShortcuts(false); setRebinding(null); }}>
            <div className="bg-white rounded-3xl p-5 max-w-xl w-full max-h-[88vh] overflow-y-auto shadow-2xl text-sm" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-bold text-base">Shortcut Keyboard</h3>
                <button onClick={() => { const d = loadKeymap(true); setKeymap(d); saveKeymap(d); setRebinding(null); }} className="text-[11px] px-2 py-1 rounded-lg border border-[#E5E5E5] cursor-pointer">Reset default</button>
              </div>
              <p className="text-[11px] text-zinc-500 mb-3">Klik sebuah tombol lalu tekan kombinasi baru untuk mengubahnya (Esc = batal). Tetap: Panah = geser blok terpilih (Shift = 5×), Backspace = hapus, Esc = lepas/keluar, PgUp/PgDn = ganti halaman, Ctrl+Shift+Z = redo.</p>
              <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 items-center">
                {ACTIONS.map(a => (
                  <React.Fragment key={a.id}>
                    <span className="text-[13px]">{a.label}</span>
                    <button onClick={() => setRebinding(a.id)} className={`font-mono text-[11px] rounded px-2 py-0.5 border cursor-pointer whitespace-nowrap ${rebinding === a.id ? 'bg-amber-100 border-amber-400' : 'bg-[#F3F3F3] border-[#E0E0E0]'}`}>{rebinding === a.id ? 'tekan tombol…' : prettyCombo(keymap[a.id])}</button>
                  </React.Fragment>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-[#EEE] flex items-center justify-between text-[12px]">
                <span>Koreksi Anda yang dipelajari AI: <b>{correctionCount}</b></span>
                <button onClick={() => { clearCorrections(); setCorrectionCount(0); }} className="px-2 py-1 rounded-lg border border-[#E5E5E5] cursor-pointer">Hapus memori</button>
              </div>
            </div>
          </div>
        )}

        {/* Floating ZIP Exporting Status and Cancellation Card */}
      <AnimatePresence>
        {isExportingZip && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.95 }}
            className="fixed bottom-6 right-6 z-[9999] bg-black text-white p-4 rounded-2xl shadow-xl flex items-center gap-4 border border-zinc-855"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
              <div className="flex flex-col">
                <span className="text-xs font-bold font-sans">Mengekspor berkas ZIP...</span>
                <span className="text-[10px] text-zinc-400 font-mono">Sedang memproses halaman</span>
              </div>
            </div>
            <button
              onClick={() => {
                zipCancellationRef.current = true;
              }}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-[10px] uppercase font-bold tracking-wider rounded-xl transition-all cursor-pointer shadow-sm select-none"
            >
              Batal
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #E5E5E5;
          border-radius: 10px;
        }
      `}} />
    </div>
  );
}
