import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { ModelCard } from '../components/models/ModelCard';
import { ModelDetailDrawer } from '../components/models/ModelDetailDrawer';
import type { CatalogModelWithFit, FitStatus } from '../types/ipc';

interface DiscoverModelsScreenProps {
  items: CatalogModelWithFit[];
  loading: boolean;
  contextLength: number;
  libraryConnected: boolean;
  freeBytes: number;
  pullingName: string | null;
  onChangeContextLength: (ctx: number) => void;
  onPullModel?: (ollamaName: string) => void;
}

const CONTEXT_OPTIONS = [2048, 4096, 8192, 16384, 32768];
const FIT_FILTERS: Array<'All' | FitStatus> = [
  'All',
  'Recommended',
  'Borderline',
  'Not recommended',
];

export function DiscoverModelsScreen({
  items,
  loading,
  contextLength,
  libraryConnected,
  freeBytes,
  pullingName,
  onChangeContextLength,
  onPullModel,
}: DiscoverModelsScreenProps) {
  const [query, setQuery] = useState('');
  const [fitFilter, setFitFilter] = useState<'All' | FitStatus>('All');
  const [selected, setSelected] = useState<CatalogModelWithFit | null>(null);

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
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="mosaic-panel" aria-labelledby="discover-heading">
        <div className="mosaic-panel-header">
          <div>
            <h2 id="discover-heading">Discover Models</h2>
            <span className="mosaic-subtitle">
              Ranked against measured available memory, quantization, and KV-cache budget
            </span>
          </div>
          {!libraryConnected && (
            <span className="mosaic-badge mosaic-badge-warn">
              External drive required for downloads
            </span>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search
              size={15}
              aria-hidden="true"
              style={{ position: 'absolute', left: 12, top: 14, color: '#647789' }}
            />
            <input
              type="search"
              className="mosaic-input"
              style={{ width: '100%', paddingLeft: 36 }}
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
              <option key={f} value={f}>
                Fit: {f}
              </option>
            ))}
          </select>

          <select
            className="mosaic-input"
            aria-label="Assumed context length"
            value={contextLength}
            onChange={(e) => onChangeContextLength(Number(e.target.value))}
          >
            {CONTEXT_OPTIONS.map((ctx) => (
              <option key={ctx} value={ctx}>
                Context: {ctx.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
      </section>

      {loading ? (
        <p className="mosaic-subtitle">Evaluating model compatibility...</p>
      ) : (
        <div className="mosaic-grid">
          {filtered.map((item) => (
            <ModelCard
              key={item.model.ollama_name}
              item={item}
              libraryConnected={libraryConnected}
              freeBytes={freeBytes}
              pullingName={pullingName}
              onViewDetails={setSelected}
              onPullModel={onPullModel}
            />
          ))}
        </div>
      )}

      <ModelDetailDrawer item={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
