import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { ModelCard } from '../components/models/ModelCard';
import { ModelDetailDrawer } from '../components/models/ModelDetailDrawer';
import type {
  CatalogModelWithFit,
  ExecutionProfile,
  FitStatus,
  KvCacheType,
} from '../types/ipc';
import { formatTimestamp } from '../utils/format';

interface DiscoverModelsScreenProps {
  items: CatalogModelWithFit[];
  loading: boolean;
  contextLength: number;
  executionProfile?: ExecutionProfile;
  kvCacheType?: KvCacheType;
  lastCatalogRefresh?: string | null;
  refreshingCatalog?: boolean;
  libraryConnected: boolean;
  freeBytes: number;
  pullingName: string | null;
  onChangeContextLength: (ctx: number) => void;
  onChangeExecutionProfile?: (profile: ExecutionProfile) => void;
  onChangeKvCacheType?: (kv: KvCacheType) => void;
  onRefreshCatalog?: () => void;
  onPullModel?: (ollamaName: string) => void;
}

const CONTEXT_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536];
const FIT_FILTERS: Array<'All' | FitStatus> = ['All', 'Recommended', 'Borderline', 'Not recommended'];
const PROFILE_OPTIONS: Array<{ value: ExecutionProfile; label: string }> = [
  { value: 'auto_adaptive', label: 'Profile: Auto Adaptive' },
  { value: 'max_quality', label: 'Profile: Max Quality' },
  { value: 'balanced', label: 'Profile: Balanced' },
  { value: 'constrained_memory', label: 'Profile: Constrained Memory' },
];
const KV_OPTIONS: Array<{ value: KvCacheType; label: string }> = [
  { value: 'auto', label: 'KV: Auto' },
  { value: 'f16', label: 'KV: F16' },
  { value: 'q8_0', label: 'KV: Q8_0' },
  { value: 'q4_0', label: 'KV: Q4_0' },
];

export function DiscoverModelsScreen({
  items,
  loading,
  contextLength,
  executionProfile = 'auto_adaptive',
  kvCacheType = 'auto',
  lastCatalogRefresh = null,
  refreshingCatalog = false,
  libraryConnected,
  freeBytes,
  pullingName,
  onChangeContextLength,
  onChangeExecutionProfile,
  onChangeKvCacheType,
  onRefreshCatalog,
  onPullModel,
}: DiscoverModelsScreenProps) {
  const [query, setQuery] = useState('');
  const [fitFilter, setFitFilter] = useState<'All' | FitStatus>('All');
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const selected = useMemo(
    () => (selectedName ? items.find((entry) => entry.model.ollama_name === selectedName) ?? null : null),
    [items, selectedName]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((entry) => {
      const matchesQuery =
        !q ||
        entry.model.display_name.toLowerCase().includes(q) ||
        entry.model.ollama_name.toLowerCase().includes(q) ||
        entry.model.provider.toLowerCase().includes(q);
      const matchesFit = fitFilter === 'All' || entry.fit.fit_status === fitFilter;
      return matchesQuery && matchesFit;
    });
  }, [items, query, fitFilter]);

  return (
    <div className="mosaic-stack">
      <section className="mosaic-panel" aria-labelledby="discover-heading">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="discover-heading">Discover Models</h2>
            <span className="mosaic-subtitle">
              Ranked against measured memory, quantization, and KV-cache budget
              {lastCatalogRefresh ? ` · Refreshed ${formatTimestamp(lastCatalogRefresh)}` : ''}
            </span>
          </div>
          {onRefreshCatalog && (
            <button
              type="button"
              className="mosaic-button-secondary"
              disabled={refreshingCatalog}
              onClick={onRefreshCatalog}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{refreshingCatalog ? 'Refreshing...' : 'Refresh Catalog'}</span>
            </button>
          )}
        </div>

        {!libraryConnected && (
          <p className="mosaic-callout mosaic-callout-warn">
            External drive required for downloads
          </p>
        )}

        <div className="mosaic-toolbar">
          <div className="mosaic-search-wrap">
            <Search size={15} className="mosaic-search-icon" aria-hidden="true" />
            <input
              type="search"
              className="mosaic-input mosaic-search-input"
              placeholder="Search models, providers, or tags..."
              aria-label="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <select
            className="mosaic-input"
            aria-label="Filter by compatibility status"
            value={fitFilter}
            onChange={(e) => setFitFilter(e.target.value as 'All' | FitStatus)}
          >
            {FIT_FILTERS.map((f) => (
              <option key={f} value={f}>Fit: {f}</option>
            ))}
          </select>

          <select
            className="mosaic-input"
            aria-label="Assumed context length"
            value={contextLength}
            onChange={(e) => onChangeContextLength(Number(e.target.value))}
          >
            {CONTEXT_OPTIONS.map((ctx) => (
              <option key={ctx} value={ctx}>Context: {ctx.toLocaleString()}</option>
            ))}
          </select>

          <select
            className="mosaic-input"
            aria-label="Execution profile"
            value={executionProfile}
            onChange={(e) => onChangeExecutionProfile?.(e.target.value as ExecutionProfile)}
          >
            {PROFILE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <select
            className="mosaic-input"
            aria-label="KV cache"
            value={kvCacheType}
            onChange={(e) => onChangeKvCacheType?.(e.target.value as KvCacheType)}
          >
            {KV_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </section>

      {loading ? (
        <p className="mosaic-subtitle">Evaluating model compatibility...</p>
      ) : filtered.length === 0 ? (
        <section className="mosaic-panel-white" role="status">
          <p className="mosaic-subtitle">
            {items.length === 0
              ? 'Model catalog unavailable in browser preview. Launch the MOSAIC desktop app to evaluate models against your hardware.'
              : 'No models match the selected search query or compatibility filter.'}
          </p>
        </section>
      ) : (
        <div className="mosaic-grid">
          {filtered.map((item) => (
            <ModelCard
              key={item.model.ollama_name}
              item={item}
              libraryConnected={libraryConnected}
              freeBytes={freeBytes}
              pullingName={pullingName}
              onViewDetails={(entry) => setSelectedName(entry.model.ollama_name)}
              onPullModel={onPullModel}
            />
          ))}
        </div>
      )}

      <ModelDetailDrawer
        item={selected}
        libraryConnected={libraryConnected}
        freeBytes={freeBytes}
        pullingName={pullingName}
        onPullModel={onPullModel}
        onClose={() => setSelectedName(null)}
      />
    </div>
  );
}
