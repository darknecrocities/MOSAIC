import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTauriTestBridge, type TauriTestController } from '../test-utils/mockTauri';
import { useMosaicRuntime } from './useMosaicRuntime';

describe('useMosaicRuntime', () => {
  let tauri: TauriTestController;

  beforeEach(() => {
    tauri = installTauriTestBridge();
  });

  afterEach(() => {
    cleanup();
    tauri.uninstall();
  });

  it('subscribes once per event across selectedModel changes and filters chat tokens by session_id', async () => {
    const { result } = renderHook(() => useMosaicRuntime());

    await waitFor(() => {
      expect(tauri.listenerCount('mosaic://pull-progress')).toBe(1);
      expect(tauri.listenerCount('mosaic://chat-token')).toBe(1);
    });

    act(() => {
      result.current.setSelectedModel('llama3.2:1b');
    });
    act(() => {
      result.current.setSelectedModel('qwen3:30b-a3b');
    });

    expect(tauri.listenerCount('mosaic://pull-progress')).toBe(1);
    expect(tauri.listenerCount('mosaic://chat-token')).toBe(1);

    await act(async () => {
      await result.current.handleSendMessage('Hello local model', {
        numCtx: 32768,
        temperature: 0.2,
        executionProfile: 'auto_adaptive',
        kvCacheType: 'q8_0',
        numGpu: 48,
        keepAlive: '5m',
      });
    });

    const chatCalls = tauri.callsFor('start_chat_stream');
    expect(chatCalls).toHaveLength(1);
    const req = chatCalls[0].args.request as Record<string, unknown>;
    const sessionId = String(req.session_id);

    act(() => {
      tauri.emit('mosaic://chat-token', { session_id: 'stale-session', token: 'WRONG', done: false, error: null });
      tauri.emit('mosaic://chat-token', { session_id: sessionId, token: 'Hello', done: false, error: null });
      tauri.emit('mosaic://chat-token', { session_id: sessionId, token: ' world', done: true, error: null });
    });

    expect(result.current.messages).toEqual([
      { role: 'user', content: 'Hello local model' },
      { role: 'assistant', content: 'Hello world' },
    ]);
    expect(result.current.streaming).toBe(false);
  });

  it('cleans up deferred listen subscriptions when unmounted mid-handshake', async () => {
    tauri.uninstall();
    tauri = installTauriTestBridge();
    const resolvePull = tauri.deferListen('mosaic://pull-progress');

    const { unmount } = renderHook(() => useMosaicRuntime());
    unmount();

    await act(async () => {
      resolvePull();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauri.listenerCount('mosaic://pull-progress')).toBe(0);
    expect(tauri.listenerCount('mosaic://chat-token')).toBe(0);
  });

  it('updates pullProgress and forwards cancel_pull', async () => {
    const { result } = renderHook(() => useMosaicRuntime());
    await waitFor(() => expect(tauri.listenerCount('mosaic://pull-progress')).toBe(1));

    act(() => {
      tauri.emit('mosaic://pull-progress', {
        model: 'qwen3:30b-a3b',
        status: 'downloading',
        completed: 512 * 1024 ** 2,
        total: 1024 ** 3,
        done: false,
        error: null,
      });
    });
    expect(result.current.pullProgress?.model).toBe('qwen3:30b-a3b');

    act(() => {
      result.current.handleCancelPull('qwen3:30b-a3b');
    });
    await waitFor(() => {
      expect(tauri.callsFor('cancel_pull')[0]?.args).toEqual({ model: 'qwen3:30b-a3b' });
    });
  });

  it('surfaces list_catalog_with_fit errors in notice and syncs settings updates', async () => {
    tauri.setHandler('list_catalog_with_fit', () => {
      throw new Error('Catalog worker crashed');
    });
    const { result } = renderHook(() => useMosaicRuntime());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => {
      result.current.setRoute('discover');
    });
    await waitFor(() => {
      expect(result.current.notice).toMatch(/Catalog worker crashed/);
    });

    await act(async () => {
      await result.current.handleSaveSetting('execution_profile', 'constrained_memory');
      await result.current.handleSaveSetting('kv_cache_type', 'q4_0');
      await result.current.handleSaveSetting('default_context_length', 16384);
    });
    expect(result.current.executionProfile).toBe('constrained_memory');
    expect(result.current.kvCacheType).toBe('q4_0');
    expect(result.current.contextLength).toBe(16384);
  });

  it('ignores superseded start_chat_stream rejection after rotating to a new session', async () => {
    let rejectFirst!: (err: Error) => void;
    let callNum = 0;
    tauri.setHandler('start_chat_stream', () => {
      callNum += 1;
      if (callNum === 1) {
        return new Promise((_, reject) => { rejectFirst = reject; });
      }
      return undefined;
    });

    const { result } = renderHook(() => useMosaicRuntime());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    const opts = {
      numCtx: 4096,
      temperature: 0.2,
      executionProfile: 'auto_adaptive' as const,
      kvCacheType: 'auto' as const,
      numGpu: null,
      keepAlive: '5m',
    };

    let firstPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.handleSendMessage('Old session prompt', opts);
    });
    expect(result.current.streaming).toBe(true);

    act(() => {
      result.current.handleNewSession();
    });
    await act(async () => {
      await result.current.handleSendMessage('New session prompt', opts);
    });
    expect(result.current.streaming).toBe(true);

    await act(async () => {
      rejectFirst(new Error('Superseded stream failed'));
      await firstPromise;
    });

    expect(result.current.streaming).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it('prevents stale handleRefreshCatalog overwrite, clears pull on cancel=false, guards rapid double send, calls stop_chat_stream on new session, and refreshes catalog on volume change', async () => {
    let resolveRefresh!: (val: unknown) => void;
    tauri.setHandler('refresh_model_catalog', () => new Promise((r) => { resolveRefresh = r; }));
    tauri.setHandler('list_catalog_with_fit', (args) => [
      {
        model: {
          ollama_name: `ctx-${args.contextLength}-${args.executionProfile}`,
          display_name: `Model ${args.contextLength}`,
          provider: 'Test', parameter_billions: 1, quantization: 'Q4_K_M',
          download_size_bytes: 1000, n_layers: 8, n_kv_heads: 4, head_dim: 64,
          default_context: 4096, license_name: 'MIT', license_url: 'https://example.invalid', summary: 's',
        },
        fit: {
          fit_status: 'Recommended', weight_memory_estimate: 1000, runtime_overhead_estimate: 100,
          kv_cache_estimate: 100, total_estimated_bytes: 1200, available_budget: 8000,
          context_length: Number(args.contextLength), expected_backend: 'unified_metal',
          performance_estimate: 'fast', reasons: ['ok'], source: 'test', confidence: 'high',
        },
      },
    ]);

    const { result } = renderHook(() => useMosaicRuntime());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => { result.current.setRoute('discover'); });
    await waitFor(() => expect(result.current.catalog[0]?.model.ollama_name).toBe('ctx-4096-auto_adaptive'));

    let refreshPromise!: Promise<void>;
    act(() => { refreshPromise = result.current.handleRefreshCatalog(); });
    act(() => {
      result.current.setContextLength(32768);
      result.current.setExecutionProfile('constrained_memory');
    });
    await waitFor(() => expect(result.current.catalog[0]?.model.ollama_name).toBe('ctx-32768-constrained_memory'));

    await act(async () => {
      resolveRefresh({ count: 1, source_url: 'https://example.invalid', refreshed_at: 'now' });
      await refreshPromise;
    });
    expect(result.current.catalog[0]?.model.ollama_name).toBe('ctx-32768-constrained_memory');

    const beforeSelectCalls = tauri.callsFor('list_catalog_with_fit').length;
    await act(async () => { await result.current.handleSelectVolume('VOL-SSD-2'); });
    expect(tauri.callsFor('list_catalog_with_fit').length).toBeGreaterThan(beforeSelectCalls);

    tauri.setHandler('cancel_pull', () => false);
    act(() => {
      tauri.emit('mosaic://pull-progress', {
        model: 'qwen3:30b-a3b', status: 'downloading', completed: 10, total: 100, done: false, error: null,
      });
    });
    expect(result.current.pullProgress?.done).toBe(false);
    act(() => { result.current.handleCancelPull('qwen3:30b-a3b'); });
    await waitFor(() => expect(result.current.pullProgress?.done).toBe(true));

    const opts = {
      numCtx: 4096, temperature: 0.2, executionProfile: 'auto_adaptive' as const,
      kvCacheType: 'auto' as const, numGpu: null, keepAlive: '5m',
    };
    act(() => {
      void result.current.handleSendMessage('First message', opts);
      void result.current.handleSendMessage('Second message', opts);
    });
    expect(result.current.messages).toEqual([{ role: 'user', content: 'First message' }]);
    await waitFor(() => expect(tauri.callsFor('start_chat_stream')).toHaveLength(1));

    act(() => { result.current.handleNewSession(); });
    await waitFor(() => expect(tauri.callsFor('stop_chat_stream')).toHaveLength(1));
    expect(result.current.streaming).toBe(false);
  });
});
